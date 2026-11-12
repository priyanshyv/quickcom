# Chapter 2: The home screen, catalog + live stock per store

> **The one idea:** split your data by **who it's the same for** and **how
> often it changes**, and store each part where that combination is cheapest.
> The catalog is the same for everyone and changes daily. Stock is different
> for every store and changes every second. Never fetch them together from the
> same place.

Analogy: a restaurant **prints its menu once** (dishes, prices) and hands the
same copy to every table. But "sorry, the fish is finished" is written on a
**small whiteboard** at the counter and updated all evening. Nobody reprints
the menu because the fish ran out.

- Menu = catalog
- Whiteboard = stock

---

## 1. What the home screen needs

```
GET /home?lat=12.9346&lng=77.6113

{
  "location": { "serviceable": true, "store": {"code":"BLR-KOR", ...}, "promiseMinutes": 12, "via": "cache-hit" },
  "sections": [
    { "category": "Antibiotics", "items": [
        { "id":123, "name":"Amoxicillin 500mg Capsule", "packSize":"Strip of 10",
          "mrpPaise":8500, "rxRequired":true, "stock":"in" }, ...
    ]},
    { "category": "Cold & Cough", "items": [ ... "stock":"low:3" ..., ... "stock":"out" ... ] }
  ]
}
```

Three ingredients, each with a different personality:

| Ingredient | Same for… | Changes… | Size | Where it lives (right version) |
|---|---|---|---|---|
| Which store serves me | everyone in a 153 m box | weekly | tiny | Redis, by geohash (chapter 1) |
| **Catalog**: name, pack, MRP, Rx flag | **everyone in India** | a few times a day | 23 KB (146 SKUs) | **each pod's own memory** + ETag + CDN |
| **Stock**: in / low / out | **one store** | **every second** | 1.3 KB per store | **Redis hash `stock:{storeId}`** |

---

## 2. ❌ The wrong version: everything from Postgres, every time

`GET /home/naive` · `src/home/home.service.ts` → `homeNaive`

```
every app open:
  1. PostGIS query   → which store?
  2. JOIN skus × store_inventory WHERE store_id = ?   → ~120 rows
```

It's simple and correct. It's also exactly what most first versions look like.
The cost: **~2 Postgres queries per app open**, returning the same answer as
the previous thousand app opens. Postgres is being used as a cache, which is
the most expensive way to run a cache.

---

## 3. ✅ The right version: zero Postgres on the normal path

`GET /home` → `home`

```
1. Redis GET  svc:v…:{cell}   → which store (chapter 1)
2. memory                      → catalog (already in this pod's RAM)
3. Redis HGETALL stock:{id}   → { skuId: available, ... } for that store
4. merge + group + badge       → JSON
```

### The catalog lives in the pod's own memory (`src/catalog/catalog.service.ts`)

The catalog is small (even 20,000 SKUs is a few MB) and identical for everyone,
so the cheapest possible cache is plain memory in each pod: **no network hop
at all**. Each pod reloads it from Postgres every 60 s. That's 1 query per pod
per minute, instead of 1 per request.

It also gets an **ETag**, a fingerprint of the contents, plus `Cache-Control`
headers:

```bash
$ curl -i localhost:4000/catalog
HTTP/1.1 200 OK
ETag: "fa23111aafac4302"
Cache-Control: public, max-age=300, stale-while-revalidate=60
Content-Length: 23322

$ curl -i -H 'If-None-Match: "fa23111aafac4302"' localhost:4000/catalog
HTTP/1.1 304 Not Modified          <- zero bytes of body
```

What those headers buy at scale:

- `public, max-age=300` lets a **CDN** (CloudFront, Akamai) answer `GET
  /catalog` for 5 minutes **without ever reaching your servers**. One request
  per CDN edge location per 5 minutes reaches you, instead of one per app open.
- `ETag` + `If-None-Match`: when the app already has the catalog, it asks
  "still `fa23…`?" and gets a 304 with no body. That saves mobile data on Indian
  networks too.
- `stale-while-revalidate=60`: for one minute after expiry, the CDN keeps
  serving the old copy while it fetches a new one in the background, so nobody
  waits.

### Stock lives in a Redis hash per store (`src/inventory/stock-cache.service.ts`)

```
stock:1   →   { "1": "34", "2": "12", "4": "5", "7": "0", ... }      (skuId → available)
stock:2   →   { ... }
```

One `HGETALL` (~0.5 ms) returns a whole store's stock. `store_id` is **in the
key**, which is the chapter 0 sharding idea in a Redis key name: Koramangala's
stock never mixes with Whitefield's.

### The write path: keeping the copy honest

Redis is a **copy**. Postgres is the **truth**. When stock changes (a delivery
arrives, or someone counts a shelf):

```
POST /admin/stores/1/stock  {"skuId": 7, "onHand": 40}

1. Postgres:  INSERT ... ON CONFLICT DO UPDATE ... RETURNING on_hand - reserved   ← the truth
2. Redis:     HSET stock:1 7 <the value Postgres just returned>                   ← the copy
```

**Why this order?** If step 2 fails, Redis is stale but Postgres is right, and
a rebuild fixes it. The opposite order can leave Redis advertising stock that
was never recorded anywhere real.

**Why use the value Postgres returned, not the value the request sent?**
`RETURNING` gives you "available = on_hand − reserved" computed **inside**
Postgres at that instant. Computing it yourself in Node would use a `reserved`
number that may already be out of date. That's the first taste of chapter 3's
problem.

**Copies drift. Always have a rebuild.** A Redis restart, a failed write or a
bug can all make the copy wrong. So there's:

- **on boot:** any store whose hash is missing gets rebuilt from Postgres;
- `POST /admin/stock/rebuild`: replace every hash from Postgres, atomically
  (`MULTI` → `DEL` + `HSET`, so readers never see a half-built hash).

Every real inventory system ends up with the same thing: reconciliation jobs
that compare the copy against the source of truth and repair it. Any time you
keep a copy, plan the repair job **on day one**.

### Never send the exact quantity

The app gets `"in"`, `"low:3"` or `"out"`, never `"available": 34`:

- **Competitors scrape exact quantities** to work out your sales per SKU per
  store.
- The number is **stale by the time it renders**; stock moves every second.
- "Only 3 left" is useful product copy. "34 left" tells the customer nothing.

The e2e test asserts no `available` field ever leaves the server.

---

## 4. The numbers (measured on this laptop)

`npm run load -- -e MODE=<mode> /load/02-home.js`: 50 users, 20 s, points
within ~2 km of a store.

| Version | Requests/sec | p95 | **PG/request** | Response size |
|---|---|---|---|---|
| ❌ naive: `/home/naive` | ~2,100–2,500 | 32–43 ms | **1.93** | 14.8 KB |
| ✅ cached: `/home` | ~4,400–4,600 | 16–19 ms | **0.06–0.10** | 14.8 KB |
| ✅✅ split: `/stores/:id/stock` only | **~8,600** | **9.6 ms** | **~0** | **1.3 KB** |

(The remaining 0.06–0.10 PG/request in the cached version comes from chapter
1's edge-cell fallbacks plus first-time cache misses.)

### The surprising lesson in row 2

Removing Postgres made the home screen about **2× faster**, not 10×. Why?
Once the database is out of the way, **the new bottleneck is building and
sending a 15 KB JSON** on every request. The cached run was pushing
**~65 MB/s** of JSON. This is how performance work goes: you remove the biggest
bottleneck, and the next one becomes visible.

That's why row 3 exists. Real apps **split the home screen into two calls**:

```
GET /catalog                  23 KB, same for everyone  → served by the CDN, rarely by you
GET /stores/1/stock            1.3 KB, per store        → the only part your servers build
```

The app merges them on the phone. Your servers now build a **1.3 KB** response
instead of 15 KB. That's ~2× the throughput again and **11× less data per app
open**, and the 23 KB part is served by the CDN without touching you at all.

### Scale check (chapter 0's Blinkit-sized city: ~5,000 req/s at peak)

| | Naive | Split API |
|---|---|---|
| Postgres queries/sec from home screens | **~9,650** (5,000 × 1.93) | **~0** |
| Pods needed at the laptop rate (very rough) | ~2–3, all hammering one Postgres | ~1, and Postgres idle |

---

## 5. Things the real thing also has (not built here, on purpose)

- **Pagination and personalisation.** Real home screens are widgets ("Buy
  again", "Fever kit", banners), each paged. Same idea: the per-user bits are
  small and computed; the shared bits are cached.
- **Search.** A separate system (OpenSearch / Elasticsearch) fed from the
  catalog, with availability filtered per store. Same split: the index is
  shared, the stock filter is per store.
- **Images.** Never served by your API; always object storage + CDN.

---

## 6. Compared with a typical warehouse e-commerce backend

| | Typical warehouse e-commerce backend | QuickCom |
|---|---|---|
| "Is it in stock" | a visibility flag per warehouse, plus a stock number synced from an ERP by a cron, so it **lags** | `on_hand − reserved` in Postgres, copied to Redis on every write |
| Source of truth | often an external ERP / inventory system | Postgres `store_inventory` |
| Caching | long-lived (hours) DB-row caches | in-memory catalog + Redis stock hash |
| Drift repair | reconciliation crons between the systems | boot rebuild + `POST /admin/stock/rebuild` |

The big difference for 10-minute delivery: a warehouse backend can tolerate
stock that is a few minutes stale, because orders ship later and can be
backordered. **A 10-minute store can't.** If the home screen says "in stock"
but the shelf is empty, the picker is standing at an empty shelf with the clock
running. So the store's stock number has to be updated in the **same flow** as
every pick, sale and delivery, not by a cron.

---

## 7. Takeaways if you build this for real

1. **Split the API:** `/catalog` (CDN + ETag) and `/stores/:id/stock` (tiny,
   per store). Put images on a CDN from day one.
2. **One Redis hash per dark store** for availability, written in the same
   code path as every stock change (truth first, then the copy), plus a
   rebuild job and a drift alarm ("Redis vs Postgres differ for > N SKUs").
3. **Badges, not numbers.** This matters doubly for medicines: exact
   quantities of scheduled drugs are not something to publish.
4. **Rx items:** show them, with an "Rx" tag (the demo page does), but the
   checkout flow (chapter 4) must route them through prescription verification.
5. **Reuse your existing product catalog** as the source for `/catalog`.
   Only the *availability* layer needs to be new for quick commerce.

---

## Try it

```bash
open http://localhost:4000/customer.html               # the home screen on a map
curl -s localhost:4000/stores/1/stock | head -c 300     # the tiny per-store payload
curl -s -X POST localhost:4000/admin/stores/1/stock \
     -H 'content-type: application/json' -d '{"skuId":1,"onHand":2}'
# ...refresh Forum Mall in the page: Paracetamol 500mg now says "Only 2 left"
npm run redis:cli    # then: HGETALL stock:1    HGET stock:1 1
npx jest --config ./test/jest-e2e.json test/02
```
