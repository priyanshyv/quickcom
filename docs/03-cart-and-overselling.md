# Chapter 3: Add to cart, and never sell the same strip twice

> **The one idea:** "check if there's one left" and "take it" must be **one
> step that nobody can interrupt**. If they are two steps, then under load
> someone always squeezes in between them, and you sell stock you don't have.

Analogy: a canteen has **one samosa left**. Three people look at the tray,
all see "1 left", and all pay at three different counters. Each cashier did
their job correctly; nobody looked at the tray *and* took the samosa in one
go. Three people paid, one samosa exists. That's overselling.

The fix is a single counter with the tray behind it. You ask, the cashier
checks and hands it over in one motion, and the next person waits a second.

---

## 0. Where you see this in the UI

Open **http://localhost:4000/customer.html**, click **Forum Mall**:

```
┌─────────────────────────────────────────────────────┐
│ 🛒 3 items · ₹105 · held 9:41        [Empty cart] Ⓐ │  ← GET /carts/:cartId
├─────────────────────────────────────────────────────┤
│ Delivering in 12 min from Koramangala Dark Store    │  ← GET /home (chapters 1+2)
│ PAIN RELIEF                                         │
│ Paracetamol 500mg Tablet          [ − 2 + ]  Ⓑ     │  ← PUT /carts/:cartId/items {qty: 3}
│ Strip of 10 · ₹20                 In stock          │
│ Ibuprofen 400mg Tablet            [ ADD ]    Ⓒ     │  ← PUT /carts/:cartId/items {qty: 1}
│ Strip of 10 · ₹35                 Only 2 left  Ⓓ   │  ← GET /stores/1/stock (chapter 2)
├─────────────────────────────────────────────────────┤
│ API calls this page made                       Ⓔ   │
│ GET /stores/1/stock → 200 · 4 ms                    │
│ PUT /carts/web-k3x9/items {"storeId":1,…} → 200     │
└─────────────────────────────────────────────────────┘
       "Sorry, someone just took the last one."  Ⓕ   ← the 409 toast
```

| What you do | API | Code |
|---|---|---|
| Tap **ADD** Ⓒ, or **+ / −** Ⓑ | `PUT /carts/:cartId/items {storeId, skuId, qty}` | [cart.module.ts](../src/cart/cart.module.ts) → `setQty('redis', …)` in [reservation.service.ts](../src/cart/reservation.service.ts) |
| See the cart bar Ⓐ (items, total, "held 9:41") | `GET /carts/:cartId` | `getCart()` |
| Badges update after your tap Ⓓ | `GET /stores/:id/stock` | chapter 2's split API |
| Someone beat you to it Ⓕ | the PUT returns **409** `OUT_OF_STOCK` | `outOfStock()` |
| Tap **Empty cart** | `DELETE /carts/:cartId` | `clearCart()` |
| Wait 10 min without touching the cart | nothing; the server's **sweeper** releases it | `sweep()` |

The **API calls** box Ⓔ at the bottom of the page logs every request the
page makes, so you can watch which API each tap uses.

Then open **http://localhost:4000/flash-sale.html**. That's the lab where 200
carts tap ADD on the same item at the same instant, using each of the three
versions below. One click there = `POST /admin/lab/flash-sale`.

---

## 1. Four words

| Word | Meaning | Where |
|---|---|---|
| **on hand** | strips physically on the shelf | `store_inventory.on_hand_qty` |
| **reserved** | strips promised to carts that haven't checked out | `store_inventory.reserved_qty` |
| **available** | what you may still promise someone: `on_hand − reserved` | computed; copied to Redis `stock:{storeId}` |
| **hold** | one cart's claim on N units of one item, with an expiry time | a row in the new `reservations` table |

"Add to cart" = **create or change a hold**, which moves stock from
*available* into *reserved*. The shelf doesn't change until a picker picks it
(chapter 5).

The API is **"set this line to qty N"**, not "add 1". Setting is naturally
*idempotent*: if a bad network makes the app send the same request twice, the
second one changes nothing. "Add 1" sent twice would hold 2. The e2e test
checks this.

---

## 2. ❌ The wrong version: read, decide in JavaScript, write

[reservation.service.ts → `setQtyNaive`](../src/cart/reservation.service.ts)

```ts
const inv = SELECT on_hand_qty, reserved_qty ...          // 1. read: "10 on hand, 9 reserved"
if (inv.on_hand_qty - inv.reserved_qty < 1) → 409          // 2. decide: "1 left, ok"
UPDATE store_inventory SET reserved_qty = 10 ...           // 3. write the number WE computed
```

Each line is fine on its own. The bug is the **gap** between 1 and 3:

```
time →
buyer A:  read reserved=9 ─────────────── write reserved=10
buyer B:      read reserved=9 ─────────────── write reserved=10   ← overwrote A's write
buyer C:          read reserved=9 ─────────────── write reserved=10
                  all three saw "1 left"; three holds exist; the counter says 10
```

This is called a **lost update**: B's write silently erased A's.

**What the lab and k6 measured:**

| Test | On sale | Sold | Oversold | Lost updates |
|---|---|---|---|---|
| Flash-sale lab button (200 buyers at once) | 10 | **200** | **190** | 199 |
| k6 `contest` (200 buyers, 1 tap each) | 10 | **200** | **190** | 198 |
| k6 `soldout` (50 users for 20 s) | 10 | **380** | **370** | 370 |
| k6 `hot` (endless stock, 50 users for 20 s) | 10 million | 33,591 | 0 | **32,519 (97%)** |

Look at the last row: even when there's *plenty* of stock, 97% of the
increments were lost. The `reserved` counter ended up ~1,000 when 33,591
holds existed. On the flash-sale page this shows as **"reserved counter went
up by: 1"** next to **200 sold**, and Redis showing **−190 left**.

Nothing errors and nothing crashes. The app is just quietly wrong, which is
why this bug ships to production so often.

---

## 3. ✅ Fix A: let Postgres check AND take in one statement

[reservation.service.ts → `setQtyPg` and `applyDelta`](../src/cart/reservation.service.ts)

```sql
UPDATE store_inventory
SET    reserved_qty = reserved_qty + 1              -- relative: "+1", not "= 10"
WHERE  store_id = 1 AND sku_id = 1
  AND  on_hand_qty - reserved_qty >= 1              -- the check, inside the same statement
RETURNING on_hand_qty - reserved_qty AS available
```

- 1 row updated → you got it.
- 0 rows updated → not enough left → **409**.

**Why this can't oversell.** While Postgres updates a row, it **locks** it. A
second buyer's UPDATE on the same row waits for the lock, and when it gets
it, Postgres **re-checks the WHERE against the new value**. So when there's 1
left, the first buyer takes it, and the second buyer's re-check sees 0 and
updates nothing. That works at Postgres's default isolation level (READ
COMMITTED); no special settings needed.

The whole hold is one transaction:
1. Lock this cart's line (`lockLine`, `SELECT … FOR UPDATE`), so two taps on
   the same cart line take turns.
2. Change the stock (`applyDelta`, the UPDATE above).
3. Save the line with a fresh expiry (`saveLine`).
4. After commit, update the Redis copy for the home screen (`copyToRedis`).

**The cost: the hot row.** Every buyer of the *same item* in the *same
store* waits on *that one row's* lock. They form a queue.

| k6, Fix A, 50 users for 20 s | Requests/sec | p95 |
|---|---|---|
| `hot`: everyone buys the same item | **976** | 91 ms |
| `spread`: buyers spread over 100 items | **1,839** | 40 ms |

Same code, same machine. Concentrating everyone on one row **halves**
throughput and doubles latency. That's the hot row.

---

## 4. ✅ Fix B: a Redis "gate" in front, Postgres "confirm" behind

[reservation.service.ts → `setQtyRedis`](../src/cart/reservation.service.ts) and the
Lua script in [cart.constants.ts](../src/cart/cart.constants.ts)

```lua
local left = redis.call('HGET', KEYS[1], ARGV[1])      -- stock:1, sku 1
if not left then return -1 end                          -- store doesn't sell it
if tonumber(left) < tonumber(ARGV[2]) then return -2 end -- not enough: change nothing
return redis.call('HINCRBY', KEYS[1], ARGV[1], -ARGV[2]) -- take it
```

**Why Lua?** Redis runs one command at a time, and it runs a whole Lua script
as **one command**. Nothing can run between the `HGET` (check) and the
`HINCRBY` (take). It's the canteen's single counter, inside Redis.

The flow:

```
tap ADD ─▶ Redis Lua gate ──"no"──▶ 409 immediately (Postgres never hears about it)
                │
              "yes"
                ▼
           Fix A in Postgres  ──"no"──▶ give the unit back to Redis, 409
                │                       (the Redis copy was wrong; Postgres had the final say)
              "yes"
                ▼
               200
```

**Why keep Postgres in the loop at all?** Redis here is a *copy* (chapter
2), and copies drift. If Redis alone decided, a drifted copy could oversell.
With Postgres confirming, the worst a wrong copy can do is send someone to
Postgres who then gets refused. There's an e2e test that sets Redis to "100
left" when Postgres knows 0: the request is refused, and Redis gets its unit
back.

**A rule worth remembering: if a copy must be wrong, make it wrong in the
safe direction.** The gate takes from Redis *before* Postgres and gives back
*after*. So for a moment Redis may under-report (someone sees "out" a
millisecond early), but it never over-reports.

**What the gate buys you (k6):**

| Scenario | Fix A (Postgres only) | Fix B (Redis gate) |
|---|---|---|
| `contest` (200 buyers, 10 units): p95 latency | 152 ms | **86 ms** |
| `contest`: writes that reached the hot row | 200 | **10** |
| `soldout` (stampede after it's gone): requests/sec | 2,659 | **8,037 (3×)** |
| `soldout`: writes that reached the hot row in 20 s | **53,310** | **10** |
| `hot` (endless stock, everyone succeeds): requests/sec | 976 | 754 (slower) |
| `spread` (100 items): requests/sec | 1,839 | 1,600 (slower) |

Read this honestly:
- **The gate shines when most people are turned away**, which is exactly a
  flash sale or a sold-out popular item. 161,096 refusals cost Postgres
  nothing.
- **When everyone succeeds, the gate is pure overhead.** Each winner still
  does the full Postgres transaction, *plus* a Redis call and a read. So it's
  ~20% slower. The hot row is still there for winners.

---

## 5. Holds expire: the sweeper

A cart someone abandoned must not hold stock forever. Every hold gets
`expires_at = now + 10 min`, and any change to a line restarts that line's
clock. That's the **"held 9:41"** countdown in the cart bar Ⓐ.

[reservation.service.ts → `sweep`](../src/cart/reservation.service.ts) runs
**every 5 s in every pod**:

```sql
WITH due AS (
  SELECT id FROM reservations
  WHERE status = 'held' AND expires_at < now()
  ORDER BY expires_at LIMIT 500
  FOR UPDATE SKIP LOCKED            -- ← the important part
)
UPDATE reservations SET status = 'expired' FROM due WHERE ...
RETURNING store_id, sku_id, qty
```

…then, in the same transaction, `reserved_qty -= qty` for each item, and
after commit `HINCRBY +qty` on the Redis copy.

**`FOR UPDATE SKIP LOCKED`** means "lock the rows I'm taking; if someone else
already locked a row, **skip it** instead of waiting". That gives two
guarantees:
- **Two pods sweeping at once never release the same hold twice.** Releasing
  twice would *invent* stock. Each pod takes different rows. (Tested: two
  sweepers at once over 60 expired holds release exactly 60, not 120.)
- **A customer editing their cart at the exact moment it expires** holds that
  row's lock, so the sweeper skips it this round instead of yanking stock out
  from under them. (Tested.)

So there's no "leader election" or "only one cron pod" to set up. Every pod
just runs it.

---

## 6. A fix for chapter 2's honest gap

Chapter 2 copied stock to Redis with `HSET available = <final number>`, and
admitted that two updates arriving in the wrong order could leave the older
number in Redis. Holds now update the copy with **`HINCRBY` by the change**
(`copyToRedis`):

```
HSET:     "set it to 8", "set it to 5"   → arrival order decides; the older one can win
HINCRBY:  "−1", "−2"                     → any order ends at the same number
```

**Send the change, not the result**, whenever updates can arrive out of
order.

---

## 7. All the numbers (this laptop, k6 in Docker)

| k6 scenario | Naive | Fix A: Postgres | Fix B: Redis gate |
|---|---|---|---|
| `contest`: sold / on sale | **200 / 10** | 10 / 10 | 10 / 10 |
| `contest`: p95 | 419 ms | 152 ms | **86 ms** |
| `soldout`: sold / on sale | **380 / 10** | 10 / 10 | 10 / 10 |
| `soldout`: requests/sec | 5,988 | 2,659 | **8,037** |
| `soldout`: hot-row writes | 380 | 53,310 | **10** |
| `hot`: requests/sec | 1,673 (but 97% lost) | **976** | 754 |
| `spread`: requests/sec | n/a | **1,839** | 1,600 |

The naive version is the "fastest" in two rows, because skipping correctness
is always fast.

---

## 8. What changes at Blinkit scale

**Is the hot row a real problem?** On this laptop one row handles ~1,000
holds per second. A normal busy store sells one item maybe a few times a
*minute*. So for daily traffic, **Fix A alone is enough**.

It becomes real on **drop days**: a sale, a new phone on Blinkit, or for a
pharmacy something like **a fever medicine during a viral wave**, where
thousands of people tap ADD on one item in one store within seconds, and most
of them must be told no. That's the `soldout` scenario, and that's where the
gate earns its keep (3× throughput, Postgres untouched).

If even the *winners* are too many for one row, the next tools are:
- **Split the counter.** Store 100 units as 4 rows of 25. Buyers pick a row
  at random, so 4 locks share the load. Checking "is any left" becomes a sum.
- **Redis as the truth for holds.** Postgres gets updated later from a queue.
  Much faster, but now Redis must not lose data (AOF persistence, replicas),
  and the chapter 2 rebuild can't just copy from Postgres any more. A big
  step in complexity, so only take it with numbers that demand it.
- **Per-customer limits** (`qty ≤ 10` per line here) stop one person or one
  bot from emptying a store.

**Hold at "add to cart", or only at "checkout"?** This chapter holds at
add-to-cart, with a 10-minute expiry.
- *Holding at cart* means no "it was in your cart, now it's gone"
  disappointment, but window-shoppers lock stock.
- *Holding only at checkout* means stock stays free for real buyers, but
  people sometimes lose items at the last step.

Many apps soft-check at cart (just show the badge) and hard-hold at "Proceed
to pay". The code is the same either way; you move *where* `setQty` is
called. Chapter 4 makes checkout turn holds into an order.

---

## 9. Compared with a typical order-time reservation system

| | Typical warehouse e-commerce backend | QuickCom |
|---|---|---|
| When stock is claimed | at **order** time, often by calling a separate inventory service | at **add to cart** |
| Idempotency | the inventory service dedups writes per order id | "set qty", plus one row per cart line |
| Releasing stale claims | a release **cron** with a grace period, working in pages | sweeper in every pod, `SKIP LOCKED`, every 5 s |
| Hot row | the inventory service answers "busy" (e.g. 409) when a stock row is locked; the caller retries | Fix A waits on the lock; Fix B keeps losers off it |
| Ordering work per warehouse | one queue per warehouse (or shard), consumed one message at a time | row locks per (store, item) |

A queue per warehouse is another valid way to kill races: if all stock work
for one warehouse goes through **one line**, nobody can squeeze in between.
It's simple and safe, but the whole warehouse moves at the speed of one
worker. Row locks per (store, item) let different items move in parallel.
For a 10-minute store, where "add to cart" must answer in milliseconds, the
row-level approach fits better.

---

## 10. Takeaways if you build this for real

1. **Fix A from day one** (conditional `UPDATE … WHERE available >= qty`). It's
   correct, simple, and enough for normal traffic. Never read-then-write stock.
2. **Holds with an expiry plus a `SKIP LOCKED` sweeper.** Choose the hold
   point (cart vs checkout) as a product decision; the code is the same.
3. **Add the Redis gate when an item can sell out under a crowd** (for a
   pharmacy: fever and flu medicines in season, masks, test kits). Keep
   Postgres as the final judge.
4. **Per-line limits.** Pharmacy rules may cap quantities for some drugs
   anyway; the same check stops hoarding.
5. **Rx items:** holding stock is fine, but the order must wait for
   prescription verification (chapter 4). Decide whether a hold on an Rx item
   lasts longer than 10 minutes while a pharmacist checks the prescription.

---

## Try it

```bash
open http://localhost:4000/flash-sale.html          # press the three buttons, compare
open http://localhost:4000/customer.html            # Forum Mall → ADD, + / −, watch the API log

# the same by hand
curl -s -X PUT localhost:4000/carts/me/items -H 'content-type: application/json' \
     -d '{"storeId":1,"skuId":1,"qty":2}'
curl -s localhost:4000/carts/me
curl -s localhost:4000/admin/holds/stats             # who refused how many, hot-row writes

# make a hold expire now, then sweep (in DBeaver or psql)
#   UPDATE reservations SET expires_at = now() - interval '1 second' WHERE cart_id = 'me';
curl -s -X POST localhost:4000/admin/holds/sweep

# load tests
npm run load -- -e MODE=naive -e SCENARIO=contest /load/03-flash-sale.js
npm run load -- -e MODE=redis -e SCENARIO=soldout /load/03-flash-sale.js
npx jest --config ./test/jest-e2e.json test/03
```
