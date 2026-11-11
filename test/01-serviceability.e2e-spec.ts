// Chapter 1 claims, checked against real Postgres + Redis.
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { ServiceabilityService } from '../src/serviceability/serviceability.service';
import { geohashEncode } from '../src/serviceability/geohash';

const FORUM_MALL = { lat: 12.9346, lng: 77.6113 };
const MG_ROAD = { lat: 12.9756, lng: 77.6066 };
const KOR_HSR_OVERLAP = { lat: 12.925, lng: 77.635 };

describe('Chapter 1 — serviceability', () => {
  let app: INestApplication;
  let ds: DataSource;
  let svc: ServiceabilityService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication());
    await app.init();
    ds = app.get(DataSource);
    svc = app.get(ServiceabilityService);
    await svc.bumpVersion(); // start from an empty cache
  });

  afterAll(() => app.close());

  it('our JS geohash is byte-for-byte the same as PostGIS ST_GeoHash', async () => {
    const pts = [FORUM_MALL, MG_ROAD, KOR_HSR_OVERLAP, { lat: 12.8452, lng: 77.6602 }];
    for (const p of pts) {
      const [{ gh }] = await ds.query(`SELECT ST_GeoHash(ST_SetSRID(ST_MakePoint($2,$1),4326), 7) AS gh`, [p.lat, p.lng]);
      expect(geohashEncode(p.lat, p.lng, 7)).toBe(gh);
    }
  });

  it('Forum Mall -> Koramangala; the second call is served from the cache', async () => {
    const q = `/serviceability?lat=${FORUM_MALL.lat}&lng=${FORUM_MALL.lng}`;
    const first = await request(app.getHttpServer()).get(q).expect(200);
    const second = await request(app.getHttpServer()).get(q).expect(200);
    expect(first.body.store.code).toBe('BLR-KOR');
    expect(first.body.via).toBe('cache-miss');
    expect(second.body.via).toMatch(/cache-(hit|edge)/);
    expect(second.body.promiseMinutes).toBeGreaterThan(0);
  });

  it('MG Road is not serviceable — and that "no" is cached too', async () => {
    const q = `/serviceability?lat=${MG_ROAD.lat}&lng=${MG_ROAD.lng}`;
    await request(app.getHttpServer()).get(q).expect(200);
    const res = await request(app.getHttpServer()).get(q).expect(200);
    expect(res.body).toMatchObject({ serviceable: false, via: 'cache-hit' });
  });

  it('overlap zone: picks the nearest store and lists the other as an alternative', async () => {
    const res = await request(app.getHttpServer())
      .get(`/serviceability?lat=${KOR_HSR_OVERLAP.lat}&lng=${KOR_HSR_OVERLAP.lng}`)
      .expect(200);
    expect(res.body.store.code).toBe('BLR-KOR');
    expect(res.body.alternatives).toEqual(['BLR-HSR']);
  });

  // The most important test: a cache must never change the answer.
  // 2,000 random points across Bangalore, including many on polygon borders.
  it('cached answer == PostGIS answer for 2,000 random BLR points (incl. edge cells)', async () => {
    let s = 42;
    const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let edges = 0;
    for (let i = 0; i < 2000; i++) {
      const lat = 12.82 + rand() * 0.24;
      const lng = 77.54 + rand() * 0.24;
      const exact = await svc.findPostgis(lat, lng);
      const cached = await svc.findCached(lat, lng);
      if (cached.via === 'cache-edge') edges++;
      expect(cached.serviceable).toBe(exact.serviceable);
      expect(cached.store?.code).toBe(exact.store?.code);
      expect(cached.alternatives ?? []).toEqual(exact.alternatives ?? []);
    }
    // edge cells exist (otherwise this test wouldn't prove much) but are rare
    expect(edges).toBeGreaterThan(0);
  });

  it('turning a store off takes effect immediately via the version bump', async () => {
    const q = `/serviceability?lat=${FORUM_MALL.lat}&lng=${FORUM_MALL.lng}`;
    await request(app.getHttpServer()).get(q).expect(200); // warm the cache
    try {
      await request(app.getHttpServer()).patch('/admin/stores/1/active').send({ isActive: false }).expect(200);
      const off = await request(app.getHttpServer()).get(q).expect(200);
      expect(off.body.serviceable).toBe(false); // nobody else covers Forum Mall
      expect(off.body.via).toBe('cache-miss'); // new version = fresh lookup
    } finally {
      await request(app.getHttpServer()).patch('/admin/stores/1/active').send({ isActive: true }).expect(200);
    }
    const on = await request(app.getHttpServer()).get(q).expect(200);
    expect(on.body.store.code).toBe('BLR-KOR');
  });

  it('rejects garbage coordinates', async () => {
    await request(app.getHttpServer()).get('/serviceability?lat=abc&lng=77.6').expect(400);
    await request(app.getHttpServer()).get('/serviceability?lat=95&lng=77.6').expect(400);
  });
});
