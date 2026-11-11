# Chapter 1: Serviceability, "can you deliver to me, and from which store?"

> **The one idea:** the answer to "which store serves this spot?" almost never
> changes, but the question is asked on **every single app open**. So you work
> it out once per small **box on the map**, remember it, and answer everyone
> else in that box from memory.

Analogy: a pizza shop doesn't take out a map and a ruler every time someone
calls. It has a list taped to the wall: "Koramangala 4th Block, yes;
Ejipura, yes; MG Road, no." The list was made once. Checking it takes a
second.

---

## 1. What the app asks, and what we answer

```
GET /serviceability?lat=12.9346&lng=77.6113          (Forum Mall)

{
  "serviceable": true,
  "store": { "id": 1, "code": "BLR-KOR", "name": "Koramangala Dark Store" },
  "distanceMeters": 1432,
  "promiseMinutes": 12,           <- "Delivering in 12 min"
  "alternatives": [],             <- other stores that ALSO cover this spot
  "via": "cache-hit",             <- how we answered (for learning)
  "cell": "tdr1w4d"               <- the ~153 m box this point falls in
}
```

Three possible outcomes:

| Situation | Example | Answer |
|---|---|---|
| Exactly one store's polygon covers you | Forum Mall | that store |
| Two polygons overlap and cover you | 12.925, 77.635 (KOR/HSR overlap) | the **nearest** one, the other as an alternative |
| No polygon covers you | MG Road | `serviceable: false`; the app shows "we don't deliver here yet" |

Try them in the browser at **http://localhost:4000/ops.html**: click a spot
and the panel shows the server's answer, how it was answered (`via`), and the
geohash cell. (Chapter 2 adds `customer.html`, the full home screen.)

---

## 2. Three ways to answer, from worst to best

### ❌ Version A, "naive": fetch every polygon and check them in JavaScript

`GET /serviceability/naive` · `src/serviceability/serviceability.service.ts` → `findNaive`

```
every request:  SELECT all stores + their polygons  →  loop in JS: "is the point inside?"
```

It's correct, and with 8 stores it's not even very slow. But it ships **every
polygon in the country over the network for every app open**. With 500 stores
across India at ~33 corners each, that's 16,500 coordinates per request to
answer a yes/no question.

### ⚠️ Version B, "postgis": let the database do the geometry

`GET /serviceability/postgis` → `findPostgis`

```sql
SELECT ... FROM stores
WHERE is_active
  AND ST_Covers(service_area, <your point>)   -- uses the GIST spatial index
```

This is how most teams start, and it's a good query: the **GIST index** lets
Postgres skip stores that are nowhere near you. The problem isn't the query.
It's that it runs **once per app open**. In chapter 0 we saw browsing traffic
is about 300× bigger than order traffic. If every app open costs a Postgres
query, Postgres's capacity is being spent on a question whose answer changed
last week, while checkout needs that capacity right now.

### ✅ Version C, "cached by geohash cell"

`GET /serviceability` → `findCached`

**Step 1. Turn the point into a box name (a geohash).** No I/O; just maths.

A geohash cuts the world in half again and again (left/right, then top/bottom)
and writes down which half you're in. After 35 cuts you get a 7-character name
for a box about **153 m × 153 m**. Points close together share the same name.

```
Forum Mall          12.93460, 77.61130  →  tdr1w4d
10 m away           12.93468, 77.61129  →  tdr1w4d   (same box, same answer)
```

All of Bangalore (~700 km²) is roughly 30,000 such boxes. That's a small, finite set
of things to remember, compared with "every possible GPS coordinate".
(`src/serviceability/geohash.ts`; the e2e test checks it matches PostGIS's
own `ST_GeoHash` exactly.)

**Step 2. Look the box up in Redis.** Key: `svc:v{version}:{cell}`

**Step 3. On a miss, ask PostGIS once about the whole box, then save the answer for an hour.**

```sql
-- "which polygons touch this box, and does each cover ALL of it?"
SELECT id, code, ..., ST_Covers(service_area, box) AS "coversWholeCell"
FROM stores WHERE is_active AND ST_Intersects(service_area, box)
```

**Step 4. The border problem (the subtle part).**

```
        polygon edge
            │
   ┌────────┼────────┐
   │ inside │ outside│   <- one 153 m box sitting ON the border.
   │   ✓    │   ✗    │      The box alone can't tell you which side
   └────────┼────────┘      YOUR exact point is on.
            │
```

If a store's polygon covers the **whole** box, everyone in it is served, and
we're done. If it only covers **part** of the box (an *edge cell*), the cached
entry says "maybe" and we fall back to one exact PostGIS check for that point.

Edge cells are only the thin ring along each polygon border, so in the load
test **~4% of requests** needed that fallback. Everyone else got a pure Redis
answer.

A naive cache that stored "the answer for the box's centre" would quietly
give **wrong answers** to people on the border: either "we deliver" when the
store can't, or "we don't" when it can. Wrong answers like that are hard to
spot in testing, which makes them dangerous. That's why the most important
test in this chapter compares the cache against PostGIS on **2,000 random
points** and requires every single one to match
(`test/01-serviceability.e2e-spec.ts`).

**Step 5. Cache the "no" too (negative caching).** Someone near MG Road opens
the app, sees "not serviceable", and tries again tomorrow, and the day after.
Without caching the "no", every one of those opens is a Postgres query.

---

## 3. Invalidation: what happens when a store closes suddenly?

> There are only two hard things in computer science: cache invalidation and
> naming things.

It's 7 pm, heavy rain, and Koramangala has half its riders missing. Ops turns
the store off:

```bash
curl -X PATCH localhost:4000/admin/stores/1/active \
     -H 'content-type: application/json' -d '{"isActive": false}'
```

Every cached box that says "Koramangala serves you" is now **wrong**. We
can't wait an hour for the TTL. Deleting thousands of keys one by one is slow
and easy to get wrong. So we use the **version-in-the-key trick**:

```
before:  svc:v9:tdr1w4d   -> "BLR-KOR"
ops turns KOR off  ->  INCR svc:version  (now 10)
after:   svc:v10:tdr1w4d  -> (missing) -> fresh PostGIS lookup -> "not serviceable"
```

Bumping one number makes **every** old entry unreachable at once. The old keys
simply expire after their TTL; nobody reads them again.

How do 50 pods find out the version changed? Each pod checks the version
**every 5 seconds** in the background (`SVC_VERSION_POLL_MS`) instead of on
every request. That trade-off is spelled out:

| Option | Cost | Staleness |
|---|---|---|
| Read the version on every request | +1 Redis call per request (doubles Redis traffic) | 0 s |
| **Poll every 5 s per pod (chosen)** | 50 pods ÷ 5 s = **10 calls/sec total** | **≤ 5 s** |
| Wait for the TTL | free | up to 1 hour ❌ |

A few seconds of "the app still says KOR delivers" is fine, because checkout
re-checks the store (chapter 4). An hour is not fine.

**Order of operations matters:** write the truth to **Postgres first**, *then*
bump the version. If you bump first, a request in between can read the old
`is_active = true` from Postgres and cache it under the **new** version. That
would leave a wrong answer cached for an hour.

---

## 4. The numbers (measured on this laptop)

`npm run load -- -e MODE=<mode> /load/01-serviceability.js`: 50 users, 20 s,
5,000 fixed points across Bangalore. "PG/request" is Postgres transactions
per request, measured from `pg_stat_database`.

| Version | Requests/sec | p95 | **PG/request** |
|---|---|---|---|
| A. naive (all polygons → JS) | ~8,400 | 9.7 ms | 0.96 |
| B. postgis (1 query per request) | ~9,900–10,700 | 7.9–8.9 ms | **0.99** |
| C. cached, cold start (empty cache) | ~14,400 | 6.0 ms | 0.08 |
| C. cached, warm | **~15,800–19,200** | **4.3–4.8 ms** | **0.04** |

Cache stats from the warm run: **100% hit rate, 3.9% edge fallbacks.**

How to read this honestly:

- **Speed went up ~1.5–1.9×.** Nice, but not the main point. Run-to-run noise
  on a laptop is ±20%, which is why there are ranges.
- **Postgres load went down 25×** (0.99 → 0.04 queries per request). **This is
  the main point.** At 5,000 app-opens/sec (the Blinkit-sized city from
  chapter 0), version B sends **5,000 queries/sec** to Postgres just to say
  "yes, Koramangala". Version C sends about **200**. That frees Postgres for
  the things only Postgres can do: orders, payments, stock.
- Version A isn't dramatically worse **here only because there are 8 stores.**
  Its cost grows with the number of stores. B's and C's costs don't.

---

## 5. Two more ideas worth knowing

**In-process memory instead of Redis.** Bangalore's 8 polygons are ~10 KB.
You could keep them in every pod's memory and do the ray-casting there, with no
network hop at all. For one city with tens of stores that's a perfectly good
choice (chapter 2 does exactly this for the catalog). Redis wins when the data
or computation is big, or when you want one shared, instantly-invalidatable
copy across many pods and services.

**Smarter cells.** Many large delivery companies use **H3** (Uber's hexagon
grid) instead of geohash squares. Hexagons are all the same distance from
their neighbours, which helps with "rings around a store" maths. The caching
idea is identical.

---

## 6. Compared with a typical pincode-based backend

| | Typical pincode-based backend | QuickCom |
|---|---|---|
| Key the user is identified by | **pincode** | **lat/lng → geohash cell** |
| Lookup | a pincode → warehouse-priority table | PostGIS polygons |
| Cache | long-lived (e.g. 24 h) cache of that table | Redis, 1 h TTL + version bump |
| Where the location comes from | last order → saved address → device GPS reverse-geocoded to a pincode → typed manually | device GPS directly |
| Promise | a delivery-date engine (same/next day, courier cutoffs) | distance-based minutes (chapter 8 refines it) |

The design shape is the same: compute "who serves this area" rarely, cache it,
and read it on every request. What changes is the **unit of area**. A pincode
(several km², uneven) is fine for "tomorrow". For "in 10 minutes" you need
~150 m precision, because one side of a pincode can be 4 minutes from the
store and the other side 15.

---

## 7. Takeaways if you build this for real

1. **Store polygons as data that ops can edit** (a `geography(Polygon)` column,
   drawn in an internal tool), not as a radius in code. Real polygons follow
   roads, avoid lakes and flyovers, and get **shrunk on rainy evenings**.
2. **Cache by geohash-7 (or H3), with version-bump invalidation.** Check
   correctness with a "cache == source of truth on N random points" test,
   exactly like `test/01-serviceability.e2e-spec.ts`.
3. **Re-check at checkout.** The home screen may be up to 5 s stale; the
   order must not be.
4. **Keep the pincode as a fallback** for users who deny location permission.
   A priority chain (last order → saved address → device GPS → typed
   pincode) works well.
5. **Pharmacy twist:** Rx-only or cold-chain items might come from a
   **smaller** polygon than OTC items. That means one store can have *two*
   polygons. The same cache works if the cache key includes the polygon type.

---

## Try it

```bash
open http://localhost:4000/ops.html                  # click around; watch "via"
curl "localhost:4000/serviceability?lat=12.9756&lng=77.6066"   # MG Road
curl localhost:4000/serviceability/stats            # hit rate for this pod
npm run redis:cli   # then: KEYS svc:*   GET svc:v10:tdr1w4d   GET svc:version
npx jest --config ./test/jest-e2e.json test/01
```
