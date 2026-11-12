import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createHash } from 'crypto';
import { LoggingService } from '../logging/logging.service';
import { TraceCodes } from '../logging/trace-codes';
import { CATALOG_REFRESH_MS } from './catalog.constants';

export interface CatalogItem {
  id: number;
  code: string;
  name: string;
  category: string;
  packSize: string;
  mrpPaise: number;
  rxRequired: boolean;
  coldChain: boolean;
}

// The catalog (names, prices, pack sizes, images) is THE SAME for every
// customer in every store, and changes a few times a day at most.
//
// So: keep it in each pod's memory, refresh every minute, and tag it with an
// ETag (a fingerprint). The app and the CDN can then ask "has it changed since
// fingerprint X?" and get a tiny "304 Not Modified" when it hasn't.
//
// This is the cheapest cache there is: no network hop at all. It's only
// possible because the data is small (146 SKUs here; even 20,000 SKUs is a few
// MB) and identical for everyone.
@Injectable()
export class CatalogService implements OnModuleInit, OnModuleDestroy {
  private items: CatalogItem[] = [];
  private byId = new Map<number, CatalogItem>();
  private etag = '';
  private loadedAt = 0;
  private timer: NodeJS.Timeout;

  constructor(
    private readonly ds: DataSource,
    private readonly log: LoggingService,
  ) {}

  async onModuleInit() {
    await this.reload();
    this.timer = setInterval(() => this.reload().catch((e) => this.log.error(TraceCodes.CATALOG_RELOAD_FAILED, e)), CATALOG_REFRESH_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async reload() {
    const rows: CatalogItem[] = await this.ds.query(`
      SELECT id, code, name, category, pack_size AS "packSize", mrp_paise AS "mrpPaise",
             rx_required AS "rxRequired", cold_chain AS "coldChain"
      FROM skus WHERE is_active ORDER BY category, name, id`);
    const etag = '"' + createHash('sha1').update(JSON.stringify(rows)).digest('hex').slice(0, 16) + '"';
    if (etag !== this.etag) this.log.info(TraceCodes.CATALOG_RELOADED, { skus: rows.length, etag });
    this.items = rows;
    this.byId = new Map(rows.map((r) => [r.id, r]));
    this.etag = etag;
    this.loadedAt = Date.now();
  }

  all() {
    return { etag: this.etag, loadedAt: this.loadedAt, items: this.items };
  }

  get(id: number) {
    return this.byId.get(id);
  }
}
