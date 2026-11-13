// Chapter 3: add-to-cart under pressure, three ways.
//
//   MODE     = naive | pg | redis        (which PUT /carts/:id/items route)
//   SCENARIO = contest | soldout | hot | spread
//
//   contest  200 buyers, 1 tap each, 10 units on sale.   Q: does anyone oversell?
//   soldout  50 users hammer an item with only 10 units for 20 s.
//            Q: after it sells out, what does each refusal cost?
//   hot      50 users, 20 s, ONE item with endless stock. Q: how fast can one row go?
//   spread   same, but spread over 100 items.              Q: is the hot row the limit?
//
//   npm run load -- -e MODE=naive -e SCENARIO=contest /load/03-flash-sale.js
//
// setup() arms the lab (exact stock), teardown() counts what happened and puts
// the stock back. Each request is a brand-new cart, like a new customer.
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:4000';
const MODE = __ENV.MODE || 'redis';
const SCENARIO = __ENV.SCENARIO || 'contest';
const SUFFIX = MODE === 'redis' ? '' : `/${MODE}`;
const JSON_HDR = { headers: { 'content-type': 'application/json' } };

const SETUPS = {
  contest: { skus: 1, units: 10, exec: { executor: 'per-vu-iterations', vus: 200, iterations: 1 } },
  soldout: { skus: 1, units: 10, exec: { executor: 'constant-vus', vus: 50, duration: '20s' } },
  hot: { skus: 1, units: 10000000, exec: { executor: 'constant-vus', vus: 50, duration: '20s' } },
  spread: { skus: 100, units: 10000000, exec: { executor: 'constant-vus', vus: 50, duration: '20s' } },
};
const S = SETUPS[SCENARIO];

export const options = {
  scenarios: { [SCENARIO]: S.exec },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
  setupTimeout: '60s',
  teardownTimeout: '120s',
};

const accepted = new Counter('accepted_200');
const refused = new Counter('refused_409');
const failed = new Counter('failed_other');

export function setup() {
  const res = http.post(`${BASE}/admin/lab/flash-sale/arm`, JSON.stringify({ storeId: 1, skus: S.skus, units: S.units }), JSON_HDR);
  if (res.status !== 201) throw new Error(`arm failed: ${res.status} ${res.body}`);
  return { arm: res.json(), before: http.get(`${BASE}/admin/holds/stats`).json() };
}

export default function ({ arm }) {
  const skuId = arm.skuIds[Math.floor(Math.random() * arm.skuIds.length)];
  const cart = `lab-${arm.runId}-${__VU}-${__ITER}`;
  const res = http.put(`${BASE}/carts/${cart}/items${SUFFIX}`, JSON.stringify({ storeId: arm.storeId, skuId, qty: 1 }), JSON_HDR);
  if (res.status === 200) accepted.add(1);
  else if (res.status === 409) refused.add(1);
  else failed.add(1);
  check(res, { '200 or 409': (r) => r.status === 200 || r.status === 409 });
}

export function teardown({ arm, before }) {
  const after = http.get(`${BASE}/admin/holds/stats`).json();
  const d = (k) => after[k] - before[k];
  const res = http.post(`${BASE}/admin/lab/flash-sale/finish`, JSON.stringify(arm), JSON_HDR);
  const r = res.json();
  console.log(`\n=== ${MODE} / ${SCENARIO}: on sale ${r.unitsOnSale}, sold ${r.sold}, OVERSOLD ${r.oversold}, lost updates ${r.lostUpdates}`);
  console.log(`    hot-row writes ${d('hotRowWrites')}, refused by Redis gate ${d('refusedByRedisGate')}, other refusals (after reading Postgres) ${d('refused') - d('refusedByRedisGate')}`);
  console.log(JSON.stringify(r.perSku[0]));
}
