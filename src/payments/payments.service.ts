import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { LoggingService } from '../logging/logging.service';
import { TraceCodes } from '../logging/trace-codes';
import { OutboxService } from '../outbox/outbox.service';
import { OrderStateService, TransitionResult } from '../orders/order-state.service';
import { MockGatewayService } from './mock-gateway.service';

export type ApplyOutcome = 'applied' | 'ignored';

export interface ApplyResult {
  outcome: ApplyOutcome;
  note: string;
  transition?: TransitionResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payments. Golden rules:
//
// 1. Our database is a COPY of the truth about money. The gateway is the truth.
//    Webhooks are how the gateway tells us, and webhooks can be late,
//    duplicated, or lost. So we also ASK the gateway when in doubt.
// 2. Applying "payment X was captured" must be safe to do twice, in any order,
//    from any source (webhook, reconciler, retry button).
// 3. If money arrives for an order that can't take it any more (cancelled, or
//    already paid by another attempt), refund it. Never keep money for nothing.
// ─────────────────────────────────────────────────────────────────────────────
@Injectable()
export class PaymentsService {
  constructor(
    private readonly ds: DataSource,
    private readonly gateway: MockGatewayService,
    private readonly orders: OrderStateService,
    private readonly outbox: OutboxService,
    private readonly log: LoggingService,
  ) {}

  // "Pay" button. Safe to tap twice: while an attempt is open, you get the
  // same attempt back. A unique index (one 'created' payment per order) backs
  // this up even if two taps race.
  async start(orderId: number) {
    const [order] = await this.ds.query(`SELECT id, status, total_paise FROM orders WHERE id = $1`, [orderId]);
    if (!order) throw new NotFoundException('order not found');

    const [open] = await this.ds.query(`SELECT * FROM payments WHERE order_id = $1 AND status = 'created'`, [orderId]);
    if (open) {
      // Our copy says "open". Ask the truth before trusting it: the customer may
      // have already paid (or failed) and the webhook just hasn't arrived.
      const gw = await this.gateway.getPayment(open.gateway_ref);
      if (gw.status === 'created') return this.view(open, 'reused');
      await this.applyFromGateway(open.gateway_ref, gw.status, 'pay-button');
      if (gw.status === 'captured') return { alreadyPaid: true, paymentRef: open.gateway_ref };
    }

    const [fresh] = await this.ds.query(`SELECT status FROM orders WHERE id = $1`, [orderId]);
    if (fresh.status !== 'PAYMENT_PENDING') {
      throw new ConflictException({ error: 'ORDER_NOT_PAYABLE', message: `Order is ${fresh.status}`, status: fresh.status });
    }

    const ref = await this.gateway.createPayment(orderId, order.total_paise);
    try {
      const [row] = await this.ds.query(
        `INSERT INTO payments (order_id, gateway_ref, amount_paise, status) VALUES ($1, $2, $3, 'created') RETURNING *`,
        [orderId, ref, order.total_paise],
      );
      return this.view(row, 'new');
    } catch (err: any) {
      if (err?.code !== '23505') throw err; // another tap won the race: use its attempt
      const [winner] = await this.ds.query(`SELECT * FROM payments WHERE order_id = $1 AND status = 'created'`, [orderId]);
      return this.view(winner, 'reused');
    }
  }

  private view(p: any, how: 'new' | 'reused') {
    return { paymentRef: p.gateway_ref, amountPaise: p.amount_paise, status: p.status, attempt: how };
  }

  // The heart of it. Called inside a transaction, by the webhook handler, the
  // reconciler and the Pay button alike. Locks the payment row, so two
  // callers applying the same event take turns and the second sees it's done.
  async applyEvent(m: EntityManager, ref: string, kind: 'captured' | 'failed', actor: string): Promise<ApplyResult> {
    const [p] = await m.query(`SELECT * FROM payments WHERE gateway_ref = $1 FOR UPDATE`, [ref]);
    if (!p) return { outcome: 'ignored', note: 'unknown payment' };

    if (kind === 'failed') {
      if (p.status !== 'created') return { outcome: 'ignored', note: `stale: payment is already ${p.status}` };
      await m.query(`UPDATE payments SET status = 'failed', updated_at = now() WHERE id = $1`, [p.id]);
      await this.outbox.add(m, Number(p.order_id), 'payment.failed', { orderId: Number(p.order_id), paymentRef: ref });
      // The ORDER stays PAYMENT_PENDING: the customer may retry until payment_due_at.
      return { outcome: 'applied', note: 'attempt failed; order still waiting for payment' };
    }

    // kind === 'captured'
    if (p.status === 'captured' || p.status === 'refunded') return { outcome: 'ignored', note: `already ${p.status}` };
    // Note: p.status may be 'failed' here (we gave up on it, then the money went
    // through anyway). Money is money: record it, then decide what to do.
    await m.query(`UPDATE payments SET status = 'captured', updated_at = now() WHERE id = $1`, [p.id]);

    const [o] = await m.query(`SELECT id, status, has_rx, total_paise FROM orders WHERE id = $1 FOR UPDATE`, [p.order_id]);
    if (o.status === 'PAYMENT_PENDING' && p.amount_paise === o.total_paise) {
      const transition = await this.orders.transition(m, Number(o.id), o.has_rx ? 'RX_REVIEW' : 'CONFIRMED', {
        reason: 'payment_captured',
        actor,
      });
      return { outcome: 'applied', note: `order ${transition.to}`, transition };
    }
    // Paid, but the order can't take it (cancelled / already paid / wrong amount).
    const why = o.status === 'CANCELLED' ? 'order_already_cancelled' : o.status === 'PAYMENT_PENDING' ? 'amount_mismatch' : 'order_already_paid';
    await this.outbox.add(m, Number(o.id), 'refund.requested', { orderId: Number(o.id), paymentRef: ref, amountPaise: p.amount_paise, reason: why });
    return { outcome: 'applied', note: `money captured but ${why}: refund requested` };
  }

  // Apply what the GATEWAY says (reconciler / Pay button), outside any request.
  async applyFromGateway(ref: string, status: string, actor: string): Promise<ApplyResult | null> {
    if (status !== 'captured' && status !== 'failed') return null;
    const r = await this.ds.transaction((m) => this.applyEvent(m, ref, status, actor));
    await this.orders.afterCommit(r.transition);
    if (r.outcome === 'applied') this.log.info(TraceCodes.PAYMENT_RECONCILED, { ref, status, actor, note: r.note });
    return r;
  }

  // Refund (called by the outbox consumer for 'refund.requested'). Both steps
  // are idempotent, so a retried job can't refund twice.
  async refund(ref: string) {
    const gw = await this.gateway.refund(ref);
    const [, n] = await this.ds.query(
      `UPDATE payments SET status = 'refunded', updated_at = now() WHERE gateway_ref = $1 AND status = 'captured'`,
      [ref],
    );
    if (n) this.log.info(TraceCodes.REFUND_ISSUED, { ref });
    return { gatewayStatus: gw, changed: n === 1 };
  }

  // When an order is cancelled with money already captured, ask for a refund.
  async requestRefundsForCancelled(m: EntityManager, orderId: number) {
    const paid: { gateway_ref: string; amount_paise: number }[] = await m.query(
      `SELECT gateway_ref, amount_paise FROM payments WHERE order_id = $1 AND status = 'captured'`,
      [orderId],
    );
    for (const p of paid) {
      await this.outbox.add(m, orderId, 'refund.requested', { orderId, paymentRef: p.gateway_ref, amountPaise: p.amount_paise, reason: 'order_cancelled' });
    }
  }
}
