// Chapter 4 claims, checked against real Postgres + Redis + BullMQ, with real
// HTTP webhooks from the mock gateway to this app (listening on a random port).
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { REDIS } from '../src/redis/redis.module';
import { stockKey } from '../src/inventory/inventory.constants';
import { StockCacheService } from '../src/inventory/stock-cache.service';
import { LabArm, LabService } from '../src/cart/lab.service';
import { ReservationService } from '../src/cart/reservation.service';
import { MockGatewayService, signWebhook } from '../src/payments/mock-gateway.service';
import { OutboxRelayService } from '../src/outbox/outbox-relay.service';
import { OrderEventsConsumer } from '../src/outbox/order-events.consumer';
import { OrderStateService } from '../src/orders/order-state.service';
import { PAYMENT_SCENARIOS, PaymentLabService } from '../src/orders/payment-lab.service';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const until = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < until) {
    await sleep(100);
    v = await fn();
  }
  return v;
}

describe('Chapter 4 — checkout, payments, state machine, outbox', () => {
  let app: INestApplication;
  let ds: DataSource;
  let redis: Redis;
  let lab: LabService;
  let holds: ReservationService;
  let gateway: MockGatewayService;
  let relay: OutboxRelayService;
  let consumer: OrderEventsConsumer;
  let paymentLab: PaymentLabService;
  let state: OrderStateService;
  let http: any;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication({ rawBody: true }));
    await app.listen(0);
    http = app.getHttpServer();
    ds = app.get(DataSource);
    redis = app.get(REDIS);
    lab = app.get(LabService);
    holds = app.get(ReservationService);
    gateway = app.get(MockGatewayService);
    relay = app.get(OutboxRelayService);
    consumer = app.get(OrderEventsConsumer);
    paymentLab = app.get(PaymentLabService);
    state = app.get(OrderStateService);
    gateway.setWebhookBase(`http://127.0.0.1:${http.address().port}`);
    consumer.start(); // tests run with ROLE=api, so start the queue consumer by hand
  });

  afterAll(() => app.close());

  // A cart with `qty` of one freshly-armed item, ready to check out.
  async function cartWith(qty = 1, units = 10) {
    const arm = await lab.arm(1, 1, units);
    const cartId = `lab-${arm.runId}-buyer`;
    await holds.setQty('pg', cartId, arm.storeId, arm.skuIds[0], qty);
    return { arm, cartId, key: `lab-${arm.runId}-checkout` };
  }
  const reserved = async (arm: LabArm) =>
    (await ds.query(`SELECT reserved_qty FROM store_inventory WHERE store_id = $1 AND sku_id = $2`, [arm.storeId, arm.skuIds[0]]))[0].reserved_qty;
  const order = async (id: number) => (await request(http).get(`/orders/${id}`)).body;
  const place = (cartId: string, key?: string) => {
    const r = request(http).post('/orders').send({ cartId });
    return key ? r.set('Idempotency-Key', key) : r;
  };

  it('checkout turns the holds into an order: prices from Postgres, stock still reserved, cart empty', async () => {
    const { arm, cartId, key } = await cartWith(3);
    const [{ mrp_paise: original }] = await ds.query(`SELECT mrp_paise FROM skus WHERE id = $1`, [arm.skuIds[0]]);
    try {
      // The cached catalog in memory still has the old price; the order must use the truth.
      await ds.query(`UPDATE skus SET mrp_paise = $2 WHERE id = $1`, [arm.skuIds[0], 1234]);
      const before = await reserved(arm);
      const res = await place(cartId, key).expect(201);
      expect(res.body.order.status).toBe('PAYMENT_PENDING');
      expect(res.body.items[0]).toMatchObject({ qty: 3, pricePaise: 1234 });
      expect(res.body.order.itemsTotalPaise).toBe(3702);
      expect(res.body.order.deliveryFeePaise).toBe(2500); // ₹37.02 is below ₹199: ₹25 delivery fee
      expect(res.body.order.totalPaise).toBe(6202);
      expect(await reserved(arm)).toBe(before); // the order owns the hold now
      expect((await request(http).get(`/carts/${cartId}`)).body.items).toHaveLength(0);
    } finally {
      await ds.query(`UPDATE skus SET mrp_paise = $2 WHERE id = $1`, [arm.skuIds[0], original]);
      await paymentLab.cleanup(arm);
    }
  });

  it('Idempotency-Key: 5 identical requests at once -> ONE order; reusing the key elsewhere -> 422; no key -> 400', async () => {
    const { arm, cartId, key } = await cartWith(1);
    try {
      const res = await Promise.all(Array.from({ length: 5 }, () => place(cartId, key)));
      const ids = new Set(res.map((r) => r.body.order.id));
      expect(ids.size).toBe(1);
      expect(res.filter((r) => r.body.replayed === false)).toHaveLength(1);
      const [{ n }] = await ds.query(`SELECT count(*)::int AS n FROM orders WHERE idempotency_key = $1`, [key]);
      expect(n).toBe(1);

      expect((await place(`lab-${arm.runId}-someone-else`, key).expect(422)).body.error).toBe('IDEMPOTENCY_KEY_REUSED');
      expect((await place(cartId).expect(400)).body.error).toBe('IDEMPOTENCY_KEY_REQUIRED');
    } finally {
      await paymentLab.cleanup(arm);
    }
  });

  it('full journey: pay -> signed webhook -> CONFIRMED -> outbox -> queue -> SMS', async () => {
    const { arm, cartId, key } = await cartWith(1);
    try {
      const { body: o } = await place(cartId, key).expect(201);
      const pay1 = await request(http).post(`/orders/${o.order.id}/payments`).expect(201);
      const pay2 = await request(http).post(`/orders/${o.order.id}/payments`).expect(201); // double tap
      expect(pay2.body.paymentRef).toBe(pay1.body.paymentRef);

      await request(http).post(`/mock-gateway/payments/${pay1.body.paymentRef}/complete`).send({ outcome: 'success' }).expect(200);
      await gateway.idle();
      expect((await order(o.order.id)).order.status).toBe('CONFIRMED');

      await relay.runOnce();
      const done = await waitFor(() => order(o.order.id), (v) => v.notifications.length >= 2);
      expect(done.notifications.map((n: any) => n.body).join(' | ')).toMatch(/placed.*confirmed/);
      expect(done.outbox.every((e: any) => e.publishedAt)).toBe(true);
      expect(done.timeline.map((t: any) => t.to)).toEqual(['PAYMENT_PENDING', 'CONFIRMED']);
    } finally {
      await paymentLab.cleanup(arm);
    }
  });

  it('a webhook with a wrong signature is rejected (401) and changes nothing', async () => {
    const { arm, cartId, key } = await cartWith(1);
    try {
      const { body: o } = await place(cartId, key).expect(201);
      const { body: p } = await request(http).post(`/orders/${o.order.id}/payments`).expect(201);
      const body = JSON.stringify({ id: 'evt_fake_1', type: 'payment.captured', created: Date.now(), data: { paymentRef: p.paymentRef, orderId: o.order.id, amountPaise: 1 } });
      await request(http).post('/webhooks/payment').set('content-type', 'application/json').set('x-mock-signature', signWebhook(body, 'wrong')).send(body).expect(401);
      expect((await order(o.order.id)).order.status).toBe('PAYMENT_PENDING');
      expect((await ds.query(`SELECT count(*)::int AS n FROM webhook_events WHERE event_id = 'evt_fake_1'`))[0].n).toBe(0);
    } finally {
      await paymentLab.cleanup(arm);
    }
  });

  it.each(PAYMENT_SCENARIOS)('chaos lab, right design: "%s" ends with no problems', async (scenario) => {
    const r = await paymentLab.run(scenario, 'right');
    expect(r.problems).toEqual([]);
  });

  it('chaos lab catches the naive design (duplicate webhooks -> confirmed 3 times)', async () => {
    const r = await paymentLab.run('duplicate', 'naive');
    expect(r.problems.join(' ')).toMatch(/CONFIRMED 3 times/);
  });

  it('Rx order: paid -> RX_REVIEW; pharmacist rejects -> CANCELLED, stock back, money refunded', async () => {
    // Arm an Rx item by hand (the lab picks the lowest SKU ids, which are OTC).
    const [rx] = await ds.query(
      `SELECT i.sku_id, i.on_hand_qty, i.reserved_qty FROM store_inventory i JOIN skus s ON s.id = i.sku_id
       WHERE i.store_id = 1 AND s.rx_required ORDER BY i.sku_id LIMIT 1`,
    );
    const arm: LabArm = { runId: 'rx' + Date.now().toString(36), storeId: 1, units: 5, skuIds: [rx.sku_id], originals: [{ skuId: rx.sku_id, onHand: rx.on_hand_qty, reserved: rx.reserved_qty }] };
    await ds.query(`UPDATE store_inventory SET on_hand_qty = reserved_qty + 5 WHERE store_id = 1 AND sku_id = $1`, [rx.sku_id]);
    await app.get(StockCacheService).rebuildStore(1);
    try {
      const cartId = `lab-${arm.runId}-buyer`;
      await holds.setQty('pg', cartId, 1, rx.sku_id, 1);
      const { body: o } = await place(cartId, `lab-${arm.runId}-checkout`).expect(201);
      expect(o.order.hasRx).toBe(true);
      const { body: p } = await request(http).post(`/orders/${o.order.id}/payments`).expect(201);
      await gateway.complete(p.paymentRef, 'success');
      await gateway.idle();
      expect((await order(o.order.id)).order.status).toBe('RX_REVIEW');
      expect((await request(http).get('/admin/rx-queue')).body.map((q: any) => q.id)).toContain(o.order.id);

      await request(http).post(`/admin/orders/${o.order.id}/rx`).send({ approve: false, note: 'no valid prescription' }).expect(200);
      expect((await order(o.order.id)).order.status).toBe('CANCELLED');
      expect(await reserved(arm)).toBe(rx.reserved_qty); // stock back
      await relay.runOnce();
      const refunded = await waitFor(() => gateway.getPayment(p.paymentRef), (g) => g.status === 'refunded');
      expect(refunded.status).toBe('refunded');
      // Pharmacist can't act on an order that isn't waiting for them.
      await request(http).post(`/admin/orders/${o.order.id}/rx`).send({ approve: true }).expect(409);
    } finally {
      await paymentLab.cleanup(arm);
    }
  });

  it('the state machine refuses arrows that are not in the table (CANCELLED -> CONFIRMED)', async () => {
    const { arm, cartId, key } = await cartWith(1);
    try {
      const { body: o } = await place(cartId, key).expect(201);
      await request(http).post(`/orders/${o.order.id}/cancel`).send({ cartId }).expect(200);
      await expect(
        ds.transaction((m) => state.transition(m, o.order.id, 'CONFIRMED', { reason: 'test', actor: 'test' })),
      ).rejects.toMatchObject({ response: { error: 'INVALID_TRANSITION' } });
    } finally {
      await paymentLab.cleanup(arm);
    }
  });

  it('customer cancels a paid order: stock released once, refund requested once, consumer is idempotent', async () => {
    const { arm, cartId, key } = await cartWith(2);
    try {
      const before = await reserved(arm);
      const { body: o } = await place(cartId, key).expect(201);
      const { body: p } = await request(http).post(`/orders/${o.order.id}/payments`).expect(201);
      await gateway.complete(p.paymentRef, 'success');
      await gateway.idle();
      await request(http).post(`/orders/${o.order.id}/cancel`).send({ cartId }).expect(200);
      await request(http).post(`/orders/${o.order.id}/cancel`).send({ cartId }).expect(200); // twice: no-op
      expect(await reserved(arm)).toBe(before - 2);
      expect(Number(await redis.hget(stockKey(1), String(arm.skuIds[0])))).toBe(10);

      await relay.runOnce();
      await waitFor(() => gateway.getPayment(p.paymentRef), (g) => g.status === 'refunded');
      // Deliver the refund event to the consumer AGAIN by hand: nothing new happens.
      const [evt] = await ds.query(`SELECT id, payload FROM outbox WHERE order_id = $1 AND event_type = 'refund.requested'`, [o.order.id]);
      const smsBefore = (await order(o.order.id)).notifications.length;
      await consumer.handle({ eventId: Number(evt.id), orderId: o.order.id, type: 'refund.requested', payload: evt.payload });
      expect((await order(o.order.id)).notifications.length).toBe(smsBefore);
      const [{ n }] = await ds.query(`SELECT count(*)::int AS n FROM outbox WHERE order_id = $1 AND event_type = 'refund.requested'`, [o.order.id]);
      expect(n).toBe(1);
    } finally {
      await paymentLab.cleanup(arm);
    }
  });

  it('outbox: the event is saved with the change even if nothing publishes it yet; the relay publishes it once', async () => {
    const { arm, cartId, key } = await cartWith(1);
    try {
      const { body: o } = await place(cartId, key).expect(201);
      const pending = await ds.query(`SELECT id FROM outbox WHERE order_id = $1 AND published_at IS NULL`, [o.order.id]);
      // (A running API's own relay may already have taken it; either way it exists.)
      const all = await ds.query(`SELECT id, published_at FROM outbox WHERE order_id = $1`, [o.order.id]);
      expect(all).toHaveLength(1);
      expect(pending.length).toBeLessThanOrEqual(1);
      await relay.runOnce();
      await relay.runOnce(); // a second run finds nothing new
      const after = await ds.query(`SELECT published_at FROM outbox WHERE order_id = $1`, [o.order.id]);
      expect(after[0].published_at).not.toBeNull();
      const sms = await waitFor(() => order(o.order.id), (v) => v.notifications.length >= 1);
      expect(sms.notifications).toHaveLength(1);
    } finally {
      await paymentLab.cleanup(arm);
    }
  });

  it('the stock books balance: every reserved unit belongs to a live hold or a live order', async () => {
    const [r] = await ds.query(`
      WITH owed AS (
        SELECT store_id, sku_id, sum(qty)::int AS q FROM (
          SELECT store_id, sku_id, qty FROM reservations WHERE status = 'held'
          UNION ALL
          SELECT o.store_id, i.sku_id, i.qty FROM order_items i JOIN orders o ON o.id = i.order_id
          WHERE o.status IN ('PAYMENT_PENDING', 'RX_REVIEW', 'CONFIRMED')
        ) x GROUP BY 1, 2)
      SELECT count(*) FILTER (WHERE i.reserved_qty <> coalesce(o.q, 0))::int AS mismatched
      FROM store_inventory i LEFT JOIN owed o USING (store_id, sku_id)`);
    expect(r.mismatched).toBe(0);
  });
});
