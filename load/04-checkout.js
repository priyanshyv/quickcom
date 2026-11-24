// Chapter 4: checkout + payments under load.
//
//   SCENARIO=journey  50 users for 20 s, each iteration a brand-new customer:
//                     add to cart -> place order -> pay -> gateway webhook -> confirmed.
//                     Q: orders per second end to end, and how long until the SMS?
//   SCENARIO=storm    ONE paid order; 50 users fire the SAME signed "captured"
//                     webhook at it for 10 s (a gateway retry storm).
//                     MODE=right | naive.  Q: how many times does the order get confirmed?
//
//   npm run load -- -e SCENARIO=journey /load/04-checkout.js
//   npm run load -- -e SCENARIO=storm -e MODE=naive /load/04-checkout.js
import http from 'k6/http';
import crypto from 'k6/crypto';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:4000';
const SCENARIO = __ENV.SCENARIO || 'journey';
const MODE = __ENV.MODE || 'right';
const SECRET = __ENV.WEBHOOK_SECRET || 'dev-only-webhook-secret';
const J = { headers: { 'content-type': 'application/json' } };

export const options = {
  scenarios: {
    [SCENARIO]: SCENARIO === 'storm'
      ? { executor: 'constant-vus', vus: 50, duration: '10s' }
      : { executor: 'constant-vus', vus: 50, duration: '20s' },
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
  setupTimeout: '60s',
  teardownTimeout: '120s',
};

const ordersPlaced = new Counter('orders_placed');
const journeyFailed = new Counter('journey_failed');

export function setup() {
  if (SCENARIO === 'storm') {
    const p = http.post(`${BASE}/admin/lab/payments/prepare`, '{}', J).json();
    // The money really is taken at the gateway, but its own webhook is "lost":
    // only our storm will deliver the news.
    http.post(`${BASE}/mock-gateway/payments/${p.paymentRef}/complete`, JSON.stringify({ outcome: 'success', chaos: 'lost' }), J);
    const body = JSON.stringify({
      id: 'evt_storm_' + p.arm.runId,
      type: 'payment.captured',
      created: Date.now(),
      data: { paymentRef: p.paymentRef, orderId: p.orderId, amountPaise: p.totalPaise },
    });
    return { ...p, body, sig: crypto.hmac('sha256', SECRET, body, 'hex') };
  }
  const arm = http.post(`${BASE}/admin/lab/flash-sale/arm`, JSON.stringify({ storeId: 1, skus: 100, units: 1000000 }), J).json();
  return { arm };
}

export default function (d) {
  if (SCENARIO === 'storm') {
    const url = `${BASE}/webhooks/payment${MODE === 'naive' ? '/naive' : ''}`;
    const res = http.post(url, d.body, { headers: { 'content-type': 'application/json', 'x-mock-signature': d.sig } });
    check(res, { '200': (r) => r.status === 200 });
    return;
  }

  // One full customer journey.
  const cart = `lab-${d.arm.runId}-${__VU}-${__ITER}`;
  const skuId = d.arm.skuIds[Math.floor(Math.random() * d.arm.skuIds.length)];
  const add = http.put(`${BASE}/carts/${cart}/items`, JSON.stringify({ storeId: 1, skuId, qty: 1 }), J);
  const place = http.post(`${BASE}/orders`, JSON.stringify({ cartId: cart }), {
    headers: { 'content-type': 'application/json', 'idempotency-key': `${cart}-k` },
  });
  if (add.status !== 200 || place.status !== 201) return journeyFailed.add(1);
  ordersPlaced.add(1);
  const orderId = place.json('order.id');
  const pay = http.post(`${BASE}/orders/${orderId}/payments`, null);
  const done = http.post(`${BASE}/mock-gateway/payments/${pay.json('paymentRef')}/complete`, JSON.stringify({ outcome: 'success' }), J);
  if (!check(done, { 'paid': (r) => r.status === 200 })) journeyFailed.add(1);
}

export function teardown(d) {
  if (SCENARIO === 'storm') {
    const r = http.post(`${BASE}/admin/lab/payments/finish`, JSON.stringify({ arm: d.arm, orderId: d.orderId }), J).json();
    const confirmations = r.timeline.filter((t) => t.to === 'CONFIRMED').length;
    console.log(`\n=== storm / ${MODE}: order ${r.order.status}, confirmed ${confirmations}x, SMS sent ${r.sms.length}`);
    console.log(`    problems: ${r.problems.length ? r.problems.join(' | ') : 'none'}`);
    return;
  }
  const s = http.get(`${BASE}/admin/lab/orders-summary?prefix=lab-${d.arm.runId}`, { timeout: '120s' }).json();
  console.log(`\n=== journey: ${JSON.stringify(s.byStatus)}  SMS ${s.sms}  event->SMS avg ${s.eventToSmsMs.avg} ms p95 ${s.eventToSmsMs.p95} ms`);
  http.post(`${BASE}/admin/lab/orders-cleanup`, JSON.stringify({ arm: d.arm }), J);
}
