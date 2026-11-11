// "Delivering in X min" — a deliberately simple first version. Chapter 8
// replaces it with live store load + rider availability + traffic by hour.
//
//   promise = pick & pack  +  ride time
//   ride time = straight-line distance x ROAD_FACTOR / rider speed
//
// ROAD_FACTOR: roads are never straight. 1.4 is a common rule of thumb for
// city grids (Bangalore one-ways and flyovers make it worse in places).
// Speed: ~15 km/h average for a two-wheeler in BLR traffic = 250 m per minute.

export const PICK_PACK_MINUTES = 3;
export const ROAD_FACTOR = 1.4;
export const RIDER_METERS_PER_MINUTE = 250;

export function promiseMinutes(straightLineMeters: number): number {
  const ride = (straightLineMeters * ROAD_FACTOR) / RIDER_METERS_PER_MINUTE;
  return Math.ceil(PICK_PACK_MINUTES + ride);
}
