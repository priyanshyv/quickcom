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

  SEED_STARTED = 'SEED_STARTED',
  SEED_DONE = 'SEED_DONE',
}
