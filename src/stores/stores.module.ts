import { Body, Controller, Get, Module, NotFoundException, Param, ParseIntPipe, Patch } from '@nestjs/common';
import { IsBoolean } from 'class-validator';
import { DataSource } from 'typeorm';
import { StoresService } from './stores.service';
import { ServiceabilityModule } from '../serviceability/serviceability.module';
import { ServiceabilityService } from '../serviceability/serviceability.service';

class SetActiveDto {
  @IsBoolean()
  isActive: boolean;
}

@Controller('stores')
export class StoresController {
  constructor(private readonly stores: StoresService) {}

  @Get()
  cityMap() {
    return this.stores.cityMap();
  }
}

// Ops actions. In real life: behind auth, called from an internal dashboard
// (e.g. an internal admin tool).
@Controller('admin/stores')
export class StoresAdminController {
  constructor(
    private readonly ds: DataSource,
    private readonly svc: ServiceabilityService,
  ) {}

  // "Koramangala is flooded / short of staff — stop taking orders there."
  // Write the truth to Postgres FIRST, then bump the cache version so every
  // pod stops using cached answers that mention the old state.
  @Patch(':id/active')
  async setActive(@Param('id', ParseIntPipe) id: number, @Body() body: SetActiveDto) {
    const [rows] = await this.ds.query(`UPDATE stores SET is_active = $2 WHERE id = $1 RETURNING code, is_active`, [
      id,
      body.isActive,
    ]);
    if (!rows.length) throw new NotFoundException('store not found');
    const version = await this.svc.bumpVersion();
    return { store: rows[0].code, isActive: rows[0].is_active, serviceabilityCacheVersion: version };
  }
}

@Module({
  imports: [ServiceabilityModule],
  controllers: [StoresController, StoresAdminController],
  providers: [StoresService],
})
export class StoresModule {}
