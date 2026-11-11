// Phase 0 facts, checked against the REAL Postgres + Redis (no mocks).
//. Needs: npm run db:up && npm run db:reset
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

describe('Phase 0 — foundation', () => {
  let app: INestApplication;
  let ds: DataSource;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication());
    await app.init();
    ds = app.get(DataSource);
  });

  afterAll(() => app.close());

  it('health: Postgres (with PostGIS) and Redis are both reachable', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.postgres.ok).toBe(true);
    expect(res.body.postgres.postgis).toMatch(/^3\./);
    expect(res.body.redis.ok).toBe(true);
  });

  it('city map: 8 Bangalore stores, each with a polygon and a centre point', async () => {
    const res = await request(app.getHttpServer()).get('/stores').expect(200);
    const stores = res.body.features.filter((f) => f.properties.kind === 'store');
    const areas = res.body.features.filter((f) => f.properties.kind === 'service_area');
    expect(stores).toHaveLength(8);
    expect(areas).toHaveLength(8);
    expect(areas[0].geometry.type).toBe('Polygon');
  });

  it('every store sits inside its own delivery polygon, ~28 km² (3 km radius)', async () => {
    const rows = await ds.query(
      `SELECT code, ST_Covers(service_area, location) AS ok, ST_Area(service_area) / 1e6 AS km2 FROM stores`,
    );
    for (const r of rows) {
      expect(r.ok).toBe(true);
      // a perfect circle would be pi*3^2 = 28.27 km²; the polygon has 32 sides
      expect(Number(r.km2)).toBeGreaterThan(27.5);
      expect(Number(r.km2)).toBeLessThan(28.3);
    }
  });

  it('geography: MG Road falls in a gap (not serviceable), Forum Mall is Koramangala', async () => {
    const at = (lat: number, lng: number) =>
      ds.query(
        `SELECT code FROM stores WHERE ST_Covers(service_area, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography)`,
        [lat, lng],
      );
    expect(await at(12.9756, 77.6066)).toEqual([]);
    expect((await at(12.9346, 77.6113)).map((r) => r.code)).toEqual(['BLR-KOR']);
  });

  it('inventory: one row per (store, sku), nothing negative, nothing reserved yet', async () => {
    const [r] = await ds.query(`
      SELECT count(*)::int AS rows,
             count(DISTINCT (store_id, sku_id))::int AS distinct_pairs,
             min(on_hand_qty) AS min_on_hand,
             sum(reserved_qty)::int AS reserved
      FROM store_inventory`);
    expect(r.rows).toBe(r.distinct_pairs);
    expect(r.min_on_hand).toBeGreaterThanOrEqual(0);
    expect(r.reserved).toBe(0);
  });
});
