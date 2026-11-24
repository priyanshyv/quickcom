import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Queue } from 'bullmq';
import { credentials } from '../config/credentials';

export const ORDER_EVENTS_QUEUE = 'order-events';
export const ORDER_EVENTS = Symbol('ORDER_EVENTS');

// Background jobs (relay, consumer, sweeper) run in "worker" and "all" pods,
// never in a pure "api" pod.
export const runsWorkers = () => credentials.role !== 'api';

export interface OrderEvent {
  eventId: number; // the outbox row id: unique, so consumers can dedupe on it
  orderId: number | null;
  type: string;
  payload: Record<string, any>;
}

// BullMQ needs its own Redis connection settings; maxRetriesPerRequest must be
// null for blocking commands (that's a BullMQ rule).
export const bullConnection = () => ({
  host: credentials.redis.host,
  port: credentials.redis.port,
  maxRetriesPerRequest: null as null,
});

// ─────────────────────────────────────────────────────────────────────────────
// ORDER MATTERS. "Order placed" must reach the customer before "Order
// confirmed". A queue with several jobs running at once does NOT keep order:
// two events for the same order can run side by side and finish backwards.
// (The e2e suite caught exactly this: the "confirmed" SMS arrived first.)
//
// Fix: PARTITIONS. Every order always goes to the same queue
// (order id % N), and each queue runs ONE job at a time across ALL worker
// pods (BullMQ global concurrency = 1). So one order's events are processed
// in order, while N different orders still run in parallel. It's the same
// idea as one queue per warehouse shard with prefetch(1).
// ─────────────────────────────────────────────────────────────────────────────
// More partitions = more parallelism (each one is a single file line).
// Measured on this laptop: 4 partitions -> SMS lagged ~7 s behind a 290
// orders/s burst; 16 partitions kept up (see docs/04). Rule of thumb: enough
// partitions that (events/s) / partitions is comfortably below what ONE job
// at a time can do.
export const ORDER_EVENT_PARTITIONS = credentials.outbox.partitions;

export class OrderEventQueues {
  readonly queues: Queue[] = Array.from(
    { length: ORDER_EVENT_PARTITIONS },
    (_, i) =>
      new Queue(`${ORDER_EVENTS_QUEUE}-${i}`, {
        connection: bullConnection(),
        defaultJobOptions: {
          attempts: 5, // a failing consumer is retried with backoff…
          backoff: { type: 'exponential', delay: 500 },
          // …and finished jobs are kept for an hour, so re-adding the same jobId
          // in that window is ignored (BullMQ dedupes on jobId).
          removeOnComplete: { age: 3600, count: 10000 },
          removeOnFail: { age: 24 * 3600 },
        },
      }),
  );

  forOrder(orderId: number | null) {
    return this.queues[Math.abs(orderId ?? 0) % ORDER_EVENT_PARTITIONS];
  }

  async init() {
    for (const q of this.queues) await q.setGlobalConcurrency(1);
    return this;
  }

  async counts() {
    const all = await Promise.all(this.queues.map((q) => q.getJobCounts('waiting', 'active', 'delayed', 'prioritized', 'failed', 'completed')));
    const sum: Record<string, number> = {};
    for (const c of all) for (const [k, v] of Object.entries(c)) sum[k] = (sum[k] ?? 0) + v;
    return sum;
  }

  close() {
    return Promise.all(this.queues.map((q) => q.close()));
  }
}

export const orderEventsQueueProvider = {
  provide: ORDER_EVENTS,
  useFactory: () => new OrderEventQueues().init(),
};

// ─────────────────────────────────────────────────────────────────────────────
// The OUTBOX.
//
// Problem ("dual write"): we change the database AND tell other systems about
// it (queue -> SMS, store screen, analytics). Those are two different systems,
// so there is no transaction that covers both:
//
//   commit order ✓ -> crash before queue.add  => order confirmed, nobody is told
//   queue.add ✓   -> transaction rolls back   => everybody told about a change that never happened
//
// Fix: don't talk to the queue inside the request at all. Write the event as a
// ROW, in the SAME transaction as the change. Either both are saved or neither.
// A relay (outbox-relay.service.ts) later copies unpublished rows to the queue.
// ─────────────────────────────────────────────────────────────────────────────
@Injectable()
export class OutboxService implements OnApplicationShutdown {
  constructor(@Inject(ORDER_EVENTS) private readonly queues: OrderEventQueues) {}

  // Must be called with the transaction's EntityManager, never the DataSource.
  async add(m: EntityManager, orderId: number | null, type: string, payload: Record<string, any>): Promise<number> {
    const [row] = await m.query(`INSERT INTO outbox (order_id, event_type, payload) VALUES ($1, $2, $3) RETURNING id`, [
      orderId,
      type,
      JSON.stringify(payload),
    ]);
    return Number(row.id);
  }

  async onApplicationShutdown() {
    await this.queues.close();
  }
}
