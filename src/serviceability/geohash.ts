// Geohash: turn a (lat, lng) into a short string that names a small box on
// the map. Nearby points share a prefix. Precision 7 = a box of about
// 153 m x 153 m in Bangalore.
//
// How it works: repeatedly cut the world in half (left/right by longitude,
// then top/bottom by latitude), write 1 if the point is in the upper/right
// half, 0 otherwise. Every 5 bits become one base-32 character.
//
// Why we care: "which store serves (12.93461, 77.61137)?" has the same answer
// as "which store serves (12.93468, 77.61129)?" — they're 10 m apart. Instead
// of caching millions of exact points, we cache ~30,000 boxes covering BLR (~700 km²).
// It's the same algorithm as PostGIS ST_GeoHash (the e2e test checks this).

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function geohashEncode(lat: number, lng: number, precision = 7): string {
  let latMin = -90,
    latMax = 90,
    lngMin = -180,
    lngMax = 180;
  let hash = '',
    bits = 0,
    idx = 0,
    useLng = true;

  while (hash.length < precision) {
    if (useLng) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) {
        idx = idx * 2 + 1;
        lngMin = mid;
      } else {
        idx = idx * 2;
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        idx = idx * 2 + 1;
        latMin = mid;
      } else {
        idx = idx * 2;
        latMax = mid;
      }
    }
    useLng = !useLng;
    if (++bits === 5) {
      hash += BASE32[idx];
      bits = 0;
      idx = 0;
    }
  }
  return hash;
}

// Straight-line ("as the crow flies") distance in metres on a round earth.
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Ray casting: draw a line from the point to the right and count how many
// polygon edges it crosses. Odd = inside, even = outside.
// ring = [[lng, lat], ...] (GeoJSON order: lng first!)
export function pointInRing(lat: number, lng: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
