# Chapter 4: Checkout and payments, where money and stock must never disagree

> **The one idea:** payment news comes from a stranger who is unreliable.
> The same message can arrive twice, late, or never, and someone else may
> fake it. So: **write every change once** (a state machine, a history row
> and an outbox event, all in one transaction), **accept any message any
> number of times** (idempotency), and **when in doubt, ask the source**
> (reconciliation).

Analogy: a shopkeeper waiting for the bank's "₹726 received" SMS.

| What can go wrong | What a good shopkeeper does |
|---|---|
| A prankster sends a fake SMS | checks it really came from the bank |
| The same SMS arrives twice | ticks the transaction id in a notebook, so it counts once |
| No SMS at all | after a while, phones the bank |
| The money comes in for an order already cancelled | gives the money back |

That's this whole chapter: **signature**, **inbox**, **reconciler**, **refund**.

---

## 0. Where you see this in the UI

Every page now shares one top bar: *Customer app · My orders · Pharmacist · Lab: flash sale · Lab: payments · Ops map*.

### The customer journey (http://localhost:4000/customer.html → Forum Mall)

```
① tap ADD on a few items      → green cart bar: "3 items · ₹105 · held for you 9:41 · View cart ›"
② View cart                   → sheet with lines, + / −, the BILL (items, delivery ₹25 or FREE above ₹199)
                                 and "Prescription needed" if any item is Rx
③ Place order · ₹130          → POST /orders   (header Idempotency-Key: ck-…)
④ Mock UPI sheet opens        → POST /orders/:id/payments (opens an attempt)
     pick how the webhook behaves: Normal / Duplicate ×3 / Late 5 s / Lost
     Approve or Decline       → POST /mock-gateway/payments/:ref/complete
                                 …the GATEWAY then calls POST /webhooks/payment on our server
⑤ You land on the order page  → /order.html?id=…  (refreshes every 1.5 s)
```

### The order page (http://localhost:4000/order.html?id=…)

```
┌──────────────────────────────────────────────┐ ┌───────────────────────────────┐
│ Order #18472 · Koramangala Dark Store        │ │ 📱 SMS to the customer      Ⓑ │
│ A pharmacist is checking your prescription Ⓐ │ │ Order #18472 placed (₹726)…   │
│ ●──────●──────○──────○ · · · · · · ·         │ │ Payment received… pharmacist… │
│ Placed Paid  Rx    Confirmed Packing On the  │ └───────────────────────────────┘
│              checked          way Delivered  │
│ [Pay ₹726]  [Cancel order]                 Ⓒ │
└──────────────────────────────────────────────┘
 Items + bill (snapshot)       Status history (order_status_log)               Ⓓ
 Behind the scenes:  Payment attempts Ⓔ │ Webhooks from the gateway Ⓕ │ Outbox events Ⓖ
```

| On screen | What it shows | API | Code |
|---|---|---|---|
| Ⓐ headline + progress | current status; greyed steps arrive in chapters 5-7 | `GET /orders/:id` | [orders.service.ts → `get`](../src/orders/orders.service.ts) |
| Ⓑ SMS bubbles | what the queue consumer "sent" | (same) | [order-events.consumer.ts](../src/outbox/order-events.consumer.ts) |
| Ⓒ Pay / Cancel | retry payment until the deadline; cancel before packing | `POST /orders/:id/payments`, `POST /orders/:id/cancel` | [payments.service.ts → `start`](../src/payments/payments.service.ts), `cancel` |
| Ⓓ status history | every change: from → to, **why**, **who** | (same) | [order-state.service.ts → `transition`](../src/orders/order-state.service.ts) |
| Ⓔ payment attempts | one row per try: created / captured / failed / refunded | (same) | `payments` table |
| Ⓕ webhooks | **every delivery** and our answer: `applied`, `duplicate`, `ignored` | `GET /admin/webhooks/deliveries` | [webhooks.service.ts → `handle`](../src/payments/webhooks.service.ts) |
| Ⓖ outbox events | each event, `pending` → `published` | (same) | [outbox-relay.service.ts](../src/outbox/outbox-relay.service.ts) |

Try **Duplicate ×3** in the UPI sheet: Ⓕ shows three deliveries of the same
event id, with one `applied` and two `duplicate`. Ⓓ has one CONFIRMED row,
and Ⓑ one "confirmed" SMS.

### Pharmacist (http://localhost:4000/pharmacist.html)

Paid orders with an **Rx** item wait here (status `RX_REVIEW`). The page shows
how long each has waited, the items, a note box, and **Approve** /
**Reject & refund** (`GET /admin/rx-queue`, `POST /admin/orders/:id/rx`).

### Payments chaos lab (http://localhost:4000/payments-lab.html)

Five stories × two buttons (❌ naive, ✅ right). Each run does the real thing
end to end and then checks money, stock, status and SMS (`POST /admin/lab/payments`).
Section 9 has the results.

---

## 1. The whole journey on one page

```
customer app            our server                                   gateway (mock)        workers
───────────             ──────────                                   ──────────────        ───────
Place order ──POST /orders──▶ txn: holds → order + items,
  (Idempotency-Key)            history row, outbox "order.created"
Pay ─────────POST /orders/:id/payments──▶ createPayment ───────────▶ pay_123 = created
UPI "Approve" ───────────────────────────────────────────────────▶ pay_123 = captured
                         ◀──── POST /webhooks/payment (signed) ───── event evt_9 
                               verify signature
                               txn: inbox evt_9, payment captured,
                                    order → CONFIRMED (or RX_REVIEW),
                                    history row, outbox "status_changed"
                               ──200──────────────────────────────▶ (stops retrying)
                                                                                     relay: outbox → queue (partition = order % 16)
                                                                                     consumer: SMS "confirmed!"
             (every 5 s)       reconciler: "payments open > 30 s? ask the gateway"
                               timeout:    "unpaid past the deadline? last look, then cancel + release stock"
```

---

## 2. Checkout: turning holds into an order, exactly once

[orders.service.ts → `place`](../src/orders/orders.service.ts)

**The problem.** You tap "Place order" in a lift, the network drops, and the
app retries. Did the first request create an order? The app can't know.
Without protection, a retry could make a second order, or show "your cart is
empty" because the first request already used it.

**The fix: an Idempotency-Key.** When you tap, the app makes up a random key
(`ck-…`, see `placeOrder` in [customer.html](../public/customer.html)). It
**keeps the same key** for every retry of that tap. On the server:

```sql
SELECT pg_advisory_xact_lock(hashtextextended('ck-…', 0));   -- copies of the same request take turns
SELECT id, request_fingerprint FROM orders WHERE idempotency_key = 'ck-…';
--   found + same cart      -> return that order  ("replayed": true)
--   found + different cart -> 422 IDEMPOTENCY_KEY_REUSED
--   not found              -> carry on and create it
```

The `UNIQUE` constraint on `orders.idempotency_key` is the backstop. Tested:
**5 identical requests at once → 1 order**.

The same transaction then:
1. **Locks the cart's holds** (`FOR UPDATE`), so chapter 3's sweeper skips
   them now.
2. **Prices from Postgres, not the cached catalog.** Chapter 2's rule: the
   cache is for *showing*, the truth is for *money*. Tested by changing a
   price in the DB: the order uses the new one.
3. **Inserts the order and `order_items`** with a *snapshot* of name and
   price. Renaming or repricing a product later can't rewrite an old bill.
4. **Deletes the holds.** The stock stays in `reserved_qty`; the **order**
   owns it now. Chapter 3's 10-minute hold clock stops, and the order's
   `payment_due_at` clock starts.
5. **Writes a history row and an outbox event** (`order.created`).

---

## 3. The state machine: rules in a table, not in if/else

[order-state.service.ts](../src/orders/order-state.service.ts) and the
migration [1731500000000-Orders.ts](../src/db/migrations/1731500000000-Orders.ts)

```
PAYMENT_PENDING ──paid────────────▶ CONFIRMED
      │          ──paid (has Rx)──▶ RX_REVIEW ──pharmacist approves──▶ CONFIRMED
      │                                  └─────pharmacist rejects───▶ CANCELLED
      └──timeout / customer cancels──────────────────────────────────▶ CANCELLED
CONFIRMED ──customer cancels (before packing)────────────────────────▶ CANCELLED
```

The arrows are **rows** in `order_status_transitions`. `transition()` is the
**only** code allowed to change `orders.status`, and it always does five
things in the caller's transaction:

1. **Is this arrow in the table?** If not, `409 INVALID_TRANSITION`. Tested:
   CANCELLED → CONFIRMED is refused.
2. **Compare-and-set**: `UPDATE … SET status = 'CONFIRMED' WHERE id = … AND status = 'PAYMENT_PENDING'`.
   This is chapter 3's idea again, on the order row.
3. **A history row** in `order_status_log`: from, to, *why*, *who*. This is
   the status history on the order page.
4. **An outbox event** (`order.status_changed`).
5. If cancelling: **give the stock back** (`reserved_qty −= qty`) and, after
   commit, the Redis copy.

Asking for the status the order already has does nothing, so retries are
harmless. Chapter 5 adds PACKING and the rest by **inserting rows**; the code
doesn't change.

---

## 4. Payments: attempts, and "ask the truth"

[payments.service.ts](../src/payments/payments.service.ts)

- **One row per attempt.** Decline once, retry, and you get a second row. A
  partial unique index allows **only one open attempt per order**, so a
  double tap on "Pay" can't open two. Tested: the second tap returns the
  same `paymentRef`, and the UPI sheet says *"same attempt as before
  (double-tap safe)"*.
- **Before reusing an open attempt, ask the gateway.** Your copy may say
  "open" while the customer has already paid or failed and the webhook just
  hasn't arrived. `start()` asks first. That's how the "late failure" story
  stays correct.
- **`applyEvent(ref, captured | failed, actor)`** is the one function that
  applies payment news. The webhook, the reconciler and the Pay button all
  call it. It locks the payment row, so two callers take turns, and the
  second sees "already captured", which gives `ignored`.
- **Money for an order that can't take it** (cancelled, already paid by
  another attempt, or the wrong amount) → write a `refund.requested` outbox
  event. **Never keep money for nothing.**

---

## 5. Webhooks: the right way and the naive way

[webhooks.service.ts](../src/payments/webhooks.service.ts)

### ✅ `POST /webhooks/payment`

1. **Signature.** HMAC-SHA256 of the **raw bytes** with a shared secret.
   This is why [main.ts](../src/main.ts) creates the app with `rawBody: true`:
   re-serialised JSON can differ by a single space and fail the check. The
   comparison uses `timingSafeEqual`. A bad signature gets **401** and nothing
   changes (tested).
2. **Inbox (dedupe):** `INSERT INTO webhook_events (event_id …) ON CONFLICT DO NOTHING`.
   A redelivery carries the **same event id**. If the insert did nothing, the
   answer is **200 "duplicate"**, so the gateway stops retrying and nothing
   changes.
3. **Apply** through `applyEvent` and the state machine, **in the same
   transaction** as the inbox row. If applying crashes, the inbox row rolls
   back too, so the gateway's retry gets a real second chance.
4. **Answer fast.** The SMS and refunds happen later, through the outbox.

### ❌ `POST /webhooks/payment/naive`

"The webhook says X, so set the order to X":
- no signature check;
- no dedupe;
- no state machine: a late "failed" cancels an order that was paid;
- a **dual write**: update Postgres, then push to the queue directly.

---

## 6. When webhooks fail: the reconciler and the timeout

[order-sweeper.service.ts](../src/orders/order-sweeper.service.ts) runs every
5 s in every worker:

1. **Reconcile.** A payment still `created` after 30 s means its webhook may
   be lost. Ask the gateway, and apply whatever it says. This rescued a real
   order during development: a bug made all 3 webhook deliveries fail with
   500, and 30 s later the order was CONFIRMED with `actor = reconciler`.
2. **Timeout.** An order unpaid past `payment_due_at` gets one last look at
   the gateway (never cancel what was actually paid), then `CANCELLED` with
   the stock released. `FOR UPDATE SKIP LOCKED` skips an order that a webhook
   is updating at that very moment.

**Capture after cancel.** Real life allows this: the customer pays a second
after the timeout cancelled the order. `applyEvent` records the money, sees
`CANCELLED`, and requests a refund. The lab tests exactly this story.

---

## 7. The outbox: never lose an event, never invent one

[outbox.service.ts](../src/outbox/outbox.service.ts), [outbox-relay.service.ts](../src/outbox/outbox-relay.service.ts), [order-events.consumer.ts](../src/outbox/order-events.consumer.ts)

**The dual-write problem.** We change Postgres *and* tell a queue. No single
transaction covers both:

```
commit ✓, crash before queue.add  → order CONFIRMED, customer never told, store never packs
queue.add ✓, transaction rolls back → customer told about a change that never happened
```

**The fix.** Write the event as a **row in the same transaction** (`outbox`).
A **relay** (every 500 ms, `SKIP LOCKED`, so every worker can run it) copies
unpublished rows into BullMQ with `jobId = outbox-{id}`, then marks them
published.

- **At-least-once.** A crash between "added to queue" and "marked published"
  re-adds the job. BullMQ ignores a duplicate `jobId` while the old job is
  still kept (1 h here). The consumer **also** dedupes:
  `notifications.event_id` is the primary key, and the refund is idempotent
  at both the gateway and our DB. This is the **idempotent consumer**.
  Tested by delivering a refund event twice by hand: nothing new happened.

**A bug the tests found: SMS out of order.** The suite sometimes saw
*"confirmed!"* arrive **before** *"placed"*. Both events were published
together, and a consumer running 10 jobs at once finished them backwards.

The fix is **partitions**:
- Each order's events always go to the same queue (`order id % 16`).
- Each queue runs **one job at a time across all pods** (BullMQ global
  concurrency 1).
- So one order's events stay in order, while 16 different orders run in
  parallel.

It's the same idea as one queue per warehouse shard with `prefetch(1)`.

**The partition count is your parallelism dial.** k6 journey, about 290
orders/s, delay from event to SMS:

| Partitions | Avg | p95 |
|---|---|---|
| 1 | **11.1 s** | 17.3 s |
| 4 | **7.2 s** | 12.7 s |
| 16 (default) | **0.36 s** | 0.48 s |

**Honest limits of this ordering:**
- If a job fails and is retried with backoff, later jobs in that partition
  can overtake it.
- With several relay pods, two batches could interleave.

When strict order matters (status changes a store screen acts on), add a
**sequence number per order** and have the consumer ignore anything older
than what it has already seen. `orders.version` exists for this; chapter 5
uses it.

---

## 8. Prescription items (the pharmacy part)

- `orders.has_rx` is set at checkout from the SKUs.
- A captured payment moves an Rx order to **RX_REVIEW**, not CONFIRMED.
- **Approve → CONFIRMED.** **Reject → CANCELLED**, with stock released and a
  refund requested. Tested end to end, including the gateway status becoming
  `refunded`.
- A pharmacist can only act on orders **in RX_REVIEW**. The state machine
  alone would allow PAYMENT_PENDING → CONFIRMED (that's how payment confirms
  an order), so `rxDecision` checks the current status first. Tested: 409.
- Open question for a real launch: what is the deadline for Rx review, and
  what happens when it's missed (auto-cancel and refund)?

---

## 9. The numbers

### Payments chaos lab (`/payments-lab.html`, also in the e2e suite)

| Story | ❌ Naive design | ✅ Right design |
|---|---|---|
| **Duplicate**: same webhook ×3 at once | CONFIRMED **3 times**, **3 "confirmed" SMS** | confirmed once, 1 SMS |
| **Late failure**: try 1 fails, try 2 succeeds, try 1's failure arrives last | **paid order CANCELLED, ₹45 kept, no refund** | stays CONFIRMED (the old failure only marks the old attempt) |
| **Lost webhook**, then the deadline passes | **cancelled while the customer was charged** | reconciler finds the money, CONFIRMED |
| **Capture after timeout** | order **resurrected** as CONFIRMED with its stock already released → **oversell** | stays CANCELLED, **₹45 auto-refunded** |
| **Forged webhook** (wrong signature) | **CONFIRMED for free** | **401**, order keeps waiting |

### k6 (this laptop, k6 in Docker)

| Test | Result |
|---|---|
| **Webhook storm, naive**: 50 users × 10 s posting one signed webhook | order confirmed **10,135 times**, **10,136 SMS** (770 req/s) |
| **Webhook storm, right**: same | **70,317** deliveries → confirmed **once**, 2 SMS; **6,959 req/s**, p95 9.9 ms (duplicates exit at the inbox) |
| **Journey**: 50 users × 20 s, each a new customer (add → order → pay → webhook) | **5,942 orders, ~290/s**, 0 failures, HTTP p95 82 ms, exactly 2 SMS per order, event → SMS p95 0.48 s |

### e2e

15 Chapter 4 tests (43 in all), including **"the stock books balance"**:
every reserved unit in `store_inventory` is owned by exactly one live hold or
one live order. That held across all 991 rows after every chaos run in this
chapter.

---

## 10. What changes at Blinkit scale

- **Outbox → Kafka.** At scale the relay is often a CDC tool (Debezium) that
  reads Postgres's WAL and publishes to Kafka. The partition key is the order
  id: the same "one order, one line" rule as our 16 BullMQ partitions.
- **Webhooks: return 2xx fast and do the work later.** Razorpay asks for a
  response within 5 s and retries for 24 h. Stripe retries for up to 3 days
  and **does not guarantee order**. Both say: dedupe by event id. (See
  References.)
- **Reconciliation is a product, not a cron.** Real teams run a daily
  money-and-orders reconciliation against the gateway's settlement report,
  plus the near-real-time check we built.
- **Idempotency keys expire.** Stripe prunes them after at least 24 h. Keep
  ours as long as a client might still retry, then archive.
- **Payment timeout vs stock.** A long payment window holds stock away from
  other buyers. Quick commerce keeps it short (minutes) and shows the timer,
  as our order page does.

---

## 11. Compared with a typical e-commerce order backend

| | Typical warehouse e-commerce backend | QuickCom |
|---|---|---|
| Allowed status moves | a workflow table (parent → child status), often checked in service code | `order_status_transitions` table, cached at boot, enforced in one `transition()` |
| Status history | a status log table | `order_status_log` with reason + actor |
| Concurrency on critical paths | a distributed mutex (e.g. a Redis lock) around checkout and payment callbacks | row locks + compare-and-set inside the transaction, advisory lock per Idempotency-Key |
| Webhook signatures | verified for some providers | HMAC over the raw body, `timingSafeEqual`, for every webhook |
| Events to other systems | queues fed directly from service code (a dual write) | transactional outbox + relay + idempotent consumer |

The state machine is a common idea: rules in a table, history in a log. The
new parts for a 10-minute flow are the **outbox** (no lost or phantom events)
and **reconciliation** (never trust webhooks alone).

---

## 12. Takeaways if you build this for real

1. **Idempotency-Key on "Place order" and on every payment call**, generated
   by the app per tap.
2. **Webhook handler = signature + inbox table + state machine + fast 200.**
   Never "set status from the webhook".
3. **Reconciler from day one**: payments open > 30 s, and a last look before
   any timeout cancel. **Auto-refund** money that arrives for a cancelled
   order.
4. **Outbox for every status change**, partitioned by order id. The SMS,
   store screen and analytics all hang off it.
5. **Rx review as a real state** (for a pharmacy) with its own SLA, alert
   and auto-cancel rule.

---

## 13. References

**Measured here** (this repo, this laptop): every number in sections 7 and 9,
and the e2e claims in section 9.

**Documented** (opened and checked; quotes are short):

| Claim in this chapter | Source |
|---|---|
| Stripe stores the first result per idempotency key, errors if the same key is reused with different parameters, prunes keys after ≥ 24 h | Stripe API docs, [Idempotent requests](https://docs.stripe.com/api/idempotent_requests); background: [Designing robust and predictable APIs with idempotency](https://stripe.com/blog/idempotency) (Brandur Leach, 2017) |
| Webhooks: verify the signature on the raw body, expect duplicates (dedupe by event id), no ordering guarantee, return 2xx quickly, retries for days | Stripe, [Receive webhook events](https://docs.stripe.com/webhooks): "doesn't guarantee the delivery of events in the order…" |
| Razorpay: dedupe with `x-razorpay-event-id`, events can arrive out of order, respond within 5 s, retries for 24 h, HMAC-SHA256 over the raw body ("Do not parse or cast the webhook request body") | Razorpay, [Webhook best practices](https://razorpay.com/docs/webhooks/best-practices/) and [Validate and test webhooks](https://razorpay.com/docs/webhooks/validate-test/) |
| Transactional outbox; idempotent consumer | microservices.io, [Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html), [Idempotent consumer](https://microservices.io/patterns/communication-style/idempotent-consumer.html) |
| BullMQ ignores a job added with an existing id; removed jobs no longer count as duplicates | BullMQ docs, [Job ids](https://docs.bullmq.io/guide/jobs/job-ids), [Auto-removal of jobs](https://docs.bullmq.io/guide/queues/auto-removal-of-jobs) |
| `pg_advisory_xact_lock` waits for an exclusive transaction-level lock | PostgreSQL docs, [Advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html) and [admin functions, table 9.110](https://www.postgresql.org/docs/current/functions-admin.html) |
| `FOR UPDATE SKIP LOCKED` suits queue-like tables | PostgreSQL docs, [SELECT → The Locking Clause](https://www.postgresql.org/docs/current/sql-select.html) |

**Assumptions** (our choices, not published by any quick-commerce company):
- the 10-minute payment window, the 30 s reconcile delay, ₹199 free delivery and the ₹25 fee;
- 16 partitions;
- holding stock at add-to-cart and handing it to the order at checkout;
- the RX_REVIEW flow and its rules.

We found no engineering write-up from Blinkit, Zepto or Swiggy Instamart on
how they handle checkout or payment webhooks, so treat this design as ours,
backed by the payment providers' own docs above.

---

## Try it

```bash
open http://localhost:4000/customer.html        # add → View cart → Place order → UPI sheet (try "Duplicate ×3")
open http://localhost:4000/order.html           # My orders → open one: SMS, history, webhooks, outbox
open http://localhost:4000/pharmacist.html      # buy an Antibiotics (Rx) item first, then approve/reject here
open http://localhost:4000/payments-lab.html    # five stories × naive / right

# by hand
curl -s -X PUT localhost:4000/carts/me/items -H 'content-type: application/json' -d '{"storeId":1,"skuId":1,"qty":1}'
curl -s -X POST localhost:4000/orders -H 'content-type: application/json' -H 'Idempotency-Key: try-it-0001' -d '{"cartId":"me"}'
curl -s -X POST localhost:4000/orders/<id>/payments
curl -s -X POST localhost:4000/mock-gateway/payments/<ref>/complete -H 'content-type: application/json' -d '{"outcome":"success","chaos":"lost"}'
sleep 35; curl -s localhost:4000/orders/<id>     # the reconciler found it
curl -s localhost:4000/admin/outbox/stats         # relay backlog + queue counts

# two separate processes, like production: API pods and worker pods
ROLE=api node dist/main      # HTTP only
ROLE=worker node dist/main   # relay + consumer + sweepers, no HTTP port

# load
npm run load -- -e SCENARIO=storm -e MODE=naive /load/04-checkout.js
npm run load -- -e SCENARIO=journey /load/04-checkout.js
npx jest --config ./test/jest-e2e.json test/04
```
