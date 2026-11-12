// Chapter 2 claims, checked against real Postgres + Redis.
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { REDIS } from '../src/redis/redis.module';
import { stockKey } from '../src/inventory/inventory.constants';

const FORUM_MALL = '/home?lat=12.9346&lng=77.6113'; // served by store 1 (BLR-KOR)

describe('Chapter 2 — catalog + per-store stock', () => {
  let app: INestApplication;
  let ds: DataSource;
  let redis: Redis;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication());
    await app.init();
    ds = app.get(DataSource);
    redis = app.get(REDIS);
  });

  afterAll(() => app.close());

  const findItem = (body: any, skuId: number) =>
    body.sections.flatMap((s: any) => s.items).find((i: any) => i.id === skuId);

  it('the cached home screen and the naive (all-Postgres) one return the same items', async () => {
    const fast = await request(app.getHttpServer()).get(FORUM_MALL).expect(200);
    const slow = await request(app.getHttpServer()).get(FORUM_MALL.replace('/home', '/home/naive')).expect(200);
    expect(fast.body.location.store.code).toBe('BLR-KOR');
    expect(fast.body.sections).toEqual(slow.body.sections);
  });

  it('shows only what THIS store carries, and never the exact quantity', async () => {
    const res = await request(app.getHttpServer()).get(FORUM_MALL).expect(200);
    const items = res.body.sections.flatMap((s: any) => s.items);
    const [{ n }] = await ds.query(`SELECT count(*)::int AS n FROM store_inventory WHERE store_id = 1`);
    expect(items).toHaveLength(n);
    for (const it of items) {
      expect(it).not.toHaveProperty('available');
      expect(it.stock).toMatch(/^(in|out|low:[1-5])$/);
    }
  });

  it('write path: restocking updates Postgres AND the home screen immediately', async () => {
    const [{ sku_id: skuId, on_hand_qty: original }] = await ds.query(
      `SELECT sku_id, on_hand_qty FROM store_inventory WHERE store_id = 1 ORDER BY sku_id LIMIT 1`,
    );
    try {
      await request(app.getHttpServer()).post('/admin/stores/1/stock').send({ skuId, onHand: 0 }).expect(201);
      expect(findItem((await request(app.getHttpServer()).get(FORUM_MALL)).body, skuId).stock).toBe('out');

      await request(app.getHttpServer()).post('/admin/stores/1/stock').send({ skuId, onHand: 3 }).expect(201);
      expect(findItem((await request(app.getHttpServer()).get(FORUM_MALL)).body, skuId).stock).toBe('low:3');

      const [{ on_hand_qty }] = await ds.query(`SELECT on_hand_qty FROM store_inventory WHERE store_id = 1 AND sku_id = $1`, [skuId]);
      expect(on_hand_qty).toBe(3);
    } finally {
      await request(app.getHttpServer()).post('/admin/stores/1/stock').send({ skuId, onHand: original }).expect(201);
    }
  });

  it('drift repair: if the Redis copy is wiped or wrong, a rebuild restores it from Postgres', async () => {
    const before = await redis.hgetall(stockKey(1));
    await redis.del(stockKey(1));
    const [{ sku_id, a }] = await ds.query(
      `SELECT sku_id, on_hand_qty - reserved_qty AS a FROM store_inventory WHERE store_id = 2 ORDER BY sku_id LIMIT 1`,
    );
    await redis.hset(stockKey(2), sku_id, '-999'); // corrupt another store
    await request(app.getHttpServer()).post('/admin/stock/rebuild').expect(201);
    expect(await redis.hgetall(stockKey(1))).toEqual(before);
    expect(await redis.hget(stockKey(2), String(sku_id))).toBe(String(a));
  });

  it('catalog: ETag + Cache-Control, and a 304 with an empty body when nothing changed', async () => {
    const first = await request(app.getHttpServer()).get('/catalog').expect(200);
    expect(first.headers['cache-control']).toContain('max-age=300');
    const etag = first.headers.etag;
    const again = await request(app.getHttpServer()).get('/catalog').set('If-None-Match', etag).expect(304);
    expect(again.text).toBe('');
  });

  it('not serviceable -> no sections at all', async () => {
    const res = await request(app.getHttpServer()).get('/home?lat=12.9756&lng=77.6066').expect(200);
    expect(res.body.location.serviceable).toBe(false);
    expect(res.body.sections).toBeUndefined();
  });
});
