// store_id is IN the key: one hash per store. Each store's stock lives and
// changes on its own — the sharding idea from chapter 0, in a Redis key name.
export const stockKey = (storeId: number) => `stock:${storeId}`;

export const LOW_STOCK_THRESHOLD = 5;
