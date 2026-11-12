import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ServiceabilityService, ServiceabilityResult } from '../serviceability/serviceability.service';
import { CatalogService } from '../catalog/catalog.service';
import { StockCacheService, StockBadge } from '../inventory/stock-cache.service';

interface HomeItem {
  id: number;
  name: string;
  packSize: string;
  mrpPaise: number;
  rxRequired: boolean;
  stock: StockBadge;
}

export interface HomeResponse {
  location: ServiceabilityResult;
  sections?: { category: string; items: HomeItem[] }[];
}

// The home screen = "what can I buy right now, from the store that serves me?"
// Two ingredients with completely different personalities:
//
//   catalog -> same for everyone, changes daily        -> in-process memory
//   stock   -> different per store, changes every sec  -> Redis hash per store
@Injectable()
export class HomeService {
  constructor(
    private readonly ds: DataSource,
    private readonly svc: ServiceabilityService,
    private readonly catalog: CatalogService,
    private readonly stock: StockCacheService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // WRONG VERSION — everything from Postgres, every time.
  //   1 PostGIS query  (which store?)
  //   1 big JOIN       (skus x store_inventory for that store, ~120 rows)
  // Every app open = 2 Postgres queries that return the same answer as the
  // last 1,000 app opens.
  // ─────────────────────────────────────────────────────────────────────────
  async homeNaive(lat: number, lng: number): Promise<HomeResponse> {
    const location = await this.svc.findPostgis(lat, lng);
    if (!location.serviceable) return { location };
    const rows: any[] = await this.ds.query(
      `SELECT s.id, s.name, s.category, s.pack_size, s.mrp_paise, s.rx_required,
              i.on_hand_qty - i.reserved_qty AS available
       FROM store_inventory i
       JOIN skus s ON s.id = i.sku_id
       WHERE i.store_id = $1 AND s.is_active
       ORDER BY s.category, s.name, s.id`,
      [location.store.id],
    );
    const items = rows.map((r) => ({
      id: r.id,
      category: r.category,
      name: r.name,
      packSize: r.pack_size,
      mrpPaise: r.mrp_paise,
      rxRequired: r.rx_required,
      available: r.available,
    }));
    return { location, sections: this.group(items) };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RIGHT VERSION — zero Postgres queries on the normal path.
  //   1 Redis GET      (which store? — chapter 1's geohash cache)
  //   0 I/O            (catalog is already in this pod's memory)
  //   1 Redis HGETALL  (stock for that store)
  // ─────────────────────────────────────────────────────────────────────────
  async home(lat: number, lng: number): Promise<HomeResponse> {
    const location = await this.svc.findCached(lat, lng);
    if (!location.serviceable) return { location };
    const available = await this.stock.availableForStore(location.store.id);
    const items = [];
    for (const [skuId, n] of available) {
      const c = this.catalog.get(skuId);
      if (!c) continue; // SKU deactivated in catalog
      items.push({ ...c, available: n });
    }
    items.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name) || a.id - b.id);
    return { location, sections: this.group(items) };
  }

  // Shared shaping: group by category, in-stock first inside each group,
  // and replace exact quantities with badges.
  private group(items: { id: number; category: string; name: string; packSize: string; mrpPaise: number; rxRequired: boolean; available: number }[]) {
    const byCat = new Map<string, HomeItem[]>();
    for (const it of items) {
      const list = byCat.get(it.category) ?? [];
      list.push({
        id: it.id,
        name: it.name,
        packSize: it.packSize,
        mrpPaise: it.mrpPaise,
        rxRequired: it.rxRequired,
        stock: StockCacheService.badge(it.available),
      });
      byCat.set(it.category, list);
    }
    return [...byCat].map(([category, list]) => ({
      category,
      // stable sort: available items float up, original name order kept
      items: list.sort((a, b) => Number(a.stock === 'out') - Number(b.stock === 'out')),
    }));
  }
}
