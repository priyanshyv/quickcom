import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { timingSafeEqual } from 'crypto';
import { REDIS } from '../redis/redis.module';
import { LoggingService } from '../logging/logging.service';
import { TraceCodes } from '../logging/trace-codes';
import { stockKey } from '../inventory/inventory.constants';
import { ORDER_EVENTS, OrderEvent, OrderEventQueues } from '../outbox/outbox.service';
import { OrderStateService } from '../orders/order-state.service';
import { PaymentsService } from './payments.service';
import { signWebhook, WebhookEvent } from './mock-gateway.service';

@Injectable()
export class WebhooksService {
  readonly naiveStats = { received: 0 };

  constructor(
    private readonly ds: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ORDER_EVENTS) private readonly queues: OrderEventQueues,
    private readonly payments: PaymentsService,
    private readonly orders: OrderStateService,
    private readonly log: LoggingService,
  ) {}

  // ───────────────────────────────────────────────────────────────────────────
  // ✅ RIGHT: verify → dedupe → apply through the state machine → answer fast.
  //
  //   1. Signature: HMAC of the RAW bytes with our shared secret. Anyone can
  //      POST to /webhooks/payment; only the gateway knows the secret.
  //   2. Inbox: INSERT the event id into webhook_events. A redelivery has the
  //      same id, so the INSERT does nothing -> "duplicate", answer 200 (so the
  //      gateway STOPS retrying) and change nothing.
  //   3. Apply via PaymentsService.applyEvent (row locks + state machine), in
  //      the SAME transaction as step 2. If applying fails, the inbox row rolls
  //      back too, so the gateway's retry gets a real second chance.
  // ───────────────────────────────────────────────────────────────────────────
  async handle(rawBody: Buffer | undefined, signature: string | undefined) {
    const raw = rawBody?.toString('utf8') ?? '';
    if (!this.validSignature(raw, signature)) {
      this.log.info(TraceCodes.WEBHOOK_REJECTED, { reason: 'bad_signature' });
      throw new UnauthorizedException({ result: 'rejected', message: 'bad signature' });
    }
    const evt: WebhookEvent = JSON.parse(raw);
    const kind = evt.type === 'payment.captured' ? 'captured' : evt.type === 'payment.failed' ? 'failed' : null;

    const res = await this.ds.transaction(async (m) => {
      const fresh = await m.query(
        `INSERT INTO webhook_events (event_id, gateway_ref, type, outcome, payload)
         VALUES ($1, $2, $3, 'processing', $4)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [evt.id, evt.data.paymentRef, evt.type, raw],
      );
      if (!fresh.length) return { result: 'duplicate' as const, note: 'seen this event id before' };
      if (!kind) {
        await m.query(`UPDATE webhook_events SET outcome = 'ignored' WHERE event_id = $1`, [evt.id]);
        return { result: 'ignored' as const, note: `unhandled type ${evt.type}` };
      }
      const r = await this.payments.applyEvent(m, evt.data.paymentRef, kind, 'webhook');
      await m.query(`UPDATE webhook_events SET outcome = $2 WHERE event_id = $1`, [evt.id, r.outcome]);
      return { result: r.outcome, note: r.note, transition: r.transition };
    });

    await this.orders.afterCommit((res as any).transition);
    this.log.info(TraceCodes.WEBHOOK_APPLIED, { eventId: evt.id, type: evt.type, result: res.result });
    return { result: res.result, note: res.note };
  }

  private validSignature(raw: string, signature: string | undefined) {
    if (!signature) return false;
    const expected = Buffer.from(signWebhook(raw));
    const given = Buffer.from(signature);
    // timingSafeEqual: comparing byte by byte with an early exit leaks, through
    // response times, how many leading characters were right.
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ❌ NAIVE: "the webhook says X, so set the order to X".
  //   - no signature check (anyone can confirm any order)
  //   - no dedupe (3 deliveries = 3 confirmations = 3 SMS)
  //   - no state machine (a late "failed" cancels an order that was paid)
  //   - a DUAL WRITE: update Postgres, then separately push to the queue
  // ───────────────────────────────────────────────────────────────────────────
  async handleNaive(evt: WebhookEvent) {
    this.naiveStats.received++;
    const [p] = await this.ds.query(`SELECT order_id FROM payments WHERE gateway_ref = $1`, [evt.data.paymentRef]);
    if (!p) return { result: 'ignored' };
    const orderId = Number(p.order_id);

    if (evt.type === 'payment.captured') {
      await this.ds.query(`UPDATE payments SET status = 'captured', updated_at = now() WHERE gateway_ref = $1`, [evt.data.paymentRef]);
      const [o] = await this.ds.query(`SELECT status FROM orders WHERE id = $1`, [orderId]);
      await this.ds.query(`UPDATE orders SET status = 'CONFIRMED', updated_at = now() WHERE id = $1`, [orderId]);
      await this.ds.query(
        `INSERT INTO order_status_log (order_id, from_status, to_status, reason, actor) VALUES ($1, $2, 'CONFIRMED', 'payment_captured', 'naive-webhook')`,
        [orderId, o.status],
      );
      await this.publishDirectly(orderId, 'order.status_changed', { orderId, from: o.status, to: 'CONFIRMED', reason: 'payment_captured' });
    } else {
      await this.ds.query(`UPDATE payments SET status = 'failed', updated_at = now() WHERE gateway_ref = $1`, [evt.data.paymentRef]);
      await this.naiveCancel(orderId, 'payment_failed');
    }
    return { result: 'applied' };
  }

  // ❌ Cancel without asking anyone: used for a "failed" webhook and, in the
  // naive design, for the payment timeout too (no last look at the gateway).
  async naiveCancel(orderId: number, reason: string) {
    const [o] = await this.ds.query(`SELECT status, store_id FROM orders WHERE id = $1`, [orderId]);
    await this.ds.query(`UPDATE orders SET status = 'CANCELLED', cancel_reason = $2, updated_at = now() WHERE id = $1`, [orderId, reason]);
    await this.ds.query(
      `INSERT INTO order_status_log (order_id, from_status, to_status, reason, actor) VALUES ($1, $2, 'CANCELLED', $3, 'naive')`,
      [orderId, o.status, reason],
    );
    // Give the stock back — every time, whether or not it was already given back.
    // (GREATEST hides the damage instead of failing: the counter quietly
    // drops below the real number of holds, i.e. stock is invented.)
    const items: { sku_id: number; qty: number }[] = await this.ds.query(`SELECT sku_id, qty FROM order_items WHERE order_id = $1`, [orderId]);
    for (const it of items) {
      await this.ds.query(
        `UPDATE store_inventory SET reserved_qty = GREATEST(reserved_qty - $3, 0) WHERE store_id = $1 AND sku_id = $2`,
        [o.store_id, it.sku_id, it.qty],
      );
      await this.redis.hincrby(stockKey(o.store_id), String(it.sku_id), it.qty);
    }
    await this.publishDirectly(orderId, 'order.status_changed', { orderId, from: o.status, to: 'CANCELLED', reason });
  }

  // The dual write: the database change is already committed above; if the
  // process died right here, the event would simply never exist.
  private async publishDirectly(orderId: number, type: string, payload: Record<string, any>) {
    const [{ id }] = await this.ds.query(`SELECT nextval('outbox_id_seq') AS id`); // just a unique number
    const e: OrderEvent = { eventId: Number(id), orderId, type, payload };
    await this.queues.forOrder(orderId).add(type, e);
  }
}
