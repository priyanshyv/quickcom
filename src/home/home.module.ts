import { Controller, Get, Module, Query } from '@nestjs/common';
import { HomeService } from './home.service';
import { LatLngDto } from '../serviceability/dtos/lat-lng.dto';
import { ServiceabilityModule } from '../serviceability/serviceability.module';
import { CatalogModule } from '../catalog/catalog.module';
import { InventoryModule } from '../inventory/inventory.module';

@Controller('home')
export class HomeController {
  constructor(private readonly home: HomeService) {}

  @Get()
  get(@Query() q: LatLngDto) {
    return this.home.home(q.lat, q.lng);
  }

  @Get('naive')
  naive(@Query() q: LatLngDto) {
    return this.home.homeNaive(q.lat, q.lng);
  }
}

@Module({
  imports: [ServiceabilityModule, CatalogModule, InventoryModule],
  controllers: [HomeController],
  providers: [HomeService],
})
export class HomeModule {}
