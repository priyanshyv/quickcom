import { Body, Controller, Get, Module, Param, ParseIntPipe, Post } from '@nestjs/common';
import { IsInt, Min } from 'class-validator';
import { StockCacheService } from './stock-cache.service';

class SetOnHandDto {
  @IsInt()
  skuId: number;

  @IsInt()
  @Min(0)
  onHand: number;
}

@Controller()
export class InventoryController {
  constructor(private readonly stock: StockCacheService) {}

  // Small, per-store, changes every second -> NOT cacheable by a CDN.
  // Pair it with GET /catalog (big, same for everyone, CDN-cacheable) and the
  // app merges the two. See docs/02.
  @Get('stores/:storeId/stock')
  async storeStock(@Param('storeId', ParseIntPipe) storeId: number) {
    const avail = await this.stock.availableForStore(storeId);
    const badges: Record<number, string> = {};
    for (const [skuId, n] of avail) badges[skuId] = StockCacheService.badge(n);
    return { storeId, badges };
  }

  @Post('admin/stores/:storeId/stock')
  setOnHand(@Param('storeId', ParseIntPipe) storeId: number, @Body() body: SetOnHandDto) {
    return this.stock.setOnHand(storeId, body.skuId, body.onHand);
  }

  @Post('admin/stock/rebuild')
  rebuild() {
    return this.stock.rebuildAll();
  }
}

@Module({ controllers: [InventoryController], providers: [StockCacheService], exports: [StockCacheService] })
export class InventoryModule {}
