// Chapter 3 claims, checked against real Postgres + Redis.
// Every test arms its own SKU through the lab (exact stock, known start) and
// uses cart ids starting with lab-{runId}-, so lab.finish() puts it all back.
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { REDIS } from '../src/redis/redis.module';
import { stockKey } from '../src/inventory/inventory.constants';
import { LabArm, LabService } from '../src/cart/lab.service';
import { ReservationService } from '../src/cart/reservation.service';

describe('Chapter 3 — cart holds and overselling', () => {
  let app: INestApplication;
  let ds: DataSource;
  let redis: Redis;
  let lab: LabService;
  let holds: ReservationService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication());
    await app.init();
    ds = app.get(DataSource);
    redis = app.get(REDIS);
    lab = app.get(LabService);
    holds = app.get(ReservationService);
  });

  afterAll(() => app.close());

  const pgRow = async (arm: LabArm) =>
    (
      await ds.query(`SELECT on_hand_qty - reserved_qty AS available, reserved_qty FROM store_inventory WHERE store_id = $1 AND sku_id = $2`, [
        arm.storeId,
        arm.skuIds[0],
      ])
    )[0];
  const redisAvailable = async (arm: LabArm) => Number(await redis.hget(stockKey(arm.storeId), String(arm.skuIds[0])));
  const put = (cartId: string, body: object, suffix = '') =>
    request(app.getHttpServer()).put(`/carts/${cartId}/items${suffix}`).send(body);

  it.each(['redis', 'pg'] as const)('%s: 500 buyers at once, 10 units -> exactly 10 sold, never below zero', async (mode) => {
    const r = await lab.run(mode, 500, 10);
    expect(r.accepted).toBe(10);
    expect(r.refused).toBe(490);
    expect(r.errors).toBe(0);
    expect(r.oversold).toBe(0);
    expect(r.lostUpdates).toBe(0);
    expect(r.perSku[0].postgresSaysAvailable).toBe(0);
    expect(r.perSku[0].redisSaysAvailable).toBe(0);
  });

  it('the same race over real HTTP (100 parallel requests, 5 units)', async () => {
    const arm = await lab.arm(1, 1, 5);
    try {
      const sku = { storeId: arm.storeId, skuId: arm.skuIds[0], qty: 1 };
      const res = await Promise.all(Array.from({ length: 100 }, (_, i) => put(`lab-${arm.runId}-${i}`, sku)));
      expect(res.filter((r) => r.status === 200)).toHaveLength(5);
      expect(res.filter((r) => r.status === 409)).toHaveLength(95);
      expect((await pgRow(arm)).available).toBe(0);
    } finally {
      await lab.finish(arm);
    }
  });

  it('"set qty" is idempotent: the same request twice holds stock once', async () => {
    const arm = await lab.arm(1, 1, 10);
    try {
      const body = { storeId: arm.storeId, skuId: arm.skuIds[0], qty: 3 };
      await put(`lab-${arm.runId}-a`, body).expect(200);
      await put(`lab-${arm.runId}-a`, body).expect(200);
      expect((await pgRow(arm)).available).toBe(7);
      expect(await redisAvailable(arm)).toBe(7);
    } finally {
      await lab.finish(arm);
    }
  });

  it('lowering the quantity gives stock back to Postgres and to the Redis copy', async () => {
    const arm = await lab.arm(1, 1, 10);
    try {
      const cart = `lab-${arm.runId}-a`;
      await put(cart, { storeId: arm.storeId, skuId: arm.skuIds[0], qty: 4 }).expect(200);
      const res = await put(cart, { storeId: arm.storeId, skuId: arm.skuIds[0], qty: 1 }).expect(200);
      expect(res.body.qty).toBe(1);
      expect((await pgRow(arm)).available).toBe(9);
      expect(await redisAvailable(arm)).toBe(9);
      await put(cart, { storeId: arm.storeId, skuId: arm.skuIds[0], qty: 0 }).expect(200);
      expect((await pgRow(arm)).available).toBe(10);
    } finally {
      await lab.finish(arm);
    }
  });

  it('asking for more than is left -> 409 OUT_OF_STOCK and nothing changes', async () => {
    const arm = await lab.arm(1, 1, 2);
    try {
      const res = await put(`lab-${arm.runId}-a`, { storeId: arm.storeId, skuId: arm.skuIds[0], qty: 3 }).expect(409);
      expect(res.body.error).toBe('OUT_OF_STOCK');
      expect(res.body.stock).toBe('low:2');
      expect((await pgRow(arm)).available).toBe(2);
      expect(await redisAvailable(arm)).toBe(2);
    } finally {
      await lab.finish(arm);
    }
  });

  it('if the Redis copy is wrong (too optimistic), Postgres still refuses, and Redis gets its unit back', async () => {
    const arm = await lab.arm(1, 1, 1);
    try {
      await put(`lab-${arm.runId}-a`, { storeId: arm.storeId, skuId: arm.skuIds[0], qty: 1 }).expect(200);
      // Simulate drift: Redis thinks there are 100 left; Postgres knows there are 0.
      await redis.hset(stockKey(arm.storeId), String(arm.skuIds[0]), 100);
      const before = holds.stats.refusedByPgAfterGate;
      await put(`lab-${arm.runId}-b`, { storeId: arm.storeId, skuId: arm.skuIds[0], qty: 1 }).expect(409);
      expect(holds.stats.refusedByPgAfterGate).toBe(before + 1);
      expect(await redisAvailable(arm)).toBe(100); // refunded, not left at 99
      expect((await pgRow(arm)).available).toBe(0); // the truth never moved
    } finally {
      await lab.finish(arm);
    }
  });

  it('an abandoned cart expires: the sweeper gives the stock back everywhere', async () => {
    const arm = await lab.arm(1, 1, 10);
    try {
      const cart = `lab-${arm.runId}-a`;
      await put(cart, { storeId: arm.storeId, skuId: arm.skuIds[0], qty: 4 }).expect(200);
      expect((await request(app.getHttpServer()).get(`/carts/${cart}`)).body.units).toBe(4);

      await ds.query(`UPDATE reservations SET expires_at = now() - interval '1 second' WHERE cart_id = $1`, [cart]);
      await holds.sweep();

      expect((await pgRow(arm)).available).toBe(10);
      expect(await redisAvailable(arm)).toBe(10);
      expect((await request(app.getHttpServer()).get(`/carts/${cart}`)).body.units).toBe(0);
      const [{ status }] = await ds.query(`SELECT status FROM reservations WHERE cart_id = $1`, [cart]);
      expect(status).toBe('expired');
    } finally {
      await lab.finish(arm);
    }
  });

  it('two sweepers at once (two pods) never release the same hold twice', async () => {
    const arm = await lab.arm(1, 1, 100);
    try {
      for (let i = 0; i < 60; i++) await holds.setQty('pg', `lab-${arm.runId}-${i}`, arm.storeId, arm.skuIds[0], 1);
      expect((await pgRow(arm)).available).toBe(40);
      await ds.query(`UPDATE reservations SET expires_at = now() - interval '1 second' WHERE cart_id LIKE $1`, [`lab-${arm.runId}-%`]);

      const [a, b] = await Promise.all([holds.sweep(), holds.sweep()]);
      // Split between them, never 120. (<= because a running API's own
      // background sweeper may legitimately take some of them too.)
      expect(a.expired + b.expired).toBeLessThanOrEqual(60);
      // The real proof: stock came back exactly once, not twice.
      expect((await pgRow(arm)).available).toBe(100);
      expect((await pgRow(arm)).reserved_qty).toBe(arm.originals[0].reserved);
      expect(await redisAvailable(arm)).toBe(100);
    } finally {
      await lab.finish(arm);
    }
  });

  it('a cart being edited right now is skipped by the sweeper (SKIP LOCKED), not released under it', async () => {
    const arm = await lab.arm(1, 1, 10);
    const qr = ds.createQueryRunner();
    try {
      const cart = `lab-${arm.runId}-a`;
      await holds.setQty('pg', cart, arm.storeId, arm.skuIds[0], 2);
      await ds.query(`UPDATE reservations SET expires_at = now() - interval '1 second' WHERE cart_id = $1`, [cart]);

      // Pretend the customer's request is mid-edit: it holds the row lock.
      await qr.connect();
      await qr.startTransaction();
      await qr.query(`SELECT 1 FROM reservations WHERE cart_id = $1 FOR UPDATE`, [cart]);

      expect((await holds.sweep()).expired).toBe(0); // skipped, didn't wait or steal it
      await qr.rollbackTransaction();
      await holds.sweep(); // next round picks it up (or a running API's sweeper already did)
      expect((await pgRow(arm)).available).toBe(10);
      const [{ status }] = await ds.query(`SELECT status FROM reservations WHERE cart_id = $1`, [cart]);
      expect(status).toBe('expired');
    } finally {
      await qr.release();
      await lab.finish(arm);
    }
  });
});
