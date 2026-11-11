import { Controller, Get, Module, Query } from '@nestjs/common';
import { ServiceabilityService } from './serviceability.service';
import { LatLngDto } from './dtos/lat-lng.dto';

@Controller('serviceability')
export class ServiceabilityController {
  constructor(private readonly svc: ServiceabilityService) {}

  // The one the app calls.
  @Get()
  find(@Query() q: LatLngDto) {
    return this.svc.findCached(q.lat, q.lng);
  }

  // The two "before" versions, kept so you can load-test them side by side.
  @Get('naive')
  naive(@Query() q: LatLngDto) {
    return this.svc.findNaive(q.lat, q.lng);
  }

  @Get('postgis')
  postgis(@Query() q: LatLngDto) {
    return this.svc.findPostgis(q.lat, q.lng);
  }

  @Get('stats')
  stats() {
    const s = this.svc.stats;
    const cached = s.hit + s.miss;
    return {
      ...s,
      hitRate: cached ? +(s.hit / cached).toFixed(4) : null,
      edgeRate: cached ? +(s.edge / cached).toFixed(4) : null,
      pid: process.pid,
    };
  }
}

@Module({
  controllers: [ServiceabilityController],
  providers: [ServiceabilityService],
  exports: [ServiceabilityService],
})
export class ServiceabilityModule {}
