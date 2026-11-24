// The ONLY file that reads process.env (a common production rule). Everything else imports from here, so you can see
// every knob the app has in one place.

const num = (v: string | undefined, d: number) => (v === undefined ? d : Number(v));

export const credentials = {
  env: process.env.NODE_ENV ?? 'local',

  // Same image, different job — like separate api / worker / cron pods in production.
  //   api     serves HTTP only
  //   worker  runs background jobs only (outbox relay, queue consumers, order sweeper)
  //   all     both, in one process: handy on a laptop (the default here)
  role: (process.env.ROLE ?? 'all') as 'api' | 'worker' | 'all',

  port: num(process.env.PORT, 4000),

  db: {
    host: process.env.DB_HOST ?? 'localhost',
    port: num(process.env.DB_PORT, 5434),
    username: process.env.DB_USER ?? 'quickcom',
    password: process.env.DB_PASSWORD ?? 'quickcom',
    database: process.env.DB_NAME ?? 'quickcom',
    // Connection pool. Every API instance opens up to this many Postgres
    // connections. 10 instances x 20 = 200 connections — this number matters
    // a lot at scale (Postgres is not happy past a few hundred). See docs/00.
    poolMax: num(process.env.DB_POOL_MAX, 20),
  },

  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: num(process.env.REDIS_PORT, 6381),
  },

  // Chapter 3: how long stock stays held in a cart nobody is touching.
  cart: {
    holdSeconds: num(process.env.CART_HOLD_SECONDS, 600),
    // How often each pod looks for expired holds. 0 = off (the e2e tests
    // turn it off so they can run the sweeper by hand).
    sweepIntervalMs: num(process.env.CART_SWEEP_MS, 5000),
  },

  // Chapter 4: checkout + payments.
  orders: {
    // Pay within this long after placing the order, or it is cancelled and its stock released.
    paymentSeconds: num(process.env.ORDER_PAYMENT_SECONDS, 600),
    // Free delivery above this cart value; otherwise a flat fee.
    freeDeliveryAbovePaise: 19900,
    deliveryFeePaise: 2500,
    // How often each worker checks for unpaid orders / payments whose webhook never came. 0 = off.
    sweepIntervalMs: num(process.env.ORDER_SWEEP_MS, 5000),
    // A payment with no webhook after this long gets checked with the gateway directly.
    reconcileAfterSeconds: num(process.env.PAYMENT_RECONCILE_AFTER_SECONDS, 30),
  },

  payments: {
    // Shared secret between us and the (mock) gateway, used to sign webhooks.
    webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET ?? 'dev-only-webhook-secret',
    // Where the mock gateway sends webhooks (this same app, on its own port).
    webhookBaseUrl: process.env.PAYMENT_WEBHOOK_BASE_URL ?? `http://127.0.0.1:${num(process.env.PORT, 4000)}`,
  },

  outbox: {
    // How often each worker moves new outbox rows into the queue. 0 = off.
    relayIntervalMs: num(process.env.OUTBOX_RELAY_MS, 500),
    // Order events are split into this many queues by order id (see outbox.service.ts).
    partitions: num(process.env.ORDER_EVENT_PARTITIONS, 16),
  },

  city: {
    code: 'BLR',
    // Every dark store delivers inside a polygon. In the seed we approximate
    // it with a circle of this radius. Real ops teams hand-draw these along
    // roads, flyovers and lakes (Bangalore traffic doesn't care about circles).
    defaultServiceRadiusMeters: 3000,
  },
};
