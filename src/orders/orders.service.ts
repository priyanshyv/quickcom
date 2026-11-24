import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createHash } from 'crypto';
import { credentials } from '../config/credentials';
import { LoggingService } from '../logging/logging.service';
import { TraceCodes } from '../logging/trace-codes';
import { OutboxService } from '../outbox/outbox.service';
import { PaymentsService } from '../payments/payments.service';
import { OrderStateService } from './order-state.service';

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const CART_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

@Injectable()
export class OrdersService {
  constructor(
    private readonly ds: DataSource,
    private readonly state: OrderStateService,
    private readonly outbox: OutboxService,
    private readonly payments: PaymentsService,
    private readonly log: LoggingService,
  ) {}

  // ───────────────────────────────────────────────────────────────────────────
  // CHECKOUT: turn the cart's holds into an order, exactly once.
  //
  // The app makes up an Idempotency-Key when the customer taps "Place order"
  // and sends the SAME key if it has to retry (timeout, flaky network, app
  // restarted). Same key = same order, no matter how many times it arrives.
  //
  // One transaction:
  //   1. advisory lock on the key  -> two copies of the same request take turns
  //   2. key already used?         -> return that order (or 422 if it was for a different cart)
  //   3. lock the cart's holds     -> FOR UPDATE: the hold sweeper skips them now
  //   4. prices from Postgres      -> the truth, NOT the cached catalog (chapter 2's rule: money from the truth)
  //   5. insert order + items      -> items keep a SNAPSHOT of name and price
  //   6. delete the holds          -> the stock stays reserved; the ORDER owns it now
  //   7. history row + outbox event
  // ───────────────────────────────────────────────────────────────────────────
  async place(cartId: string, idempotencyKey: string | undefined) {
    if (!idempotencyKey || !KEY_PATTERN.test(idempotencyKey)) {
      throw new BadRequestException({ error: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Send an Idempotency-Key header (8-80 letters, digits, - or _)' });
    }
    if (!CART_PATTERN.test(cartId)) throw new BadRequestException('bad cartId');
    const fingerprint = createHash('sha256').update(JSON.stringify({ cartId })).digest('hex');

    const out = await this.ds.transaction(async (m) => {
      await m.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [idempotencyKey]);

      const [existing] = await m.query(`SELECT id, request_fingerprint FROM orders WHERE idempotency_key = $1`, [idempotencyKey]);
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) {
          throw new UnprocessableEntityException({ error: 'IDEMPOTENCY_KEY_REUSED', message: 'This key was already used for a different request' });
        }
        return { orderId: Number(existing.id), replayed: true };
      }

      const holds: { id: string; store_id: number; sku_id: number; qty: number }[] = await m.query(
        `SELECT id, store_id, sku_id, qty FROM reservations
         WHERE cart_id = $1 AND status = 'held' AND qty > 0
         ORDER BY id FOR UPDATE`,
        [cartId],
      );
      if (!holds.length) throw new ConflictException({ error: 'CART_EMPTY', message: 'Your cart is empty (or its holds expired)' });
      const storeIds = [...new Set(holds.map((h) => h.store_id))];
      if (storeIds.length > 1) throw new ConflictException({ error: 'MIXED_STORES', message: 'Your cart has items from two stores; remove one set' });
      const storeId = storeIds[0];
      const [store] = await m.query(`SELECT is_active FROM stores WHERE id = $1`, [storeId]);
      if (!store?.is_active) throw new ConflictException({ error: 'STORE_CLOSED', message: 'This store is not taking orders right now' });

      const skus: { id: number; name: string; mrp_paise: number; rx_required: boolean; is_active: boolean }[] = await m.query(
        `SELECT id, name, mrp_paise, rx_required, is_active FROM skus WHERE id = ANY($1)`,
        [holds.map((h) => h.sku_id)],
      );
      const byId = new Map(skus.map((s) => [s.id, s]));
      if (holds.some((h) => !byId.get(h.sku_id)?.is_active)) {
        throw new ConflictException({ error: 'ITEM_UNAVAILABLE', message: 'An item in your cart is no longer sold' });
      }

      const itemsTotal = holds.reduce((s, h) => s + byId.get(h.sku_id)!.mrp_paise * h.qty, 0);
      const fee = itemsTotal >= credentials.orders.freeDeliveryAbovePaise ? 0 : credentials.orders.deliveryFeePaise;
      const hasRx = holds.some((h) => byId.get(h.sku_id)!.rx_required);

      const [order] = await m.query(
        `INSERT INTO orders (customer_ref, store_id, status, idempotency_key, request_fingerprint,
                             items_total_paise, delivery_fee_paise, total_paise, has_rx, payment_due_at)
         VALUES ($1, $2, 'PAYMENT_PENDING', $3, $4, $5, $6, $7, $8, now() + $9::int * interval '1 second')
         RETURNING id`,
        [cartId, storeId, idempotencyKey, fingerprint, itemsTotal, fee, itemsTotal + fee, hasRx, credentials.orders.paymentSeconds],
      );
      const orderId = Number(order.id);
      await m.query(
        `INSERT INTO order_items (order_id, sku_id, name, qty, price_paise, rx_required)
         SELECT $1, u.sku_id, s.name, u.qty, s.mrp_paise, s.rx_required
         FROM unnest($2::int[], $3::int[]) AS u(sku_id, qty) JOIN skus s ON s.id = u.sku_id`,
        [orderId, holds.map((h) => h.sku_id), holds.map((h) => h.qty)],
      );
      await m.query(`DELETE FROM reservations WHERE id = ANY($1)`, [holds.map((h) => h.id)]);
      await m.query(
        `INSERT INTO order_status_log (order_id, from_status, to_status, reason, actor) VALUES ($1, NULL, 'PAYMENT_PENDING', 'order_placed', 'customer')`,
        [orderId],
      );
      await this.outbox.add(m, orderId, 'order.created', { orderId, totalPaise: itemsTotal + fee, hasRx, items: holds.length });
      return { orderId, replayed: false };
    });

    if (!out.replayed) this.log.info(TraceCodes.ORDER_PLACED, { orderId: out.orderId, cartId });
    return { ...(await this.get(out.orderId)), replayed: out.replayed };
  }

  // Everything about one order, including the "behind the scenes" tables the
  // order page shows.
  async get(orderId: number) {
    const [order] = await this.ds.query(
      `SELECT o.id, o.customer_ref AS "customerRef", o.store_id AS "storeId", s.name AS "storeName", o.status,
              o.items_total_paise AS "itemsTotalPaise", o.delivery_fee_paise AS "deliveryFeePaise",
              o.total_paise AS "totalPaise", o.has_rx AS "hasRx", o.payment_due_at AS "paymentDueAt",
              o.cancel_reason AS "cancelReason", o.version, o.created_at AS "createdAt"
       FROM orders o JOIN stores s ON s.id = o.store_id WHERE o.id = $1`,
      [orderId],
    );
    if (!order) throw new NotFoundException('order not found');
    order.id = Number(order.id);
    const [items, timeline, payments, webhooks, outbox, notifications] = await Promise.all([
      this.ds.query(`SELECT sku_id AS "skuId", name, qty, price_paise AS "pricePaise", rx_required AS "rxRequired" FROM order_items WHERE order_id = $1 ORDER BY sku_id`, [orderId]),
      this.ds.query(`SELECT from_status AS "from", to_status AS "to", reason, actor, created_at AS "at" FROM order_status_log WHERE order_id = $1 ORDER BY id`, [orderId]),
      this.ds.query(`SELECT gateway_ref AS "ref", amount_paise AS "amountPaise", status, created_at AS "createdAt", updated_at AS "updatedAt" FROM payments WHERE order_id = $1 ORDER BY id`, [orderId]),
      this.ds.query(
        `SELECT w.event_id AS "eventId", w.type, w.outcome, w.gateway_ref AS "ref", w.received_at AS "at"
         FROM webhook_events w JOIN payments p ON p.gateway_ref = w.gateway_ref WHERE p.order_id = $1 ORDER BY w.received_at`,
        [orderId],
      ),
      this.ds.query(`SELECT id, event_type AS "type", payload, created_at AS "createdAt", published_at AS "publishedAt" FROM outbox WHERE order_id = $1 ORDER BY id`, [orderId]),
      this.ds.query(`SELECT event_id AS "eventId", body, created_at AS "at" FROM notifications WHERE order_id = $1 ORDER BY created_at, event_id`, [orderId]),
    ]);
    return { order, items, timeline, payments, webhooks, outbox, notifications };
  }

  async listForCustomer(customerRef: string) {
    if (!CART_PATTERN.test(customerRef)) throw new BadRequestException('bad customer');
    const rows = await this.ds.query(
      `SELECT o.id, o.status, o.total_paise AS "totalPaise", o.has_rx AS "hasRx", o.created_at AS "createdAt",
              (SELECT count(*)::int FROM order_items i WHERE i.order_id = o.id) AS "lines"
       FROM orders o WHERE customer_ref = $1 ORDER BY created_at DESC LIMIT 20`,
      [customerRef],
    );
    return rows.map((r: any) => ({ ...r, id: Number(r.id) }));
  }

  // Customer cancels. Allowed before packing (the state machine decides).
  async cancel(orderId: number, customerRef: string) {
    const t = await this.ds.transaction(async (m) => {
      const [o] = await m.query(`SELECT customer_ref FROM orders WHERE id = $1`, [orderId]);
      if (!o || o.customer_ref !== customerRef) throw new NotFoundException('order not found');
      const r = await this.state.transition(m, orderId, 'CANCELLED', { reason: 'customer_cancelled', actor: 'customer' });
      if (r.changed) await this.payments.requestRefundsForCancelled(m, orderId);
      return r;
    });
    await this.state.afterCommit(t);
    return this.get(orderId);
  }

  // ── Pharmacist (Rx review) ──
  async rxQueue() {
    const orders = await this.ds.query(
      `SELECT o.id, o.total_paise AS "totalPaise", o.created_at AS "createdAt", s.name AS "storeName",
              extract(epoch FROM now() - o.updated_at)::int AS "waitingSeconds"
       FROM orders o JOIN stores s ON s.id = o.store_id
       WHERE o.status = 'RX_REVIEW' ORDER BY o.created_at LIMIT 50`,
    );
    for (const o of orders) {
      o.id = Number(o.id);
      o.items = await this.ds.query(`SELECT name, qty, rx_required AS "rxRequired" FROM order_items WHERE order_id = $1 ORDER BY rx_required DESC, name`, [o.id]);
    }
    return orders;
  }

  async rxDecision(orderId: number, approve: boolean, note: string) {
    const t = await this.ds.transaction(async (m) => {
      // The state machine would also allow PAYMENT_PENDING -> CONFIRMED (that's
      // how payment confirms an order). A pharmacist must only act on orders
      // waiting for THEM, so check that first.
      const [o] = await m.query(`SELECT status FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
      if (!o) throw new NotFoundException('order not found');
      if (o.status !== 'RX_REVIEW') throw new ConflictException({ error: 'NOT_IN_RX_REVIEW', message: `Order is ${o.status}` });
      const r = await this.state.transition(m, orderId, approve ? 'CONFIRMED' : 'CANCELLED', {
        reason: approve ? 'rx_approved' : `rx_rejected${note ? ':' + note.slice(0, 40) : ''}`.slice(0, 60),
        actor: 'pharmacist',
      });
      if (r.changed && !approve) await this.payments.requestRefundsForCancelled(m, orderId);
      return r;
    });
    await this.state.afterCommit(t);
    return this.get(orderId);
  }
}
