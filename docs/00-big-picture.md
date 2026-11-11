# Chapter 0: The big picture

> **The one idea:** quick commerce is fast because **the shop is moved next to
> you**, not because the software is fast. Every design choice after that is
> about keeping each tiny shop (a *dark store*) busy, stocked and honest, and
> keeping it from falling over at 9 pm on a rainy Friday.

---

## 1. What "10 minutes" actually means

A normal e-commerce order ships from one big
warehouse far away. That takes hours or days, and a courier company does the
last mile.

Quick commerce replaces the big warehouse with many **dark stores**. A dark
store is a small, closed-to-the-public shop of about 2,000–4,000 sq ft, placed
**inside** the neighbourhood it serves. Customers never walk in. Pickers fill
the orders, and the store's own riders deliver them.

Real-life analogy: instead of one giant library in the city centre, you put a
small bookshelf in every apartment complex. Finding a book becomes quick
because the shelf is next to you, not because the librarian got faster.

The 10 minutes are a **budget**, and every part of the system spends from it:

| Step | Budget | Who spends it | Which chapter |
|---|---|---|---|
| App open → "Delivering in 10 min" shown | < 0.2 s | serviceability | 1 |
| Browse + add to cart | (customer's time) | catalog + stock | 2 |
| Pay → order confirmed | ~ 5–20 s | checkout, payment | 3, 4 |
| Order reaches a picker | < 10 s | store ops queue | 5 |
| Pick + pack | ~ 2 min | picker | 5 |
| Find a free rider | < 30 s | dispatch | 6 |
| Ride ≤ 3 km on Bangalore roads | ~ 6–8 min | rider (we only *track* it) | 7, 8 |

Two things follow from this table:

1. **The delivery radius is short (about 3 km)** because ~7 minutes on a bike
   in Bangalore traffic covers about that much. The seed data uses exactly 3 km.
2. **Software gets only seconds out of the 10 minutes.** If checkout takes 40 s
   because the database is overloaded, the promise is already broken.

---

## 2. The whole system on one page

```
   Customer app            Rider app                 Store (picker) app
  (browse, order,     (GPS ping every 3 s,         (pick list, "packed")
   watch the map)      accept orders)
        │                     │                            │
        └─────────────────────┼────────────────────────────┘
                              ▼
                     ┌──────────────────┐
                     │  Load balancer   │  spreads requests over N copies
                     └────────┬─────────┘
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
       ┌─────────┐       ┌─────────┐       ┌─────────┐
       │ API pod │       │ API pod │  ...  │ API pod │   STATELESS: any pod can
       └────┬────┘       └────┬────┘       └────┬────┘   answer any request
            │                 │                 │
   ┌────────┴─────────────────┴─────────────────┴──────────┐
   │                                                       │
   ▼                                                       ▼
┌──────────────────────────────┐          ┌──────────────────────────────────┐
│ REDIS (hot, fast, in memory) │          │ POSTGRES + PostGIS (the truth)   │
│ • which store serves here?   │          │ • stores + their polygons        │
│   (cache)                    │          │ • catalog, inventory, orders     │
│ • live stock counters        │          │ • order history, rider trail     │
│ • where every rider is (GEO) │          │                                  │
│ • pub/sub for live updates   │          │ slower, but durable and          │
│                              │          │ queryable                        │
│ ~0.4 ms per call             │          │ ~3–30 ms per query               │
└──────────────┬───────────────┘          └─────────────────▲────────────────┘
               │ queues (BullMQ)                            │
               ▼                                            │
          ┌──────────┐  "after order placed: notify store, ─┘
          │ Workers  │   find rider, save GPS trail in bulk..."
          └──────────┘
```

This is a common production split: API pods, queue-worker pods and a cron
pod all run the same code image, each started with a different role.

### The journey of one order (and the chapter that builds each step)

1. App opens and sends lat/lng. *"Which dark store covers me, and how fast
   can it deliver?"* → **Ch 1 Serviceability**
2. The home screen shows **only what that store has right now** → **Ch 2
   Catalog + stock**
3. Add to cart, then pay. The items are **held for you** so nobody else buys
   the last strip → **Ch 3 Reservation** (the hardest one)
4. Payment succeeds (or the gateway calls us twice, or late) → the order is
   created **exactly once** → **Ch 4 Checkout + state machine**
5. The order lands on the store's screen and the picker packs it, taking the
   earliest-expiry batch first → **Ch 5 Store ops**
6. The nearest free rider is picked, and **never two orders for one rider by
   mistake** → **Ch 6 Dispatch**
7. The rider's dot moves on your map in real time → **Ch 7 Live tracking**
8. "Arriving in 3 min" keeps updating → **Ch 8 ETA**
9. All of it under peak load → **Ch 9 Scale capstone**

---

## 3. The second big idea: everything is local to one store

Look at the journey again. A customer in Koramangala only ever touches:

- the Koramangala store's stock,
- the Koramangala store's pickers,
- the Koramangala store's riders.

**Nothing** in an order needs data from the Whitefield store.

This one fact is what makes quick commerce scalable. In system-design language,
`store_id` is the natural **sharding key**.

> **Sharding, simply:** instead of one giant pile of work that everyone fights
> over, cut it into independent piles that never need each other. Bangalore
> with 8 stores is 8 small businesses that happen to share an app.

You'll see `store_id` show up at the front of everything:

- `store_inventory` has `PRIMARY KEY (store_id, sku_id)`, store first, because
  every query is "for this store".
- Redis keys will look like `stock:{storeId}` and `riders:free:{storeId}`.
- Store ops queues will be one per store (chapter 5).

**Later:** when one Postgres can't keep up, you can move stores 1–4 to
database A and stores 5–8 to database B, and no query breaks. That works only
because you were disciplined from day one. The day one store's data leaks
into another store's flow, that option is gone.

**Many order systems already do a version of this.** They shard
order-processing queues by `warehouseId % N`, so warehouses don't block each
other.

---

## 4. Hot data vs. cold data: where things live

| Data | Changes how often | Read how often | Lives in | Why |
|---|---|---|---|---|
| Store polygons | weekly (ops redraws) | every app open | Postgres (truth) **+ Redis cache** | read 1,000,000× per change |
| Catalog (names, MRP, images) | daily | every screen | Postgres + long cache / CDN | same for every user |
| Stock per store | every second | every screen | **Redis counters** + Postgres | hot and changing; Ch 2–3 |
| Orders, payments | per order | per order | **Postgres** | must never be lost |
| Rider "where am I right now" | every 3 s | constantly | **Redis only** | Postgres would drown; Ch 7 |
| Rider trail history | every 3 s | rarely (disputes) | Postgres, **written in batches** | durable but not urgent |

Rule of thumb: **Postgres is the notebook you trust. Redis is the whiteboard
everyone glances at.** The whiteboard can be wiped and rebuilt from the
notebook. The notebook must never be wrong.

---

## 5. How big is "very large scale" for Bangalore? Back-of-envelope

These are **assumptions, not real data**. Swap in real numbers
when you have them. The method matters more than the numbers.

| | New single-city launch, year 1 (guess) | A Blinkit-sized city (guess) |
|---|---|---|
| Orders per day | 5,000 | 500,000 |
| Peak hour = ~12% of the day | 600 orders/hr | 60,000 orders/hr |
| **Orders per second at peak** | **0.17** | **~17** |
| App sessions per order (≈10% convert) | 10 | 10 |
| API calls per session (home, search, cart…) | 30 | 30 |
| **API requests per second at peak** | **~50** | **~5,000** |
| Riders on the road at peak (~2.5 orders/rider/hr) | 240 | 24,000 |
| **GPS pings per second (1 per 3 s)** | **~80** | **~8,000** |

Read the bold rows. Three surprises:

1. **Orders are not the scale problem.** Even a giant city places about 17
   orders per second. The **browsing** traffic around them is ~300× bigger.
   That's why chapters 1–2 are about caching reads.
2. **GPS pings are the biggest *write* stream in the whole system.** At large
   scale it's ~8,000 writes/sec just to say "I'm here now". That's why
   chapter 7 keeps them in Redis and writes them to Postgres in batches.
3. **Spikes matter more than averages.** Rain, a cricket final or a fever
   season can multiply traffic 5–10× in minutes. Design for the spike.

### Compare with what your laptop measured

`npm run load -- /load/00-smoke.js`: 50 users, 20 s, **one** Node process
(Apple-silicon laptop, k6 in Docker on the same machine):

| Endpoint | What it does | Requests/sec | p95 latency |
|---|---|---|---|
| `GET /health/ping` | nothing (pure Node + HTTP) | **~34,000** | 2.3 ms |
| `GET /health` | 1 Postgres + 1 Redis round trip | **~12,700** | 6.2 ms |
| `GET /stores` | a real query (8 polygons → GeoJSON + 2 counts) | **~3,900** | 21.9 ms |

What to learn from it:

- **One laptop process could serve a year-1 single-city launch** (50 req/s). Raw
  speed isn't why we design carefully. We do it for **correctness** (never
  sell the last strip twice, never create an order twice) and for **spikes**,
  and so the design can grow 100× without a rewrite.
- **Every database trip costs real throughput.** Adding one Postgres and one
  Redis call cut capacity by ~2.7×. A real query cut it by ~9×. That's the
  whole argument for caching in chapter 1: "which store serves me?" is asked on
  every app open, and its answer changes maybe once a week.
- **p95 is the number users feel.** The average hides the slow tail. Always
  read p95/p99.

### The Postgres connection trap

Every API pod keeps a pool of database connections (`DB_POOL_MAX`, default 20
here). 30 pods × 20 = 600 connections, and
Postgres starts suffering past a few hundred. So "just add more pods"
eventually **hurts** the database. The fix is to keep hot reads out of Postgres,
which is exactly what Redis is for.

---

## 6. Normal e-commerce vs quick commerce

| Idea | Typical pincode-based e-commerce backend | Quick commerce |
|---|---|---|
| Fulfilment node | a few large warehouses | many small dark stores |
| "Which node serves me?" | pincode → warehouse priority list, cached for hours | lat/lng → store polygon (chapter 1) |
| Delivery promise | a date: same day / next day, courier cutoffs | minutes (chapters 1, 8) |
| Stock | often synced from an ERP on a schedule, so it lags | exact, updated in the same flow as every pick (chapters 2, 3) |
| Last mile | third-party couriers push status by webhook | own riders with live GPS (chapters 6, 7) |
| Geo (polygons, nearest rider, distance) | usually not needed | central |

The biggest mental shift: **pincode → polygon**. A Bangalore pincode
like 560034 covers a few km² with very uneven roads. At 10 minutes, "same
pincode" is not precise enough. One side of a pincode might be 4 minutes
from the store, the other side 15 minutes across a flyover. So quick commerce
works on **lat/lng and polygons** instead.

---

## 7. Pharmacy-specific notes (to explore in later chapters)

Groceries don't have these constraints. Medicines do:

- **Prescription (Rx) items.** A pharmacist must verify the prescription
  before dispatch. That time comes out of the 10-minute budget, so expect
  either "Rx orders take ~30 min" or "pre-verified prescriptions only" for
  fast delivery. `skus.rx_required` exists for this (Ch 4).
- **Each dark store is a pharmacy.** In India, a retail pharmacy needs a drug
  licence and a registered pharmacist. That makes each store more expensive to
  open, so there are fewer stores and possibly larger polygons than Blinkit has.
- **Cold chain.** Insulin and some vaccines must stay at 2–8 °C. They need a
  fridge in the store and possibly an insulated bag for the rider
  (`skus.cold_chain`).
- **Batches and expiry.** Every strip has a batch number and an expiry date.
  Pickers should take **first-expiry-first-out (FEFO)** (Ch 5). This is the same
  batch/expiry data a pharmacy records when stock is received (the GRN).

---

## Glossary (plain words)

| Word | Meaning |
|---|---|
| Dark store | Small warehouse inside a neighbourhood; no walk-in customers |
| Serviceable | "We can deliver to this exact location right now" |
| Polygon | A shape on the map; the store delivers to everything inside it |
| PostGIS | Postgres add-on that understands maps (points, shapes, distances) |
| Stateless pod | A server copy that keeps nothing in its own memory, so any copy can answer any request |
| Sharding key | The field you split work by so the pieces never need each other (`store_id`) |
| p95 latency | 95% of requests were at least this fast; the slowest 5% were slower |
| Throughput | Requests handled per second |
| Hot path | Code that runs on (almost) every request; keep it tiny |

---

## Run it yourself

```bash
npm run db:up           # Postgres+PostGIS on :5434, Redis on :6381
npm run db:reset        # create tables + seed Bangalore
npm run build && npm run start:prod      # API on :4000
open http://localhost:4000/ops.html      # see the city; click around
npm run test:e2e                         # the facts in this chapter, as tests
npm run load -- /load/00-smoke.js        # your own baseline numbers
```

On the map, try clicking **MG Road** (just west of Indiranagar). It's
not serviceable, and chapter 1 is about what to do with that.
