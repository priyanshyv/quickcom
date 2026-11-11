import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

// Phase 0: read-only view of the seeded city so you can SEE it on a map
// (public/ops.html). Phase 1 turns this into real serviceability.
@Injectable()
export class StoresService {
  constructor(private readonly ds: DataSource) {}

  // Returns a GeoJSON FeatureCollection — the standard format every map
  // library (Leaflet, Mapbox, Google Maps) understands.
  async cityMap() {
    const rows: any[] = await this.ds.query(`
      SELECT s.id, s.code, s.name, s.area, s.max_orders_per_hour,
             ST_AsGeoJSON(s.location)::json      AS location,
             ST_AsGeoJSON(s.service_area)::json  AS service_area,
             round((ST_Area(s.service_area) / 1e6)::numeric, 1) AS area_km2,
             (SELECT count(*) FROM riders r WHERE r.home_store_id = s.id)::int AS riders,
             (SELECT count(*) FROM store_inventory i
                WHERE i.store_id = s.id AND i.on_hand_qty > 0)::int AS skus_in_stock
      FROM stores s
      WHERE s.is_active
      ORDER BY s.id`);

    const features = rows.flatMap((r) => {
      const props = {
        id: r.id,
        code: r.code,
        name: r.name,
        area: r.area,
        areaKm2: Number(r.area_km2),
        riders: r.riders,
        skusInStock: r.skus_in_stock,
        maxOrdersPerHour: r.max_orders_per_hour,
      };
      return [
        { type: 'Feature', geometry: r.service_area, properties: { ...props, kind: 'service_area' } },
        { type: 'Feature', geometry: r.location, properties: { ...props, kind: 'store' } },
      ];
    });
    return { type: 'FeatureCollection', features };
  }
}
