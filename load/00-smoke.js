// Phase 0 baseline: how fast can this laptop answer ANY request?
//
//   npm run load -- /load/00-smoke.js                       # /health/ping (no I/O)
//   npm run load -- -e TARGET=health /load/00-smoke.js      # /health (1 Postgres + 1 Redis call)
//   npm run load -- -e TARGET=stores /load/00-smoke.js      # /stores (a real query: polygons + counts)
//
// 50 virtual users hammer the endpoint as fast as they can for 20 s.
// Read "http_reqs ... /s" (throughput) and "p(95)" (latency the slowest 5% see).
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:4000';
const PATHS = { ping: '/health/ping', health: '/health', stores: '/stores' };
const PATH = PATHS[__ENV.TARGET || 'ping'];

export const options = {
  vus: 50,
  duration: '20s',
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const res = http.get(`${BASE}${PATH}`);
  check(res, { 'status 200': (r) => r.status === 200 });
}
