import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { LabArm, LabService } from '../cart/lab.service';
import { ReservationService } from '../cart/reservation.service';
import { ORDER_EVENTS, OrderEventQueues } from '../outbox/outbox.service';
import { OutboxRelayService } from '../outbox/outbox-relay.service';
import { MockGatewayService, WebhookTarget } from '../payments/mock-gateway.service';
import { PaymentsService } from '../payments/payments.service';
import { WebhooksService } from '../payments/webhooks.service';
import { OrderSweeperService } from './order-sweeper.service';
import { OrdersService } from './orders.service';

export const PAYMENT_SCENARIOS = ['duplicate', 'late-failure', 'lost-webhook', 'capture-after-timeout', 'forged'] as const;
export type PaymentScenario = (typeof PAYMENT_SCENARIOS)[number];

const STORIES: Record<PaymentScenario, { story: string; expect: string }> = {
  duplicate: {
    story: 'You pay once. The gateway sends the same "payment captured" webhook 3 times at the same moment.',
    expect: 'Confirmed once, one "confirmed" SMS.',
  },
  'late-failure': {
    story: 'Your first try fails, you retry and it succeeds. The FAILURE webhook from the first try arrives last.',
    expect: 'Stays confirmed. The old failure only marks the old attempt.',
  },
  'lost-webhook': {
    story: 'You pay, the money is taken, but the webhook never arrives. Then the payment deadline passes.',
    expect: 'The reconciler asks the gateway, finds the money, confirms the order.',
  },
  'capture-after-timeout': {
    story: 'You open the UPI app and get distracted. The order times out and is cancelled. Then you finish paying.',
    expect: 'Order stays cancelled, your money is refunded automatically.',
  },
  forged: {
    story: 'Someone posts a fake "payment captured" webhook (wrong signature) for an order nobody paid for.',
    expect: 'Rejected with 401; the order keeps waiting for payment.',
  },
};

const rupees = (p: number) => '₹' + (p / 100).toFixed(p % 100 ? 2 : 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// The payment chaos lab (learning only). Each scenario is a real-world story
// that breaks naive payment handling. It runs the story end to end — real
// order, real gateway (mock), real HTTP webhooks, real outbox + queue + SMS —
// against either the naive design or the right one, then checks the damage:
// money, stock, order status and SMS. Finally it cleans up.
// ─────────────────────────────────────────────────────────────────────────────
@Injectable()
export class PaymentLabService {
  constructor(
    private readonly ds: DataSource,
    private readonly lab: LabService,
    private readonly holds: ReservationService,
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
    private readonly gateway: MockGatewayService,
    private readonly webhooks: WebhooksService,
    private readonly sweeper: OrderSweeperService,
    private readonly relay: OutboxRelayService,
    @Inject(ORDER_EVENTS) private readonly queues: OrderEventQueues,
  ) {}

  stories() {
    return PAYMENT_SCENARIOS.map((id) => ({ id, ...STORIES[id] }));
  }

  // An order waiting for payment, with one open attempt. A "bystander" cart
  // also holds 1 unit of the same item, so a double stock release shows up as
  // someone else's hold silently disappearing.
  async prepare() {
    const arm = await this.lab.arm(1, 1, 5);
    const prefix = `lab-${arm.runId}`;
    await this.holds.setQty('pg', `${prefix}-bystander`, arm.storeId, arm.skuIds[0], 1);
    await this.holds.setQty('pg', `${prefix}-buyer`, arm.storeId, arm.skuIds[0], 1);
    const placed = await this.orders.place(`${prefix}-buyer`, `${prefix}-checkout`);
    return { arm, orderId: placed.order.id, totalPaise: placed.order.totalPaise };
  }

  async run(scenario: PaymentScenario, handler: WebhookTarget) {
    if (!PAYMENT_SCENARIOS.includes(scenario)) throw new BadRequestException('unknown scenario');
    const { arm, orderId } = await this.prepare();
    const t0 = Date.now();
    try {
      const target = handler;
      const pastDeadline = () =>
        this.ds.query(`UPDATE orders SET payment_due_at = now() - interval '1 second' WHERE id = $1`, [orderId]);
      const timeout = () => (handler === 'right' ? this.sweeper.runOnce() : this.webhooks.naiveCancel(orderId, 'payment_timeout'));

      if (scenario === 'duplicate') {
        const p = await this.payments.start(orderId);
        await this.gateway.complete(p.paymentRef!, 'success', { chaos: 'duplicate', target });
      }
      if (scenario === 'late-failure') {
        const p1 = await this.payments.start(orderId);
        await this.gateway.complete(p1.paymentRef!, 'failure', { chaos: 'delay', delayMs: 1500, target });
        const p2 = await this.payments.start(orderId); // asks the gateway: try 1 failed -> opens try 2
        await this.gateway.complete(p2.paymentRef!, 'success', { chaos: 'none', target });
      }
      if (scenario === 'lost-webhook') {
        const p = await this.payments.start(orderId);
        await this.gateway.complete(p.paymentRef!, 'success', { chaos: 'lost', target });
        // Pretend time passes: the attempt is old and the deadline is gone.
        await this.ds.query(`UPDATE payments SET created_at = now() - interval '10 minutes' WHERE order_id = $1`, [orderId]);
        await pastDeadline();
        await timeout();
      }
      if (scenario === 'capture-after-timeout') {
        const p = await this.payments.start(orderId);
        await pastDeadline();
        await timeout(); // nobody has paid yet -> cancelled, stock released
        await this.gateway.complete(p.paymentRef!, 'success', { chaos: 'none', target }); // …then the money arrives
      }
      if (scenario === 'forged') {
        const p = await this.payments.start(orderId);
        await this.gateway.sendForged(p.paymentRef!, target);
      }

      await this.gateway.idle();
      await this.settle();
      return { scenario, handler, ...STORIES[scenario], ms: Date.now() - t0, ...(await this.report(arm, orderId)) };
    } finally {
      await this.cleanup(arm);
    }
  }

  // Wait until every event has gone outbox -> queue -> consumer.
  async settle(maxMs = 6000) {
    const until = Date.now() + maxMs;
    while (Date.now() < until) {
      await this.relay.runOnce();
      const [{ n }] = await this.ds.query(`SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL`);
      const c = await this.queues.counts();
      if (!n && !c.waiting && !c.active && !c.delayed && !c.prioritized) return true;
      await sleep(100);
    }
    return false;
  }

  // What actually happened, and what's wrong with it.
  async report(arm: LabArm, orderId: number) {
    const view = await this.orders.get(orderId);
    const status: string = view.order.status;
    const total: number = view.order.totalPaise;

    // Money according to the GATEWAY (the truth), not our copy.
    let charged = 0;
    let refunded = 0;
    for (const p of view.payments) {
      const gw = await this.gateway.getPayment(p.ref);
      if (gw.status === 'captured') charged += gw.amountPaise;
      if (gw.status === 'refunded') refunded += gw.amountPaise;
    }

    // Stock books: original holds + the bystander's 1 + this order's 1 while it's alive.
    const [inv] = await this.ds.query(`SELECT reserved_qty FROM store_inventory WHERE store_id = $1 AND sku_id = $2`, [arm.storeId, arm.skuIds[0]]);
    const live = status !== 'CANCELLED';
    const expected = arm.originals[0].reserved + 1 + (live ? 1 : 0);
    const stockOff = inv.reserved_qty - expected;

    const sms: string[] = view.notifications.map((n: any) => n.body);
    const confirmedSms = sms.filter((b) => b.includes('confirmed!')).length;
    const confirmations = view.timeline.filter((t: any) => t.to === 'CONFIRMED').length;
    const refs = new Set(view.payments.map((p: any) => p.ref));
    const deliveries = this.gateway.deliveries.filter((d) => refs.has(d.paymentRef));

    const problems: string[] = [];
    if (live && status !== 'PAYMENT_PENDING' && charged === 0) problems.push('Order confirmed but nobody paid for it (a free order)');
    if (!live && charged > 0) problems.push(`Customer charged ${rupees(charged)} for a CANCELLED order, and no refund was made`);
    if (charged > total) problems.push(`Customer charged ${rupees(charged)} for a ${rupees(total)} order`);
    if (stockOff < 0) problems.push(`Stock books are off by ${-stockOff}: that unit will be promised to someone else too (oversell)`);
    if (stockOff > 0) problems.push(`${stockOff} unit(s) stuck as "reserved" for an order that will never ship`);
    if (confirmations > 1) problems.push(`Order marked CONFIRMED ${confirmations} times`);
    if (confirmedSms > 1) problems.push(`Customer got the "confirmed" SMS ${confirmedSms} times`);
    if (status === 'PAYMENT_PENDING' && charged > 0) problems.push('Money was taken but the order is still waiting for payment');

    return {
      order: { id: orderId, status, cancelReason: view.order.cancelReason, totalPaise: total },
      money: { chargedPaise: charged, refundedPaise: refunded },
      stock: { reservedNow: inv.reserved_qty, expected, off: stockOff },
      problems,
      timeline: view.timeline,
      payments: view.payments,
      webhooks: deliveries.map((d) => ({ eventId: d.eventId, type: d.type, http: d.httpStatus, result: d.result, forged: !!d.forged, attempt: d.attempt })),
      sms,
    };
  }

  // Put stock back exactly as before, and retire the lab order so later
  // chapters (store packing) never pick it up.
  async cleanup(arm: LabArm) {
    const prefix = `lab-${arm.runId}-`;
    await this.ds.query(
      `UPDATE orders SET status = 'CANCELLED', cancel_reason = 'lab_cleanup', updated_at = now()
       WHERE customer_ref LIKE $1 AND status <> 'CANCELLED'`,
      [prefix + '%'],
    );
    await this.lab.finish(arm);
  }
}
