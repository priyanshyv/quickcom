// precision 7 ≈ 153 m x 153 m box in Bangalore. Precision 6 (≈1.2 km x 0.6 km)
// would give a higher hit rate but far more "edge" cells straddling a polygon
// border. 7 is the usual sweet spot for delivery-radius work.
export const SVC_GEOHASH_PRECISION = 7;

// Polygons change maybe weekly. An hour is safe because invalidation happens
// via the version bump, not by waiting for the TTL. The TTL only cleans up
// cells nobody asks about any more.
export const SVC_CACHE_TTL_SECONDS = 3600;

export const SVC_VERSION_KEY = 'svc:version';
export const SVC_VERSION_POLL_MS = 5000;

export const svcCellKey = (version: string, cell: string) => `svc:v${version}:${cell}`;
