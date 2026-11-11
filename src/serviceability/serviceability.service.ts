import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';
import { LoggingService } from '../logging/logging.service';
import { TraceCodes } from '../logging/trace-codes';
import { geohashEncode, haversineMeters, pointInRing } from './geohash';
import { promiseMinutes } from './promise';
import { SVC_CACHE_TTL_SECONDS, SVC_GEOHASH_PRECISION, SVC_VERSION_KEY, SVC_VERSION_POLL_MS, svcCellKey } from './serviceability.constants';

export interface StoreRef {
  id: number;
  code: string;
  name: string;
  lat: number;
  lng: number;
}

export interface ServiceabilityResult {
  serviceable: boolean;
  store?: { id: number; code: string; name: string };
  distanceMeters?: number;
  promiseMinutes?: number;
  // other stores that ALSO cover this point (overlap zones like KOR/HSR)
  alternatives?: string[];
  // how we got the answer — only for learning/debugging
  via: 'naive' | 'postgis' | 'cache-hit' | 'cache-miss' | 'cache-edge';
  cell?: string;
}

// What we store in Redis for one geohash cell.
interface CellEntry {
  // stores whose delivery polygon touches this cell at all
  candidates: (StoreRef & { coversWholeCell: boolean })[];
}

@Injectable()
export class ServiceabilityService implements OnModuleInit, OnModuleDestroy {
  // Bumped (in Redis) whenever ops change a store or polygon. Part of every
  // cache key, so a bump makes ALL old cache entries unreachable at once.
  private version = '0';
  private versionTimer: NodeJS.Timeout;

  // Per-process counters so you can SEE the hit rate during a load test.
  readonly stats = { hit: 0, miss: 0, edge: 0, naive: 0, postgis: 0 };

  constructor(
    private readonly ds: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly log: LoggingService,
  ) {}

  async onModuleInit() {
    await this.refreshVersion();
    // Every pod polls the version every few seconds. Cost: 1 tiny Redis GET
    // per pod per 5 s — instead of 1 extra GET on every single request.
    this.versionTimer = setInterval(() => this.refreshVersion().catch(() => undefined), SVC_VERSION_POLL_MS);
    this.versionTimer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.versionTimer);
  }

  async refreshVersion() {
    const v = (await this.redis.get(SVC_VERSION_KEY)) ?? '0';
    if (v !== this.version) {
      this.log.info(TraceCodes.SVC_VERSION_CHANGED, { from: this.version, to: v });
      this.version = v;
    }
  }

  // Called by the admin endpoint after a store/polygon change.
  async bumpVersion(): Promise<string> {
    this.version = String(await this.redis.incr(SVC_VERSION_KEY));
    return this.version;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // WRONG VERSION #1 — "naive"
  // Fetch EVERY store polygon from Postgres on EVERY request and test them in
  // JavaScript. Works with 8 stores. With 500 stores (all of India) you'd be
  // shipping ~500 polygons x ~33 points over the network for each app open.
  // ─────────────────────────────────────────────────────────────────────────
  async findNaive(lat: number, lng: number): Promise<ServiceabilityResult> {
    this.stats.naive++;
    const rows: any[] = await this.ds.query(`
      SELECT id, code, name,
             ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng,
             ST_AsGeoJSON(service_area)::json AS area
      FROM stores WHERE is_active`);
    const covering = rows
      .filter((r) => pointInRing(lat, lng, r.area.coordinates[0]))
      .map((r) => ({ id: r.id, code: r.code, name: r.name, lat: r.lat, lng: r.lng }));
    return this.pickNearest(lat, lng, covering, 'naive');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CORRECT BUT EXPENSIVE — "postgis"
  // Let the database do the geometry, using the GIST spatial index. Correct
  // and fast per query... but it's still one Postgres query per app open, and
  // the app is opened ~300x more often than an order is placed (chapter 0).
  // ─────────────────────────────────────────────────────────────────────────
  async findPostgis(lat: number, lng: number): Promise<ServiceabilityResult> {
    this.stats.postgis++;
    const rows: StoreRef[] = await this.ds.query(
      `SELECT id, code, name, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
       FROM stores
       WHERE is_active
         AND ST_Covers(service_area, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography)`,
      [lat, lng],
    );
    return this.pickNearest(lat, lng, rows, 'postgis');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RIGHT VERSION — "cached by geohash cell"
  //
  // 1. point -> geohash cell (~153 m box). Pure CPU, no I/O.
  // 2. Redis GET svc:v{version}:{cell}
  // 3. Miss: ask PostGIS ONCE for "which polygons touch this box, and does
  //    each one cover the WHOLE box?", store it for an hour.
  // 4. For each candidate store:
  //      covers the whole box -> the point is definitely inside. Done.
  //      only covers PART of the box (an "edge cell" on a polygon border)
  //        -> the box alone can't answer; check the exact point with PostGIS.
  //
  // Edge cells are a thin ring along each polygon's border, so most requests
  // never touch Postgres. "Not serviceable" is cached too (negative caching):
  // people in a gap like MG Road reopen the app again and again.
  // ─────────────────────────────────────────────────────────────────────────
  async findCached(lat: number, lng: number): Promise<ServiceabilityResult> {
    const cell = geohashEncode(lat, lng, SVC_GEOHASH_PRECISION);
    const key = svcCellKey(this.version, cell);

    let entry: CellEntry;
    let via: ServiceabilityResult['via'] = 'cache-hit';
    const raw = await this.redis.get(key);
    if (raw) {
      this.stats.hit++;
      entry = JSON.parse(raw);
    } else {
      this.stats.miss++;
      via = 'cache-miss';
      entry = await this.loadCell(cell);
      await this.redis.set(key, JSON.stringify(entry), 'EX', SVC_CACHE_TTL_SECONDS);
    }

    const sure = entry.candidates.filter((c) => c.coversWholeCell);
    const unsure = entry.candidates.filter((c) => !c.coversWholeCell);
    let covering: StoreRef[] = sure;

    if (unsure.length) {
      this.stats.edge++;
      if (via === 'cache-hit') via = 'cache-edge';
      const exact: { id: number }[] = await this.ds.query(
        `SELECT id FROM stores
         WHERE id = ANY($3)
           AND ST_Covers(service_area, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography)`,
        [lat, lng, unsure.map((u) => u.id)],
      );
      const ok = new Set(exact.map((e) => e.id));
      covering = [...sure, ...unsure.filter((u) => ok.has(u.id))];
    }

    return { ...this.pickNearest(lat, lng, covering, via), cell };
  }

  private async loadCell(cell: string): Promise<CellEntry> {
    // ST_GeomFromGeoHash turns the cell name back into its box polygon.
    const rows: any[] = await this.ds.query(
      `WITH c AS (SELECT ST_GeomFromGeoHash($1)::geography AS box)
       SELECT s.id, s.code, s.name,
              ST_Y(s.location::geometry) AS lat, ST_X(s.location::geometry) AS lng,
              ST_Covers(s.service_area, c.box) AS "coversWholeCell"
       FROM stores s, c
       WHERE s.is_active AND ST_Intersects(s.service_area, c.box)`,
      [cell],
    );
    return { candidates: rows };
  }

  // When several stores cover you (overlap zones), pick the closest one.
  // Chapter 5 makes this smarter: skip a store that's overloaded right now.
  private pickNearest(lat: number, lng: number, stores: StoreRef[], via: ServiceabilityResult['via']): ServiceabilityResult {
    if (!stores.length) return { serviceable: false, via };
    const ranked = stores
      .map((s) => ({ s, d: haversineMeters(lat, lng, s.lat, s.lng) }))
      .sort((a, b) => a.d - b.d);
    const best = ranked[0];
    return {
      serviceable: true,
      store: { id: best.s.id, code: best.s.code, name: best.s.name },
      distanceMeters: Math.round(best.d),
      promiseMinutes: promiseMinutes(best.d),
      alternatives: ranked.slice(1).map((r) => r.s.code),
      via,
    };
  }
}
