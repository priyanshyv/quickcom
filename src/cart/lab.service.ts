import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { randomBytes } from 'crypto';
import { REDIS } from '../redis/redis.module';
import { LoggingService } from '../logging/logging.service';
import { TraceCodes } from '../logging/trace-codes';
import { stockKey } from '../inventory/inventory.constants';
import { StockCacheService } from '../inventory/stock-cache.service';
import { CatalogService } from '../catalog/catalog.service';
import { ReservationService } from './reservation.service';
import { ReserveMode } from './cart.constants';

export interface LabArm {
  runId: string;
  storeId: number;
  units: number;
  skuIds: number[];
  originals: { skuId: number; onHand: number; reserved: number }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// The flash-sale lab (learning only, NOT a production feature).
//
//   arm     pick N SKUs in a store and make exactly `units` of each available
//   (buy)   lots of carts named lab-{runId}-... try to grab 1 each
//   finish  count what really happened, then put everything back as it was
//
// k6 calls arm / finish around its own traffic. The demo page calls run(),
// which does all three in one request with the buyers fired in parallel.
// ─────────────────────────────────────────────────────────────────────────────
@Injectable()
export class LabService {
  constructor(
    private readonly ds: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly log: LoggingService,
    private readonly stock: StockCacheService,
    private readonly catalog: CatalogService,
    private readonly holds: ReservationService,
  ) {}

  async arm(storeId = 1, skus = 1, units = 10): Promise<LabArm> {
    const rows: { sku_id: number; on_hand_qty: number; reserved_qty: number }[] = await this.ds.query(
      `SELECT sku_id, on_hand_qty, reserved_qty FROM store_inventory
       WHERE store_id = $1 ORDER BY sku_id LIMIT $2`,
      [storeId, skus],
    );
    if (!rows.length) throw new BadRequestException('that store has no stock rows');
    const skuIds = rows.map((r) => r.sku_id);
    // available = on_hand - reserved, so on_hand = reserved + units makes
    // exactly `units` available, without disturbing anyone's real cart.
    await this.ds.query(
      `UPDATE store_inventory SET on_hand_qty = reserved_qty + $3, updated_at = now()
       WHERE store_id = $1 AND sku_id = ANY($2)`,
      [storeId, skuIds, units],
    );
    await this.stock.rebuildStore(storeId); // the Redis copy must match before the race starts
    return {
      runId: Date.now().toString(36) + randomBytes(3).toString('hex'),
      storeId,
      units,
      skuIds,
      originals: rows.map((r) => ({ skuId: r.sku_id, onHand: r.on_hand_qty, reserved: r.reserved_qty })),
    };
  }

  async finish(arm: LabArm) {
    const prefix = `lab-${arm.runId}-`;
    const held: { sku_id: number; carts: number; units: number }[] = await this.ds.query(
      `SELECT sku_id, count(*)::int AS carts, coalesce(sum(qty), 0)::int AS units
       FROM reservations
       WHERE cart_id LIKE $1 AND status = 'held' AND store_id = $2
       GROUP BY sku_id`,
      [prefix + '%', arm.storeId],
    );
    const inv: { sku_id: number; on_hand_qty: number; reserved_qty: number }[] = await this.ds.query(
      `SELECT sku_id, on_hand_qty, reserved_qty FROM store_inventory WHERE store_id = $1 AND sku_id = ANY($2)`,
      [arm.storeId, arm.skuIds],
    );
    const redisNow = await this.redis.hmget(stockKey(arm.storeId), ...arm.skuIds.map(String));

    let sold = 0;
    let oversold = 0;
    let lostUpdates = 0;
    const perSku = arm.skuIds.map((skuId, i) => {
      const orig = arm.originals.find((o) => o.skuId === skuId)!;
      const h = held.find((x) => x.sku_id === skuId);
      const row = inv.find((x) => x.sku_id === skuId)!;
      const holds = h?.units ?? 0;
      // How much the reserved counter actually went up. If it's LESS than the
      // number of holds, some updates were lost (the naive bug).
      const counted = row.reserved_qty - orig.reserved;
      sold += holds;
      oversold += Math.max(0, holds - arm.units);
      lostUpdates += Math.max(0, holds - counted);
      return {
        skuId,
        name: this.catalog.get(skuId)?.name ?? `SKU ${skuId}`,
        units: arm.units,
        holds,
        reservedCounterWentUpBy: counted,
        postgresSaysAvailable: row.on_hand_qty - row.reserved_qty,
        redisSaysAvailable: redisNow[i] === null ? null : Number(redisNow[i]),
      };
    });

    // Put everything back exactly as it was before arm().
    await this.ds.transaction(async (m) => {
      await m.query(`DELETE FROM reservations WHERE cart_id LIKE $1`, [prefix + '%']);
      for (const o of arm.originals) {
        await m.query(
          `UPDATE store_inventory SET on_hand_qty = $3, reserved_qty = $4, updated_at = now()
           WHERE store_id = $1 AND sku_id = $2`,
          [arm.storeId, o.skuId, o.onHand, o.reserved],
        );
      }
    });
    await this.stock.rebuildStore(arm.storeId);

    return { runId: arm.runId, unitsOnSale: arm.units * arm.skuIds.length, sold, oversold, lostUpdates, perSku: perSku.slice(0, 5) };
  }

  // One click on the lab page: `buyers` carts all try to take 1 unit at the
  // same moment. Promise.all fires them together; with a 20-connection pool,
  // ~20 run truly at once inside Postgres. That's plenty to show the race.
  async run(mode: ReserveMode, buyers: number, units: number, storeId = 1) {
    const arm = await this.arm(storeId, 1, units);
    const skuId = arm.skuIds[0];
    const t0 = Date.now();
    const results = await Promise.allSettled(
      Array.from({ length: buyers }, (_, i) => this.holds.setQty(mode, `lab-${arm.runId}-${i}`, storeId, skuId, 1)),
    );
    const ms = Date.now() - t0;
    const statusOf = (r: PromiseSettledResult<unknown>) =>
      r.status === 'fulfilled' ? 200 : ((r.reason as any)?.getStatus?.() ?? 500);
    const accepted = results.filter((r) => statusOf(r) === 200).length;
    const refused = results.filter((r) => statusOf(r) === 409).length;
    const errors = results.length - accepted - refused;
    const report = await this.finish(arm);
    const out = { mode, buyers, units, item: report.perSku[0]?.name, accepted, refused, errors, ms, ...report };
    this.log.info(TraceCodes.LAB_FLASH_SALE, { mode, buyers, units, accepted, oversold: report.oversold, ms });
    return out;
  }
}
