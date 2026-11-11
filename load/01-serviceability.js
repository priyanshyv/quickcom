// Chapter 1: "which store serves me?" three ways.
//
//   npm run load -- -e MODE=naive   /load/01-serviceability.js
//   npm run load -- -e MODE=postgis /load/01-serviceability.js
//   npm run load -- -e MODE=cached  /load/01-serviceability.js
//
// 50 users, 20 s, picking from 5,000 fixed points spread over Bangalore
// (fixed, because real users open the app from the same homes again and again —
// that repetition is what makes a cache worth having).
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:4000';
const MODE = __ENV.MODE || 'cached';
const PATH = { naive: '/serviceability/naive', postgis: '/serviceability/postgis', cached: '/serviceability' }[MODE];

export const options = {
  vus: 50,
  duration: '20s',
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

// Same 5,000 points every run (simple seeded random), across a box that
// covers all 8 stores plus the gaps between them.
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const POINTS = Array.from({ length: 5000 }, () => [12.82 + rand() * 0.24, 77.54 + rand() * 0.24]);

export function setup() {
  return JSON.parse(http.get(`${BASE}/serviceability/stats`).body);
}

export default function () {
  const [lat, lng] = POINTS[Math.floor(Math.random() * POINTS.length)];
  const res = http.get(`${BASE}${PATH}?lat=${lat.toFixed(6)}&lng=${lng.toFixed(6)}`);
  check(res, { 'status 200': (r) => r.status === 200 });
}

export function teardown(before) {
  const after = JSON.parse(http.get(`${BASE}/serviceability/stats`).body);
  const d = (k) => after[k] - before[k];
  const cached = d('hit') + d('miss');
  console.log(
    `MODE=${MODE} cache hits=${d('hit')} misses=${d('miss')} edge-fallbacks=${d('edge')}` +
      (cached ? ` hitRate=${((100 * d('hit')) / cached).toFixed(1)}% edgeRate=${((100 * d('edge')) / cached).toFixed(1)}%` : ''),
  );
}
