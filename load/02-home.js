// Chapter 2: the home screen, two ways.
//
//   npm run load -- -e MODE=naive  /load/02-home.js   # 2 Postgres queries per request
//   npm run load -- -e MODE=cached /load/02-home.js   # 0 Postgres queries (Redis + memory)
//   npm run load -- -e MODE=stock  /load/02-home.js   # just GET /stores/:id/stock (the split API)
//
// Points are scattered within ~2 km of a store (where customers actually are).
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:4000';
const MODE = __ENV.MODE || 'cached';

export const options = {
  vus: 50,
  duration: '20s',
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

const STORES = [
  [12.9352, 77.6245], [12.9719, 77.6412], [12.9116, 77.6474], [12.9698, 77.75],
  [12.9299, 77.5826], [13.0035, 77.5709], [13.0358, 77.597], [12.8452, 77.6602],
];
let seed = 11;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const POINTS = Array.from({ length: 5000 }, () => {
  const [lat, lng] = STORES[Math.floor(rand() * STORES.length)];
  return [lat + (rand() - 0.5) * 0.036, lng + (rand() - 0.5) * 0.036]; // ±2 km box
});

export default function () {
  if (MODE === 'stock') {
    const storeId = 1 + Math.floor(Math.random() * 8);
    check(http.get(`${BASE}/stores/${storeId}/stock`), { 'status 200': (r) => r.status === 200 });
    return;
  }
  const [lat, lng] = POINTS[Math.floor(Math.random() * POINTS.length)];
  const path = MODE === 'naive' ? '/home/naive' : '/home';
  const res = http.get(`${BASE}${path}?lat=${lat.toFixed(6)}&lng=${lng.toFixed(6)}`);
  check(res, { 'status 200': (r) => r.status === 200 });
}
