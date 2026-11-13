// The ONLY file that reads process.env (a common production rule). Everything else imports from here, so you can see
// every knob the app has in one place.

const num = (v: string | undefined, d: number) => (v === undefined ? d : Number(v));

export const credentials = {
  env: process.env.NODE_ENV ?? 'local',

  // Same image, different job — like separate api / worker / cron pods in production.
  // Phase 0 only has "api"; workers arrive in later phases.
  role: (process.env.ROLE ?? 'api') as 'api' | 'worker',

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

  city: {
    code: 'BLR',
    // Every dark store delivers inside a polygon. In the seed we approximate
    // it with a circle of this radius. Real ops teams hand-draw these along
    // roads, flyovers and lakes (Bangalore traffic doesn't care about circles).
    defaultServiceRadiusMeters: 3000,
  },
};
