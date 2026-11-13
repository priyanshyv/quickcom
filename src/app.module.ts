import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { dataSourceOptions } from './db/data-source';
import { LoggingModule } from './logging/logging.service';
import { RedisModule } from './redis/redis.module';
import { HealthModule } from './health/health.module';
import { StoresModule } from './stores/stores.module';
import { ServiceabilityModule } from './serviceability/serviceability.module';
import { CatalogModule } from './catalog/catalog.module';
import { InventoryModule } from './inventory/inventory.module';
import { HomeModule } from './home/home.module';
import { CartModule } from './cart/cart.module';

@Module({
  imports: [
    TypeOrmModule.forRoot(dataSourceOptions),
    LoggingModule,
    RedisModule,
    HealthModule,
    StoresModule,
    ServiceabilityModule, // chapter 1
    CatalogModule, // chapter 2
    InventoryModule, // chapter 2
    HomeModule, // chapter 2
    CartModule, // chapter 3
  ],
})
export class AppModule {}
