import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { dataSourceOptions } from './db/data-source';
import { LoggingModule } from './logging/logging.service';
import { RedisModule } from './redis/redis.module';
import { HealthModule } from './health/health.module';
import { StoresModule } from './stores/stores.module';
import { ServiceabilityModule } from './serviceability/serviceability.module';

@Module({
  imports: [
    TypeOrmModule.forRoot(dataSourceOptions),
    LoggingModule,
    RedisModule,
    HealthModule,
    StoresModule,
    ServiceabilityModule, // chapter 1
  ],
})
export class AppModule {}
