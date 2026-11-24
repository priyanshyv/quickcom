import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import Redis from 'ioredis';
import { createHmac, randomBytes } from 'crypto';
import { REDIS } from '../redis/redis.module';
import { credentials } from '../config/credentials';
import { LoggingService } from '../logging/logging.service';
import { TraceCodes } from '../logging/trace-codes';

export type GatewayStatus = 'created' | 'captured' | 'failed' | 'refunded';
export type WebhookChaos = 'none' | 'duplicate' | 'delay' | 'lost';
export type WebhookTarget = 'right' | 'naive';

export interface WebhookEvent {
  id: string; // evt_...  a redelivery carries the SAME id
  type: 'payment.captured' | 'payment.failed';
  created: number;
  data: { paymentRef: string; orderId: number; amountPaise: number };
}

export interface DeliveryRecord {
  eventId: string;
  type: string;
  paymentRef: string;
  target: WebhookTarget;
  attempt: number;
  httpStatus: number | null;
  result: string | null; // what our handler answered: applied / duplicate / ignored / rejected
  forged?: boolean;
  at: string;
}

export const signWebhook = (rawBody: string, secret = credentials.payments.webhookSecret) =>
  createHmac('sha256', secret).update(rawBody).digest('hex');

// ─────────────────────────────────────────────────────────────────────────────
// A FAKE payment gateway (think Razorpay / Stripe / PhonePe), living inside
// this app so the whole flow runs on a laptop. It behaves like the real ones
// in the ways that hurt:
//
//   - it tells us the result by WEBHOOK (an HTTP call to us), signed with a
//     shared secret
//   - it RETRIES if we don't answer 2xx
//   - on demand, it misbehaves: the same webhook 3 times at once, a webhook
//     that arrives late, or one that never arrives at all
//
// Its own state (the gateway's "truth") is kept in Redis, so any pod can ask
// "what's the real status of pay_123?" — that's what the reconciler does.
// In production this whole file is replaced by an HTTP client for the real
// gateway; nothing else changes.
// ─────────────────────────────────────────────────────────────────────────────
@Injectable()
export class MockGatewayService {
  private webhookBase = credentials.payments.webhookBaseUrl;
  private readonly pending = new Set<Promise<unknown>>();
  readonly deliveries: DeliveryRecord[] = []; // last 300, for the lab page

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly log: LoggingService,
  ) {}

  private key = (ref: string) => `mockgw:pay:${ref}`;

  // Tests listen on a random port and point the gateway at it.
  setWebhookBase(url: string) {
    this.webhookBase = url;
  }

  // ── what OUR server calls (in real life: HTTPS calls to the gateway's API) ──
  async createPayment(orderId: number, amountPaise: number): Promise<string> {
    const ref = 'pay_' + randomBytes(6).toString('hex');
    await this.redis.hset(this.key(ref), { orderId, amountPaise, status: 'created', createdAt: Date.now() });
    await this.redis.expire(this.key(ref), 7 * 24 * 3600);
    return ref;
  }

  async getPayment(ref: string): Promise<{ status: GatewayStatus; orderId: number; amountPaise: number }> {
    const h = await this.redis.hgetall(this.key(ref));
    if (!h.status) throw new NotFoundException(`no such payment at the gateway: ${ref}`);
    return { status: h.status as GatewayStatus, orderId: Number(h.orderId), amountPaise: Number(h.amountPaise) };
  }

  // Idempotent: refunding twice is the same as refunding once.
  async refund(ref: string): Promise<GatewayStatus> {
    const p = await this.getPayment(ref);
    if (p.status === 'captured') await this.redis.hset(this.key(ref), 'status', 'refunded');
    return p.status === 'captured' ? 'refunded' : p.status;
  }

  // ── what the CUSTOMER does (in real life: inside their UPI / card app) ──
  async complete(
    ref: string,
    outcome: 'success' | 'failure',
    opts: { chaos?: WebhookChaos; delayMs?: number; target?: WebhookTarget } = {},
  ) {
    const p = await this.getPayment(ref);
    if (p.status !== 'created') return { paymentRef: ref, status: p.status, note: 'already finished at the gateway' };
    const status: GatewayStatus = outcome === 'success' ? 'captured' : 'failed';
    await this.redis.hset(this.key(ref), 'status', status);

    const event: WebhookEvent = {
      id: 'evt_' + randomBytes(6).toString('hex'),
      type: status === 'captured' ? 'payment.captured' : 'payment.failed',
      created: Date.now(),
      data: { paymentRef: ref, orderId: p.orderId, amountPaise: p.amountPaise },
    };
    const chaos = opts.chaos ?? 'none';
    const target = opts.target ?? 'right';
    if (chaos === 'none') this.track(this.deliver(event, target));
    if (chaos === 'duplicate') for (let i = 0; i < 3; i++) this.track(this.deliver(event, target)); // all at once
    if (chaos === 'delay') this.track(this.sleep(opts.delayMs ?? 5000).then(() => this.deliver(event, target)));
    // chaos === 'lost': the gateway "forgets". Only reconciliation can save us.
    return { paymentRef: ref, status, eventId: event.id, chaos };
  }

  // An attacker's fake "payment captured" (signed with the wrong secret).
  async sendForged(ref: string, target: WebhookTarget) {
    const p = await this.getPayment(ref);
    const event: WebhookEvent = {
      id: 'evt_forged_' + randomBytes(4).toString('hex'),
      type: 'payment.captured',
      created: Date.now(),
      data: { paymentRef: ref, orderId: p.orderId, amountPaise: p.amountPaise },
    };
    return this.track(this.deliver(event, target, 'not-the-real-secret'));
  }

  // Wait until every scheduled delivery (including delayed ones) has finished.
  async idle() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  // ── delivery, with retries like a real gateway ──
  private async deliver(event: WebhookEvent, target: WebhookTarget, secret?: string) {
    const body = JSON.stringify(event);
    const url = `${this.webhookBase}/webhooks/payment${target === 'naive' ? '/naive' : ''}`;
    const backoff = [0, 300, 900];
    for (let attempt = 1; attempt <= backoff.length; attempt++) {
      if (backoff[attempt - 1]) await this.sleep(backoff[attempt - 1]);
      let httpStatus: number | null = null;
      let result: string | null = null;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-mock-signature': signWebhook(body, secret) },
          body,
        });
        httpStatus = res.status;
        result = ((await res.json().catch(() => ({}))) as any).result ?? null;
      } catch (err) {
        this.log.error(TraceCodes.WEBHOOK_DELIVERY_FAILED, err, { eventId: event.id, attempt });
      }
      this.record({ eventId: event.id, type: event.type, paymentRef: event.data.paymentRef, target, attempt, httpStatus, result, forged: !!secret, at: new Date().toISOString() });
      // 2xx = done. 4xx = "we refuse this" (bad signature): retrying won't help.
      if (httpStatus !== null && httpStatus < 500) return httpStatus;
    }
    return null;
  }

  private record(d: DeliveryRecord) {
    this.deliveries.push(d);
    if (this.deliveries.length > 300) this.deliveries.shift();
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    p.finally(() => this.pending.delete(p)).catch(() => undefined);
    return p;
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
