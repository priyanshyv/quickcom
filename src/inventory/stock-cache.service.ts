import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';
import { LoggingService } from '../logging/logging.service';
import { TraceCodes } from '../logging/trace-codes';
import { LOW_STOCK_THRESHOLD, stockKey } from './inventory.constants';

export type StockBadge = 'in' | 'out' | `low:${number}`;

// Live stock for the home screen.
//
//   Redis hash  stock:{storeId}   field = skuId   value = available (on_hand - reserved)
//
// Postgres is the TRUTH. This hash is a COPY shaped for one job: "give me
// every SKU's availability for store 3" in ONE Redis call (HGETALL), ~0.5 ms,
// without touching Postgres. The home screen is the most-hit screen in the app;
// if it reads stock from Postgres, Postgres becomes the bottleneck for browsing.
//
// Keeping a copy means it can DRIFT from the truth (a Redis write fails, a
// deploy dies halfway). So we always have a way to rebuild it from Postgres —
// the same idea as the reconciliation jobs every inventory system needs.
@Injectable()
export class StockCacheService implements OnApplicationBootstrap {
  constructor(
    private readonly ds: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly log: LoggingService,
  ) {}

  // On boot, fill any store whose hash is missing (e.g. Redis was restarted).
  // If 5 pods boot at once, all 5 may rebuild — harmless, because the rebuild
  // is idempotent (it replaces the whole hash with the same truth).
  async onApplicationBootstrap() {
    const stores: { id: number }[] = await this.ds.query(`SELECT id FROM stores`);
    for (const { id } of stores) {
      if (!(await this.redis.exists(stockKey(id)))) await this.rebuildStore(id);
    }
  }

  async rebuildStore(storeId: number): Promise<number> {
    const rows: { sku_id: number; available: number }[] = await this.ds.query(
      `SELECT sku_id, on_hand_qty - reserved_qty AS available FROM store_inventory WHERE store_id = $1`,
      [storeId],
    );
    const flat: (string | number)[] = rows.flatMap((r) => [r.sku_id, r.available]);
    // MULTI = all-or-nothing. Readers see either the old hash or the new one,
    // never a half-deleted one.
    const tx = this.redis.multi().del(stockKey(storeId));
    if (flat.length) tx.hset(stockKey(storeId), ...flat);
    await tx.exec();
    this.log.info(TraceCodes.STOCK_CACHE_REBUILT, { storeId, skus: rows.length });
    return rows.length;
  }

  async rebuildAll() {
    const stores: { id: number }[] = await this.ds.query(`SELECT id FROM stores ORDER BY id`);
    let skus = 0;
    for (const { id } of stores) skus += await this.rebuildStore(id);
    return { stores: stores.length, skus };
  }

  async availableForStore(storeId: number): Promise<Map<number, number>> {
    const h = await this.redis.hgetall(stockKey(storeId));
    return new Map(Object.entries(h).map(([k, v]) => [Number(k), Number(v)]));
  }

  // ── The write path ─────────────────────────────────────────────────────────
  // A delivery arrived (a GRN, goods received note), or someone counted the shelf.
  //   1. write the truth to Postgres
  //   2. copy the NEW value (returned by Postgres itself) into Redis
  // Order matters: if step 2 fails, Redis is stale but Postgres is right, and
  // a rebuild fixes it. The other order could leave Redis claiming stock that
  // Postgres never recorded.
  async setOnHand(storeId: number, skuId: number, onHand: number) {
    const [row] = await this.ds.query(
      `INSERT INTO store_inventory (store_id, sku_id, on_hand_qty)
       VALUES ($1, $2, $3)
       ON CONFLICT (store_id, sku_id)
       DO UPDATE SET on_hand_qty = EXCLUDED.on_hand_qty, updated_at = now()
       RETURNING on_hand_qty - reserved_qty AS available`,
      [storeId, skuId, onHand],
    );
    try {
      await this.redis.hset(stockKey(storeId), skuId, row.available);
    } catch (err) {
      this.log.error(TraceCodes.STOCK_CACHE_WRITE_FAILED, err, { storeId, skuId });
    }
    return { storeId, skuId, available: row.available };
  }

  // Never send exact quantities to the app:
  //   - competitors scrape them to learn your sales,
  //   - the number is stale the moment it leaves the server anyway.
  // Show "only 3 left" when it's low (it nudges people to buy), else just "in".
  static badge(available: number | undefined): StockBadge | undefined {
    if (available === undefined) return undefined; // store doesn't carry it
    if (available <= 0) return 'out';
    if (available <= LOW_STOCK_THRESHOLD) return `low:${available}`;
    return 'in';
  }
}
