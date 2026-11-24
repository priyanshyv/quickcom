import { ConflictException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';
import { LoggingService } from '../logging/logging.service';
import { TraceCodes } from '../logging/trace-codes';
import { stockKey } from '../inventory/inventory.constants';
import { OutboxService } from '../outbox/outbox.service';

export type OrderStatus = 'PAYMENT_PENDING' | 'RX_REVIEW' | 'CONFIRMED' | 'CANCELLED';

export interface TransitionResult {
  changed: boolean;
  orderId: number;
  from: OrderStatus;
  to: OrderStatus;
  storeId: number;
  // stock given back to the shelf because the order was cancelled
  released: { skuId: number; qty: number }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// The order STATE MACHINE. The only place an order's status may change.
//
//   PAYMENT_PENDING ──paid──▶ CONFIRMED            (no prescription items)
//         │          ──paid──▶ RX_REVIEW ──approve──▶ CONFIRMED
//         │                        └──────reject────▶ CANCELLED
//         └──timeout / customer──────────────────────▶ CANCELLED
//   CONFIRMED ──customer cancels before packing──────▶ CANCELLED
//
// The allowed arrows are ROWS in order_status_transitions (see the migration).
// Every move does four things in the caller's transaction:
//   1. checks the arrow is allowed
//   2. changes the status only if it is STILL what we read (compare-and-set,
//      the chapter-3 idea again: no lost updates on the order row)
//   3. writes a history row (order_status_log: from, to, reason, actor)
//   4. writes an outbox event (so SMS / store screen / etc. hear about it)
// and, when cancelling, gives the held stock back.
// ─────────────────────────────────────────────────────────────────────────────
@Injectable()
export class OrderStateService implements OnModuleInit {
  private allowed = new Set<string>();

  constructor(
    private readonly ds: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly outbox: OutboxService,
    private readonly log: LoggingService,
  ) {}

  // The rules change only with a migration, so reading them once at boot is fine.
  async onModuleInit() {
    const rows: { from_status: string; to_status: string }[] = await this.ds.query(
      `SELECT from_status, to_status FROM order_status_transitions`,
    );
    this.allowed = new Set(rows.map((r) => `${r.from_status}>${r.to_status}`));
  }

  canMove(from: string, to: string) {
    return this.allowed.has(`${from}>${to}`);
  }

  async transition(
    m: EntityManager,
    orderId: number,
    to: OrderStatus,
    opts: { reason: string; actor: string },
  ): Promise<TransitionResult> {
    const [o] = await m.query(`SELECT id, status, store_id FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
    if (!o) throw new NotFoundException('order not found');
    const base = { orderId, from: o.status, to, storeId: o.store_id, released: [] as { skuId: number; qty: number }[] };
    if (o.status === to) return { ...base, changed: false }; // asking twice is harmless
    if (!this.canMove(o.status, to)) {
      throw new ConflictException({ error: 'INVALID_TRANSITION', message: `An order can't go from ${o.status} to ${to}`, from: o.status, to });
    }

    const [, n] = await m.query(
      `UPDATE orders
       SET status = $2::varchar, version = version + 1, updated_at = now(),
           cancel_reason = CASE WHEN $2::varchar = 'CANCELLED' THEN $4 ELSE cancel_reason END
       WHERE id = $1 AND status = $3`,
      [orderId, to, o.status, opts.reason],
    );
    if (n !== 1) throw new ConflictException({ error: 'ORDER_CHANGED', message: 'The order changed at the same moment; try again' });

    await m.query(
      `INSERT INTO order_status_log (order_id, from_status, to_status, reason, actor) VALUES ($1, $2, $3, $4, $5)`,
      [orderId, o.status, to, opts.reason, opts.actor],
    );
    await this.outbox.add(m, orderId, 'order.status_changed', { orderId, from: o.status, to, reason: opts.reason, actor: opts.actor });

    if (to === 'CANCELLED') base.released = await this.releaseStock(m, orderId, o.store_id);
    return { ...base, changed: true };
  }

  // The order was holding stock (reserved_qty) since checkout. Give it back.
  // Items in a fixed order (by sku) so two cancellations can't deadlock.
  private async releaseStock(m: EntityManager, orderId: number, storeId: number) {
    const items: { sku_id: number; qty: number }[] = await m.query(
      `SELECT sku_id, qty FROM order_items WHERE order_id = $1 ORDER BY sku_id`,
      [orderId],
    );
    for (const it of items) {
      // No GREATEST(...) here on purpose: if this would go below zero, something
      // released twice, and the CHECK (reserved_qty >= 0) should stop us loudly.
      await m.query(
        `UPDATE store_inventory SET reserved_qty = reserved_qty - $3, updated_at = now() WHERE store_id = $1 AND sku_id = $2`,
        [storeId, it.sku_id, it.qty],
      );
    }
    return items.map((i) => ({ skuId: i.sku_id, qty: i.qty }));
  }

  // After the transaction COMMITS: update the Redis stock copy (chapter 2/3:
  // truth first, then the copy, by a change not a final number) and log.
  async afterCommit(r: TransitionResult | null | undefined) {
    if (!r?.changed) return;
    this.log.info(TraceCodes.ORDER_STATUS_CHANGED, { orderId: r.orderId, from: r.from, to: r.to });
    for (const it of r.released) {
      await this.redis.hincrby(stockKey(r.storeId), String(it.skuId), it.qty).catch(() => undefined);
    }
  }
}
