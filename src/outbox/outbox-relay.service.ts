import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { credentials } from '../config/credentials';
import { LoggingService } from '../logging/logging.service';
import { TraceCodes } from '../logging/trace-codes';
import { ORDER_EVENTS, OrderEvent, OrderEventQueues, runsWorkers } from './outbox.service';

const BATCH = 100;

// ─────────────────────────────────────────────────────────────────────────────
// The relay: copies unpublished outbox rows into the BullMQ queue.
//
//   1. lock up to 100 unpublished rows (SKIP LOCKED: every worker pod can run
//      this; they take different rows, same trick as chapter 3's sweeper)
//   2. add them to the queue, jobId = "outbox-{id}"
//   3. mark them published, commit
//
// If we crash between 2 and 3, the rows are still "unpublished" and get added
// again. That's AT-LEAST-ONCE delivery: never lost, occasionally twice. Two
// things soften the "twice":
//   - BullMQ ignores a job whose jobId already exists (kept 1 h after finishing)
//   - the consumer dedupes on eventId anyway (notifications.event_id is a PK)
// ─────────────────────────────────────────────────────────────────────────────
@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly ds: DataSource,
    @Inject(ORDER_EVENTS) private readonly queues: OrderEventQueues,
    private readonly log: LoggingService,
  ) {}

  onModuleInit() {
    if (!runsWorkers() || credentials.outbox.relayIntervalMs <= 0) return;
    this.timer = setInterval(() => this.tick(), credentials.outbox.relayIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      while ((await this.runOnce()) === BATCH); // drain a backlog
    } catch (err) {
      this.log.error(TraceCodes.OUTBOX_RELAY_FAILED, err);
    } finally {
      this.running = false;
    }
  }

  // Returns how many rows it published.
  async runOnce(): Promise<number> {
    return this.ds.transaction(async (m) => {
      const rows: { id: string; order_id: string | null; event_type: string; payload: any }[] = await m.query(
        `SELECT id, order_id, event_type, payload FROM outbox
         WHERE published_at IS NULL
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [BATCH],
      );
      if (!rows.length) return 0;
      const events: OrderEvent[] = rows.map((r) => ({
        eventId: Number(r.id),
        orderId: r.order_id === null ? null : Number(r.order_id),
        type: r.event_type,
        payload: r.payload,
      }));
      try {
        // Each order's events go to its own partition, in id order.
        const byQueue = new Map<OrderEventQueues['queues'][number], OrderEvent[]>();
        for (const e of events) {
          const q = this.queues.forOrder(e.orderId);
          byQueue.set(q, [...(byQueue.get(q) ?? []), e]);
        }
        for (const [q, list] of byQueue) {
          await q.addBulk(list.map((e) => ({ name: e.type, data: e, opts: { jobId: `outbox-${e.eventId}` } })));
        }
      } catch (err: any) {
        // Queue (Redis) is down: leave them unpublished, note why, try next tick.
        await this.ds.query(`UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = ANY($1)`, [
          rows.map((r) => r.id),
          String(err?.message ?? err).slice(0, 500),
        ]);
        throw err;
      }
      await m.query(`UPDATE outbox SET published_at = now(), attempts = attempts + 1 WHERE id = ANY($1)`, [rows.map((r) => r.id)]);
      this.log.info(TraceCodes.OUTBOX_PUBLISHED, { events: rows.length, firstId: events[0].eventId });
      return rows.length;
    });
  }

  // How far behind is the relay? (pending rows and the age of the oldest one)
  async stats() {
    const [s] = await this.ds.query(
      `SELECT count(*)::int AS pending,
              coalesce(extract(epoch FROM now() - min(created_at)) * 1000, 0)::int AS "oldestPendingMs"
       FROM outbox WHERE published_at IS NULL`,
    );
    const counts = await this.queues.counts();
    return { outbox: s, queue: counts };
  }
}
