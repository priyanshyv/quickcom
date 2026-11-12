export const CATALOG_REFRESH_MS = 60_000;

// Tells browsers AND CDNs (CloudFront, Akamai) they may reuse the response
// for 5 minutes, then keep serving the old copy for 1 more minute while they
// fetch a fresh one in the background (stale-while-revalidate).
export const CATALOG_CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=60';
