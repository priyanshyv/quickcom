import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { credentials } from '../config/credentials';
import { LoggingService } from '../logging/logging.service';
import { TraceCodes } from '../logging/trace-codes';
import { runsWorkers } from '../outbox/outbox.service';
import { MockGatewayService } from '../payments/mock-gateway.service';
import { PaymentsService } from '../payments/payments.service';
import { OrderStateService } from './order-state.service';

// ─────────────────────────────────────────────────────────────────────────────
// Two jobs that keep orders honest when webhooks let us down. Runs in every
// worker pod; SKIP LOCKED / row locks make that safe (same idea as chapter 3).
//
// 1. RECONCILE: a payment still 'created' after 30 s? Its webhook may be lost.
//    Ask the gateway directly and apply whatever it says.
// 2. TIMEOUT: an order still unpaid after payment_due_at? Ask the gateway one
//    last time (the money may have just gone through), and if there's still no
//    payment, cancel the order so its stock goes back on the shelf.
// ─────────────────────────────────────────────────────────────────────────────
@Injectable()
export class OrderSweeperService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly ds: DataSource,
    private readonly gateway: MockGatewayService,
    private readonly payments: PaymentsService,
    private readonly state: OrderStateService,
    private readonly log: LoggingService,
  ) {}

  onModuleInit() {
    if (!runsWorkers() || credentials.orders.sweepIntervalMs <= 0) return;
    this.timer = setInterval(() => this.tick(), credentials.orders.sweepIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (err) {
      this.log.error(TraceCodes.ORDER_SWEEP_FAILED, err);
    } finally {
      this.running = false;
    }
  }

  async runOnce() {
    let reconciled = 0;
    let cancelled = 0;

    // 1. Payments that have been "open" suspiciously long.
    const stale: { gateway_ref: string }[] = await this.ds.query(
      `SELECT gateway_ref FROM payments
       WHERE status = 'created' AND created_at < now() - $1::int * interval '1 second'
       ORDER BY created_at LIMIT 100`,
      [credentials.orders.reconcileAfterSeconds],
    );
    for (const p of stale) if (await this.reconcile(p.gateway_ref)) reconciled++;

    // 2. Orders past their payment deadline.
    const due: { id: string }[] = await this.ds.query(
      `SELECT id FROM orders WHERE status = 'PAYMENT_PENDING' AND payment_due_at < now() ORDER BY payment_due_at LIMIT 100`,
    );
    for (const { id } of due) {
      const orderId = Number(id);
      // Last look at the truth before cancelling: never cancel an order the
      // customer has actually paid for.
      const open: { gateway_ref: string }[] = await this.ds.query(`SELECT gateway_ref FROM payments WHERE order_id = $1 AND status = 'created'`, [orderId]);
      for (const p of open) if (await this.reconcile(p.gateway_ref)) reconciled++;
      if (await this.cancelIfStillUnpaid(orderId)) cancelled++;
    }
    return { reconciled, cancelled };
  }

  private async reconcile(ref: string): Promise<boolean> {
    const gw = await this.gateway.getPayment(ref).catch(() => null);
    if (!gw || (gw.status !== 'captured' && gw.status !== 'failed')) return false;
    const r = await this.payments.applyFromGateway(ref, gw.status, 'reconciler');
    return r?.outcome === 'applied';
  }

  private async cancelIfStillUnpaid(orderId: number): Promise<boolean> {
    const t = await this.ds.transaction(async (m) => {
      // SKIP LOCKED: if a webhook is applying a payment to this order right
      // now, leave it alone this round.
      const [o] = await m.query(
        `SELECT id FROM orders WHERE id = $1 AND status = 'PAYMENT_PENDING' AND payment_due_at < now() FOR UPDATE SKIP LOCKED`,
        [orderId],
      );
      if (!o) return null;
      return this.state.transition(m, orderId, 'CANCELLED', { reason: 'payment_timeout', actor: 'timeout' });
    });
    await this.state.afterCommit(t);
    return !!t?.changed;
  }
}
