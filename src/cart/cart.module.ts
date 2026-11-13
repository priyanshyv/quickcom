import { Body, Controller, Delete, Get, Module, Param, Put } from '@nestjs/common';
import { IsInt, Max, Min } from 'class-validator';
import { ReservationService } from './reservation.service';
import { InventoryModule } from '../inventory/inventory.module';
import { CatalogModule } from '../catalog/catalog.module';

class SetQtyDto {
  @IsInt()
  storeId: number;

  @IsInt()
  skuId: number;

  // 0 = remove from cart. A per-line cap stops one cart from emptying a store
  // (and nobody needs 50 strips of anything delivered in 10 minutes).
  @IsInt()
  @Min(0)
  @Max(10)
  qty: number;
}

@Controller('carts')
export class CartController {
  constructor(private readonly holds: ReservationService) {}

  // The one the app calls: tap ADD / + / − on an item.
  @Put(':cartId/items')
  setQty(@Param('cartId') cartId: string, @Body() b: SetQtyDto) {
    return this.holds.setQty('redis', cartId, b.storeId, b.skuId, b.qty);
  }

  // The other two versions, kept for side-by-side load tests.
  @Put(':cartId/items/pg')
  setQtyPg(@Param('cartId') cartId: string, @Body() b: SetQtyDto) {
    return this.holds.setQty('pg', cartId, b.storeId, b.skuId, b.qty);
  }

  @Put(':cartId/items/naive')
  setQtyNaive(@Param('cartId') cartId: string, @Body() b: SetQtyDto) {
    return this.holds.setQty('naive', cartId, b.storeId, b.skuId, b.qty);
  }

  @Get(':cartId')
  get(@Param('cartId') cartId: string) {
    return this.holds.getCart(cartId);
  }

  @Delete(':cartId')
  clear(@Param('cartId') cartId: string) {
    return this.holds.clearCart(cartId);
  }
}

@Module({
  imports: [InventoryModule, CatalogModule],
  controllers: [CartController],
  providers: [ReservationService],
})
export class CartModule {}
