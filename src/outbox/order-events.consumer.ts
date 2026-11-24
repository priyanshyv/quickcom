import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Worker } from 'bullmq';
import { LoggingService } from '../logging/logging.service';
import { TraceCodes } from '../logging/trace-codes';
import { PaymentsService } from '../payments/payments.service';
import { bullConnection, ORDER_EVENT_PARTITIONS, ORDER_EVENTS_QUEUE, OrderEvent, runsWorkers } from './outbox.service';

const rupees = (p: number) => '₹' + (p / 100).toFixed(p % 100 ? 2 : 0);

// ─────────────────────────────────────────────────────────────────────────────
// The consumer of order events: sends the customer's SMS, and carries out
// refunds. (Chapter 5 adds the store's packing screen as another consumer.)
//
// Delivery is AT-LEAST-ONCE (see the relay), so every handler must be safe to
// run twice with the same event:
//   - SMS:    INSERT ... ON CONFLICT (event_id) DO NOTHING -> a second run sends nothing
//   - refund: gateway refund and our UPDATE both do nothing the second time
// That's the "idempotent consumer".
// ─────────────────────────────────────────────────────────────────────────────
@Injectable()
export class OrderEventsConsumer implements OnModuleInit, OnModuleDestroy {
  private workers: Worker[] = [];

  constructor(
    private readonly ds: DataSource,
    private readonly payments: PaymentsService,
    private readonly log: LoggingService,
  ) {}

  onModuleInit() {
    if (runsWorkers()) this.start();
  }

  // Tests call this by hand (they run with ROLE=api).
  start() {
    if (this.workers.length) return;
    // One worker per partition, one job at a time (see OrderEventQueues).
    for (let i = 0; i < ORDER_EVENT_PARTITIONS; i++) {
      const w = new Worker<OrderEvent>(`${ORDER_EVENTS_QUEUE}-${i}`, (job) => this.handle(job.data), {
        connection: bullConnection(),
        concurrency: 1,
      });
      w.on('failed', (job, err) => this.log.error(TraceCodes.EVENT_CONSUMER_FAILED, err, { jobId: job?.id, type: job?.name }));
      this.workers.push(w);
    }
  }

  async onModuleDestroy() {
    await Promise.all(this.workers.map((w) => w.close()));
  }

  async handle(e: OrderEvent) {
    const p = e.payload;
    switch (e.type) {
      case 'order.created':
        return this.sms(e, `Order #${e.orderId} placed (${rupees(p.totalPaise)}). Pay within 10 min to confirm it.`);
      case 'payment.failed':
        return this.sms(e, `Payment for order #${e.orderId} didn't go through. Your items are still held; you can try again.`);
      case 'order.status_changed':
        if (p.to === 'CONFIRMED') return this.sms(e, `Order #${e.orderId} confirmed! The store is packing it now.`);
        if (p.to === 'RX_REVIEW') return this.sms(e, `Payment received for order #${e.orderId}. A pharmacist is checking your prescription.`);
        if (p.to === 'CANCELLED') return this.sms(e, `Order #${e.orderId} was cancelled (${String(p.reason).replace(/_/g, ' ')}). Any money taken will be refunded.`);
        return;
      case 'refund.requested': {
        await this.payments.refund(p.paymentRef);
        return this.sms(e, `Refund of ${rupees(p.amountPaise)} for order #${e.orderId} has been started.`);
      }
    }
  }

  private async sms(e: OrderEvent, body: string) {
    await this.ds.query(
      `INSERT INTO notifications (event_id, order_id, channel, body) VALUES ($1, $2, 'sms', $3) ON CONFLICT (event_id) DO NOTHING`,
      [e.eventId, e.orderId, body],
    );
  }
}
