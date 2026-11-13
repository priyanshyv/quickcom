import { Body, Controller, Delete, Get, Module, Param, Post, Put } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';
import { ReservationService } from './reservation.service';
import { LabArm, LabService } from './lab.service';
import { ReserveMode } from './cart.constants';
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

@Controller('admin/holds')
export class HoldsAdminController {
  constructor(private readonly holds: ReservationService) {}

  // Run the expiry sweeper right now (it also runs on its own every 5 s).
  @Post('sweep')
  sweep() {
    return this.holds.sweep();
  }

  @Get('stats')
  stats() {
    return { ...this.holds.stats, pid: process.pid };
  }
}

class RunDto {
  @IsIn(['naive', 'pg', 'redis'])
  mode: ReserveMode;

  @IsInt()
  @Min(1)
  @Max(2000)
  buyers: number;

  @IsInt()
  @Min(1)
  @Max(1000)
  units: number;
}

class ArmDto {
  @IsOptional() @IsInt() storeId?: number;
  @IsOptional() @IsInt() @Min(1) @Max(200) skus?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10_000_000) units?: number;
}

class OriginalDto {
  @IsInt() skuId: number;
  @IsInt() onHand: number;
  @IsInt() reserved: number;
}

class FinishDto implements LabArm {
  @IsString() runId: string;
  @IsInt() storeId: number;
  @IsInt() units: number;
  @IsArray() @IsInt({ each: true }) skuIds: number[];
  @IsArray() @ValidateNested({ each: true }) @Type(() => OriginalDto) originals: OriginalDto[];
}

@Controller('admin/lab/flash-sale')
export class LabController {
  constructor(private readonly lab: LabService) {}

  // Used by public/flash-sale.html: the whole experiment in one request.
  @Post()
  run(@Body() b: RunDto) {
    return this.lab.run(b.mode, b.buyers, b.units);
  }

  // Used by load/03-flash-sale.js (k6 setup / teardown).
  @Post('arm')
  arm(@Body() b: ArmDto) {
    return this.lab.arm(b.storeId ?? 1, b.skus ?? 1, b.units ?? 10);
  }

  @Post('finish')
  finish(@Body() b: FinishDto) {
    return this.lab.finish(b);
  }
}

@Module({
  imports: [InventoryModule, CatalogModule],
  controllers: [CartController, HoldsAdminController, LabController],
  providers: [ReservationService, LabService],
})
export class CartModule {}
