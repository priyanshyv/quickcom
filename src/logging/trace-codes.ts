// Every log line carries a TraceCode instead of a free-text message (a common
// production convention). Why: at scale you search/alert on a stable code, not a sentence
// someone might reword next week.
export enum TraceCodes {
  APP_STARTED = 'APP_STARTED',
  APP_SHUTTING_DOWN = 'APP_SHUTTING_DOWN',

  REDIS_CONNECTED = 'REDIS_CONNECTED',
  REDIS_ERROR = 'REDIS_ERROR',

  HEALTH_CHECK_FAILED = 'HEALTH_CHECK_FAILED',

  // chapter 1 — serviceability
  SVC_VERSION_CHANGED = 'SVC_VERSION_CHANGED',

  // chapter 2 — catalog + stock
  CATALOG_RELOADED = 'CATALOG_RELOADED',
  CATALOG_RELOAD_FAILED = 'CATALOG_RELOAD_FAILED',
  STOCK_CACHE_REBUILT = 'STOCK_CACHE_REBUILT',
  STOCK_CACHE_WRITE_FAILED = 'STOCK_CACHE_WRITE_FAILED',

  // chapter 3 — cart holds
  HOLDS_EXPIRED = 'HOLDS_EXPIRED',
  HOLD_SWEEP_FAILED = 'HOLD_SWEEP_FAILED',
  HOLD_REDIS_FAILED = 'HOLD_REDIS_FAILED',
  LAB_FLASH_SALE = 'LAB_FLASH_SALE',

  SEED_STARTED = 'SEED_STARTED',
  SEED_DONE = 'SEED_DONE',
}
