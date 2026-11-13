import { credentials } from '../config/credentials';

export const HOLD_SECONDS = credentials.cart.holdSeconds;
export const SWEEP_INTERVAL_MS = credentials.cart.sweepIntervalMs;
// How many expired holds one sweep handles. A sweep that has more to do just
// runs again next tick; keeping each one small keeps its transaction short.
export const SWEEP_BATCH = 500;

export type ReserveMode = 'naive' | 'pg' | 'redis';

// The Redis "gate" (fix B). Lua scripts run inside Redis ONE AT A TIME, so
// nothing can sneak in between the check and the decrement. That is the whole
// trick: "check then take" becomes a single step nobody can interrupt.
//
//   KEYS[1] = stock:{storeId}    ARGV[1] = skuId    ARGV[2] = units wanted
//   returns  >= 0  units left after taking
//            -1    this store doesn't carry the SKU
//            -2    not enough left (nothing was changed)
export const STOCK_GATE_LUA = `
local left = redis.call('HGET', KEYS[1], ARGV[1])
if not left then return -1 end
left = tonumber(left)
local want = tonumber(ARGV[2])
if left < want then return -2 end
return redis.call('HINCRBY', KEYS[1], ARGV[1], -want)
`;

// Cart ids come from the app (a random id per device/session).
export const CART_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
