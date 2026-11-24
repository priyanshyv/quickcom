# quickcom

A hands-on sandbox for learning how **10-minute delivery** (Blinkit-style
quick commerce) works, and how it holds up at very large scale. It is set in
Bangalore, with pharmacy-specific notes along the way.

It is built **one system-design idea per chapter**. Each chapter follows the
same pattern:

1. **The one idea**, in one sentence, plus a real-life analogy.
2. **The wrong version.** It gets built and load-tested so you can watch it break.
3. **The right version**, and why it works.
4. **What changes at large scale**, with back-of-envelope numbers for Bangalore.
5. **How a typical (pincode-based) e-commerce backend does it**, for contrast.
6. **Takeaways if you build this for real.**

Nothing here is mocked (except the payment gateway, which is a local stand-in
that misbehaves on purpose). Every number in `docs/` came from running the code
against a real Postgres and Redis on a laptop (Apple silicon, k6 in Docker on
the same machine), so treat them as relative, not absolute. Each chapter ends
with **References** that separate what we *measured*, what a public source
*documents*, and what is our own *assumption*.

## Quick start

```bash
npm install
npm run db:up                         # Postgres+PostGIS :5434, Redis :6381
npm run db:reset                      # tables + Bangalore seed data
npm run build && npm run start:prod   # API on :4000
open http://localhost:4000/customer.html   # the customer app (top bar links every page)
npm run test:e2e                           # every chapter's claims, as tests
```

> **Docker not running?** `Cannot connect to the Docker daemon` means Docker
> Desktop is closed. Start it, wait ~15 s, then try again.

The ports are deliberately not the defaults, so they don't clash with other
local Postgres/Redis containers.

## Chapters

| # | Chapter | Status |
|---|---|---|
| 0 | [The big picture](docs/00-big-picture.md): dark stores, the 10-minute budget, `store_id` as the sharding key, BLR numbers | ✅ |
| 1 | [Serviceability](docs/01-serviceability.md): "can you deliver here, from which store?" (PostGIS, geohash cache, edge cells, version-bump invalidation) | ✅ |
| 2 | [Catalog + per-store stock](docs/02-catalog-and-stock.md): read path vs write path, in-memory catalog + ETag/CDN, Redis stock hash, drift repair, split API | ✅ |
| 3 | [Cart + overselling](docs/03-cart-and-overselling.md): lost updates, conditional UPDATE, Redis Lua gate, hold expiry with `SKIP LOCKED` | ✅ |
| 4 | [Checkout + payments](docs/04-checkout-and-payments.md): Idempotency-Key, state machine, signed webhooks + inbox, reconciler, outbox + partitions, Rx review | ✅ |
| 5 | Store ops: pick and pack, FEFO, store capacity | next |
| 6 | Rider dispatch: nearest free rider, no double-assignment | |
| 7 | Live rider tracking: GPS pings → Redis → SSE across pods | |
| 8 | ETA: "arriving in 4 min" | |
| 9 | Scale capstone | |

## Scripts

| Script | What it does |
|---|---|
| `npm run db:up` / `db:down` | start / stop Postgres + Redis containers |
| `npm run db:reset` | run migrations + reseed (safe to repeat) |
| `npm run db:psql` | psql shell inside the container |
| `npm run redis:cli` | redis-cli inside the container |
| `npm run start:api` | API with watch mode (for coding) |
| `npm run start:worker` | background jobs only (outbox relay, queue consumer, sweepers); no HTTP |
| `npm run build && npm run start:prod` | compiled API (use this for load tests) |
| `npm run test:e2e` | e2e tests against real Postgres + Redis |
| `npm run load -- /load/<file>.js` | k6 load test (runs in Docker, no install needed) |

## Endpoints so far

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health/ping` | does nothing; your laptop's speed ceiling |
| `GET` | `/health` | Postgres (PostGIS) + Redis round trip |
| `GET` | `/stores` | all stores + delivery polygons as GeoJSON |
| `GET` | `/ops.html` | Leaflet map of the city; click to check serviceability |
| `GET` | `/serviceability?lat&lng` | which store serves this point (cached) · also `/naive`, `/postgis`, `/stats` |
| `PATCH` | `/admin/stores/:id/active` | turn a store on/off (bumps the cache version) |
| `GET` | `/customer.html` | customer app: click the map to "open the app", ADD to cart, see every API call it makes |
| `GET` | `/catalog` | full catalog, with ETag + Cache-Control (CDN-friendly) |
| `GET` | `/stores/:id/stock` | stock badges for one store (from Redis) |
| `POST` | `/admin/stores/:id/stock` | set on-hand for a SKU (Postgres first, then Redis) |
| `POST` | `/admin/stock/rebuild` | rebuild every Redis stock hash from Postgres |
| `GET` | `/home?lat&lng` | home screen: store + catalog + stock (also `/home/naive`) |
| `PUT` | `/carts/:cartId/items` | set a cart line's qty = hold stock (Redis gate + Postgres) · also `/pg`, `/naive` |
| `GET` | `/carts/:cartId` | the cart: lines, total, when holds expire |
| `DELETE` | `/carts/:cartId` | empty the cart (gives the stock back) |
| `POST` | `/admin/holds/sweep` | release expired holds now (also runs every 5 s in every pod) · `GET /admin/holds/stats` |
| `GET` | `/flash-sale.html` | lab page: 200 buyers vs 10 units, three ways |
| `POST` | `/admin/lab/flash-sale` | the lab run (also `/arm` and `/finish`, used by k6) |
| `POST` | `/orders` | checkout (header `Idempotency-Key`); `GET /orders/:id`, `GET /orders?customer=` |
| `POST` | `/orders/:id/payments` | open (or reuse) a payment attempt · `POST /orders/:id/cancel` |
| `POST` | `/mock-gateway/payments/:ref/complete` | the pretend UPI app: approve / decline, with webhook chaos |
| `POST` | `/webhooks/payment` | gateway webhook (signed, deduped) · `/naive` for comparison |
| `GET` | `/admin/rx-queue` | pharmacist queue · `POST /admin/orders/:id/rx {approve, note}` |
| `POST` | `/admin/orders/sweep` | reconcile + payment timeouts now (also every 5 s in workers) |
| `GET` | `/admin/outbox/stats` | outbox backlog + queue counts · `POST /admin/outbox/relay` |
| `POST` | `/admin/lab/payments` | payments chaos lab run `{scenario, handler}` |
| `GET` | `/order.html`, `/pharmacist.html`, `/payments-lab.html` | order tracking, Rx review, payments chaos lab |

## Layout

```
src/config/credentials.ts   the only file that reads env vars
src/logging/                TraceCodes + JSON logger
src/redis/                  shared ioredis client
src/db/                     data source + SQL migrations
src/<feature>/              one folder per feature (stores, serviceability, catalog, inventory, home, cart, orders, payments, outbox, …)
db/seed/seed.ts             Bangalore: 8 stores, 146 SKUs, 61 riders
public/                     demo pages (Leaflet maps)
load/                       k6 scripts, one per chapter
test/                       e2e specs, one per chapter
docs/                       the chapters
```
