import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';
import { LoggingService } from '../logging/logging.service';
import { TraceCodes } from '../logging/trace-codes';
import { stockKey } from '../inventory/inventory.constants';
import { StockBadge, StockCacheService } from '../inventory/stock-cache.service';
import { CatalogService } from '../catalog/catalog.service';
import {
  CART_ID_PATTERN,
  HOLD_SECONDS,
  ReserveMode,
  STOCK_GATE_LUA,
  SWEEP_BATCH,
  SWEEP_INTERVAL_MS,
} from './cart.constants';

export interface HoldResult {
  cartId: string;
  storeId: number;
  skuId: number;
  qty: number;
  stock: StockBadge; // what the badge for this item says now
  expiresAt: string | null; // when this hold runs out (null when qty = 0)
  mode: ReserveMode;
}

// TypeORM hands back UPDATE/DELETE ... RETURNING as [rows, count], but
// SELECT/INSERT as plain rows. This smooths that over.
const rowsOf = (res: any): any[] => (Array.isArray(res) && Array.isArray(res[0]) ? res[0] : res);

// ─────────────────────────────────────────────────────────────────────────────
// Chapter 3: "Add to cart" = put a HOLD on stock so two people can't buy the
// same last strip.
//
//   available = on_hand - reserved      (reserved = sum of all live holds)
//
// The API is "SET this line to qty N", not "add 1". Setting is naturally
// idempotent: if the app retries the same request (bad network, double tap),
// the second one changes nothing.
// ─────────────────────────────────────────────────────────────────────────────
@Injectable()
export class ReservationService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  // Per-process counters, so a load test can show WHERE requests were refused.
  readonly stats = {
    naive: 0,
    pg: 0,
    redis: 0,
    refused: 0, // 409 OUT_OF_STOCK, any mode
    refusedByRedisGate: 0, // fix B: turned away without touching Postgres
    refusedByPgAfterGate: 0, // fix B: Redis said yes, Postgres said no (the copy had drifted)
    hotRowWrites: 0, // UPDATE store_inventory attempts: each one queues on that row's lock
    expiredHolds: 0,
  };

  constructor(
    private readonly ds: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly log: LoggingService,
    private readonly catalog: CatalogService,
  ) {
    // Registers the Lua script once; ioredis then calls it by its hash (EVALSHA).
    this.redis.defineCommand('stockGate', { numberOfKeys: 1, lua: STOCK_GATE_LUA });
  }

  onModuleInit() {
    if (SWEEP_INTERVAL_MS <= 0) return;
    // EVERY pod runs the sweeper. That's safe because of SKIP LOCKED (see sweep()).
    this.timer = setInterval(() => this.sweepTick(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async setQty(mode: ReserveMode, cartId: string, storeId: number, skuId: number, qty: number): Promise<HoldResult> {
    if (!CART_ID_PATTERN.test(cartId)) throw new BadRequestException('cartId must be 1-64 letters, digits, - or _');
    this.stats[mode]++;
    if (mode === 'naive') return this.setQtyNaive(cartId, storeId, skuId, qty);
    if (mode === 'pg') return this.setQtyPg(cartId, storeId, skuId, qty);
    return this.setQtyRedis(cartId, storeId, skuId, qty);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ❌ WRONG VERSION: read, decide in JavaScript, write back.
  //
  //   buyer A reads reserved = 9  ──┐
  //   buyer B reads reserved = 9  ──┤ both see 1 left, both say "yes"
  //   buyer A writes reserved = 10 ─┤
  //   buyer B writes reserved = 10 ─┘ B overwrote A: two holds, counted once
  //
  // Every line is "correct" on its own. The bug lives in the GAP between the
  // read and the write, and with 200 people tapping at once that gap is full.
  // ───────────────────────────────────────────────────────────────────────────
  private async setQtyNaive(cartId: string, storeId: number, skuId: number, qty: number): Promise<HoldResult> {
    const [inv] = await this.ds.query(
      `SELECT on_hand_qty, reserved_qty FROM store_inventory WHERE store_id = $1 AND sku_id = $2`,
      [storeId, skuId],
    );
    if (!inv) throw this.notCarried();
    const [line] = await this.ds.query(
      `SELECT qty, status FROM reservations WHERE cart_id = $1 AND store_id = $2 AND sku_id = $3`,
      [cartId, storeId, skuId],
    );
    const old = line?.status === 'held' ? line.qty : 0;
    const delta = qty - old;
    const available = inv.on_hand_qty - inv.reserved_qty;
    if (delta > 0 && available < delta) throw this.outOfStock(available);

    const reserved = inv.reserved_qty + delta; // computed from a number that may already be stale
    this.stats.hotRowWrites++;
    await this.ds.query(`UPDATE store_inventory SET reserved_qty = $3, updated_at = now() WHERE store_id = $1 AND sku_id = $2`, [
      storeId,
      skuId,
      reserved,
    ]);
    const expiresAt = await this.saveLine(this.ds.manager, cartId, storeId, skuId, qty);
    await this.copyToRedis(storeId, skuId, -delta);
    return this.result('naive', cartId, storeId, skuId, qty, available - delta, expiresAt);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ✅ FIX A: let Postgres check AND take in ONE statement.
  //
  //   UPDATE store_inventory SET reserved_qty = reserved_qty + 1
  //   WHERE ... AND on_hand_qty - reserved_qty >= 1
  //
  // Postgres locks the row while it updates it. A second buyer's UPDATE waits
  // for the lock, then RE-CHECKS the WHERE against the new value. So the last
  // unit can only be taken once. Correct, and simple.
  //
  // The cost: everyone buying the SAME item in the SAME store queues on that
  // one row lock. That row is a "hot row".
  // ───────────────────────────────────────────────────────────────────────────
  private async setQtyPg(cartId: string, storeId: number, skuId: number, qty: number): Promise<HoldResult> {
    const out = await this.mapFkErrors(() =>
      this.ds.transaction(async (m) => {
        const old = await this.lockLine(m, cartId, storeId, skuId);
        const delta = qty - old;
        const available = await this.applyDelta(m, storeId, skuId, delta);
        const expiresAt = await this.saveLine(m, cartId, storeId, skuId, qty);
        return { delta, available, expiresAt };
      }),
    );
    // Truth is committed; now update the copy the home screen reads (chapter 2).
    await this.copyToRedis(storeId, skuId, -out.delta);
    return this.result('pg', cartId, storeId, skuId, qty, out.available, out.expiresAt);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ✅ FIX B: a Redis "gate" in front, Postgres "confirm" behind.
  //
  //   1. Redis Lua: "is there 1 left? then take it" in one uninterruptible step.
  //      No? -> refuse right here. Postgres never hears about it.
  //   2. Yes? -> do fix A in Postgres anyway. Postgres stays the final judge,
  //      so even if the Redis copy is wrong, nothing is oversold.
  //   3. If Postgres says no (or anything fails), give the unit back to Redis.
  //
  // In a flash sale (200 people, 10 units) only ~10 requests ever reach the
  // hot row. The other 190 bounce off Redis.
  // ───────────────────────────────────────────────────────────────────────────
  private async setQtyRedis(cartId: string, storeId: number, skuId: number, qty: number): Promise<HoldResult> {
    // A plain read (no lock, no write) to learn what this cart already holds.
    const [line] = await this.ds.query(
      `SELECT qty, status FROM reservations WHERE cart_id = $1 AND store_id = $2 AND sku_id = $3`,
      [cartId, storeId, skuId],
    );
    const seenOld = line?.status === 'held' ? line.qty : 0;
    const want = qty - seenOld;

    let gated = 0;
    if (want > 0) {
      const left: number = await (this.redis as any).stockGate(stockKey(storeId), skuId, want);
      if (left === -1) throw this.notCarried();
      if (left === -2) {
        this.stats.refusedByRedisGate++;
        throw this.outOfStock(Number(await this.redis.hget(stockKey(storeId), String(skuId))));
      }
      gated = want; // Redis has handed us `want` units; we owe them back if anything fails
    }

    try {
      const out = await this.mapFkErrors(() =>
        this.ds.transaction(async (m) => {
          const old = await this.lockLine(m, cartId, storeId, skuId);
          if (old !== seenOld) {
            // The same cart line changed between our read and our lock (a double
            // tap with two different numbers). Rare; the app just retries.
            throw new ConflictException({ error: 'CART_CHANGED', message: 'This item changed at the same moment. Try again.' });
          }
          const available = await this.applyDelta(m, storeId, skuId, qty - old);
          const expiresAt = await this.saveLine(m, cartId, storeId, skuId, qty);
          return { delta: qty - old, available, expiresAt };
        }),
      );
      // Giving stock BACK (qty went down): truth first, then the copy.
      if (out.delta < 0) await this.copyToRedis(storeId, skuId, -out.delta);
      return this.result('redis', cartId, storeId, skuId, qty, out.available, out.expiresAt);
    } catch (err) {
      if (gated) {
        if (err instanceof ConflictException && (err.getResponse() as any).error === 'OUT_OF_STOCK') {
          this.stats.refusedByPgAfterGate++;
        }
        await this.copyToRedis(storeId, skuId, gated);
      }
      throw err;
    }
  }

  // Make sure the cart line row exists, then lock it. Two requests for the
  // SAME cart line now take turns; requests for different carts don't wait.
  private async lockLine(m: EntityManager, cartId: string, storeId: number, skuId: number): Promise<number> {
    await m.query(
      `INSERT INTO reservations (cart_id, store_id, sku_id, qty, status, expires_at)
       VALUES ($1, $2, $3, 0, 'released', now())
       ON CONFLICT (cart_id, store_id, sku_id) DO NOTHING`,
      [cartId, storeId, skuId],
    );
    const [line] = await m.query(
      `SELECT qty, status FROM reservations WHERE cart_id = $1 AND store_id = $2 AND sku_id = $3 FOR UPDATE`,
      [cartId, storeId, skuId],
    );
    return line.status === 'held' ? line.qty : 0;
  }

  // The check-and-take (or give-back) as ONE statement. Returns units left.
  private async applyDelta(m: EntityManager, storeId: number, skuId: number, delta: number): Promise<number> {
    let rows: any[] = [];
    if (delta !== 0) this.stats.hotRowWrites++;
    if (delta > 0) {
      rows = rowsOf(
        await m.query(
          `UPDATE store_inventory
           SET reserved_qty = reserved_qty + $3, updated_at = now()
           WHERE store_id = $1 AND sku_id = $2
             AND on_hand_qty - reserved_qty >= $3
           RETURNING on_hand_qty - reserved_qty AS available`,
          [storeId, skuId, delta],
        ),
      );
    } else if (delta < 0) {
      rows = rowsOf(
        await m.query(
          `UPDATE store_inventory
           SET reserved_qty = reserved_qty - $3, updated_at = now()
           WHERE store_id = $1 AND sku_id = $2
           RETURNING on_hand_qty - reserved_qty AS available`,
          [storeId, skuId, -delta],
        ),
      );
    }
    if (rows.length) return rows[0].available;

    // No row changed: either nothing to change, not enough stock, or the store
    // doesn't sell this item. One small read tells which.
    const [inv] = await m.query(
      `SELECT on_hand_qty - reserved_qty AS available FROM store_inventory WHERE store_id = $1 AND sku_id = $2`,
      [storeId, skuId],
    );
    if (!inv) throw this.notCarried();
    if (delta === 0) return inv.available;
    throw this.outOfStock(inv.available);
  }

  // Write the cart line: its quantity and a fresh expiry. Any change to a line
  // restarts that line's clock.
  private async saveLine(m: EntityManager, cartId: string, storeId: number, skuId: number, qty: number): Promise<Date> {
    const [row] = rowsOf(
      await m.query(
        `INSERT INTO reservations (cart_id, store_id, sku_id, qty, status, expires_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $4::int > 0 THEN 'held' ELSE 'released' END, now() + $5::int * interval '1 second')
         ON CONFLICT (cart_id, store_id, sku_id) DO UPDATE
           SET qty = EXCLUDED.qty, status = EXCLUDED.status, expires_at = EXCLUDED.expires_at, updated_at = now()
         RETURNING expires_at`,
        [cartId, storeId, skuId, qty, HOLD_SECONDS],
      ),
    );
    return row.expires_at;
  }

  // Update the home screen's copy (chapter 2's Redis hash) by a CHANGE, not by
  // a final value. HINCRBY changes add up in any order, so two updates that
  // arrive out of order still end at the right number. (HSET of a final value
  // would let the older one win.)
  private async copyToRedis(storeId: number, skuId: number, change: number) {
    if (!change) return;
    try {
      await this.redis.hincrby(stockKey(storeId), String(skuId), change);
    } catch (err) {
      // Postgres is already right. The copy is now off by `change` until the
      // next rebuild (POST /admin/stock/rebuild). Log it so drift is visible.
      this.log.error(TraceCodes.HOLD_REDIS_FAILED, err, { storeId, skuId, change });
    }
  }

  // ── Cart view ──────────────────────────────────────────────────────────────
  async getCart(cartId: string) {
    if (!CART_ID_PATTERN.test(cartId)) throw new BadRequestException('bad cartId');
    const lines: { storeId: number; skuId: number; qty: number; expiresAt: Date }[] = await this.ds.query(
      `SELECT store_id AS "storeId", sku_id AS "skuId", qty, expires_at AS "expiresAt"
       FROM reservations
       WHERE cart_id = $1 AND status = 'held' AND expires_at > now()
       ORDER BY created_at, id`,
      [cartId],
    );
    const items = lines.map((l) => {
      const c = this.catalog.get(l.skuId);
      return {
        ...l,
        name: c?.name ?? `SKU ${l.skuId}`,
        packSize: c?.packSize ?? '',
        mrpPaise: c?.mrpPaise ?? 0,
        rxRequired: c?.rxRequired ?? false,
        lineTotalPaise: (c?.mrpPaise ?? 0) * l.qty,
      };
    });
    const firstExpiry = lines.length ? new Date(Math.min(...lines.map((l) => new Date(l.expiresAt).getTime()))) : null;
    return {
      cartId,
      items,
      units: items.reduce((s, i) => s + i.qty, 0),
      totalPaise: items.reduce((s, i) => s + i.lineTotalPaise, 0),
      // the soonest any line will be released if the cart is left alone
      firstExpiresAt: firstExpiry,
      holdSeconds: HOLD_SECONDS,
    };
  }

  async clearCart(cartId: string) {
    const cart = await this.getCart(cartId);
    for (const it of cart.items) await this.setQty('redis', cartId, it.storeId, it.skuId, 0);
    return { cartId, released: cart.items.length };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The sweeper: give back stock from carts nobody touched for HOLD_SECONDS.
  //
  // Every pod runs this every few seconds. Two pods must never release the
  // same hold twice (that would invent stock). FOR UPDATE SKIP LOCKED means:
  // "lock the rows I'm taking; if another sweeper already locked a row, skip
  // it instead of waiting". So the pods split the work and never overlap.
  //
  // The same lock also protects a customer who edits their cart at the exact
  // moment it expires: their request holds the row lock, so the sweeper skips
  // that row this time round.
  // ───────────────────────────────────────────────────────────────────────────
  async sweep(): Promise<{ expired: number; units: number }> {
    const done = await this.ds.transaction(async (m) => {
      const rows: { storeId: number; skuId: number; qty: number }[] = rowsOf(
        await m.query(
          `WITH due AS (
             SELECT id FROM reservations
             WHERE status = 'held' AND expires_at < now()
             ORDER BY expires_at
             LIMIT $1
             FOR UPDATE SKIP LOCKED
           )
           UPDATE reservations r SET status = 'expired', updated_at = now()
           FROM due WHERE r.id = due.id
           RETURNING r.store_id AS "storeId", r.sku_id AS "skuId", r.qty`,
          [SWEEP_BATCH],
        ),
      );
      // Add up per (store, sku) so each inventory row is touched once, and
      // touch them in a fixed order so two sweepers can't deadlock.
      const groups = new Map<string, { storeId: number; skuId: number; units: number }>();
      for (const r of rows) {
        const k = `${r.storeId}:${r.skuId}`;
        const g = groups.get(k) ?? { storeId: r.storeId, skuId: r.skuId, units: 0 };
        g.units += r.qty;
        groups.set(k, g);
      }
      const list = [...groups.values()].sort((a, b) => a.storeId - b.storeId || a.skuId - b.skuId);
      for (const g of list) {
        // GREATEST(..., 0): only the naive mode can push this count below the
        // real number of holds. Clamp so one broken row can't jam the sweeper.
        await m.query(
          `UPDATE store_inventory SET reserved_qty = GREATEST(reserved_qty - $3, 0), updated_at = now()
           WHERE store_id = $1 AND sku_id = $2`,
          [g.storeId, g.skuId, g.units],
        );
      }
      return { count: rows.length, list };
    });

    let units = 0;
    for (const g of done.list) {
      units += g.units;
      await this.copyToRedis(g.storeId, g.skuId, g.units);
    }
    if (done.count) {
      this.stats.expiredHolds += done.count;
      this.log.info(TraceCodes.HOLDS_EXPIRED, { holds: done.count, units, skus: done.list.length });
    }
    return { expired: done.count, units };
  }

  private async sweepTick() {
    if (this.sweeping) return; // the previous tick is still running in this pod
    this.sweeping = true;
    try {
      // Keep going while full batches come back (a backlog after downtime).
      while ((await this.sweep()).expired === SWEEP_BATCH);
    } catch (err) {
      this.log.error(TraceCodes.HOLD_SWEEP_FAILED, err);
    } finally {
      this.sweeping = false;
    }
  }

  // ── helpers ─────────────────────────────────────────────────────────────────
  private result(mode: ReserveMode, cartId: string, storeId: number, skuId: number, qty: number, available: number, expiresAt: Date): HoldResult {
    return {
      cartId,
      storeId,
      skuId,
      qty,
      stock: StockCacheService.badge(available),
      expiresAt: qty > 0 ? new Date(expiresAt).toISOString() : null,
      mode,
    };
  }

  private outOfStock(available: number) {
    this.stats.refused++;
    return new ConflictException({
      error: 'OUT_OF_STOCK',
      message: 'Not enough stock for that quantity',
      stock: StockCacheService.badge(Math.max(0, available || 0)),
    });
  }

  private notCarried() {
    return new NotFoundException({ error: 'NOT_CARRIED', message: 'This store does not sell that item' });
  }

  // A store or SKU id that doesn't exist at all trips a foreign key (23503).
  private async mapFkErrors<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: any) {
      if (err?.code === '23503') throw this.notCarried();
      throw err;
    }
  }
}
