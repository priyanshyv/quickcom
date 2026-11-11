import { Controller, Get, Inject, Module, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';
import { LoggingService } from '../logging/logging.service';
import { TraceCodes } from '../logging/trace-codes';
import { credentials } from '../config/credentials';

@Controller('health')
export class HealthController {
  constructor(
    private readonly ds: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly log: LoggingService,
  ) {}

  // Does NOTHING except answer. Load-testing this tells you the ceiling of
  // your laptop + Node + HTTP itself — the fastest any endpoint can ever be.
  // Every later number in docs/ should be read against this baseline.
  @Get('ping')
  ping() {
    return 'pong';
  }

  // One round trip to Postgres and one to Redis. A load balancer calls an
  // endpoint like this every few seconds to decide if a pod gets traffic.
  @Get()
  async check() {
    try {
      const t0 = performance.now();
      const [{ postgis }] = await this.ds.query(`SELECT postgis_lib_version() AS postgis`);
      const pgMs = performance.now() - t0;

      const t1 = performance.now();
      await this.redis.ping();
      const redisMs = performance.now() - t1;

      return {
        status: 'ok',
        role: credentials.role,
        pid: process.pid,
        postgres: { ok: true, postgis, latencyMs: +pgMs.toFixed(2) },
        redis: { ok: true, latencyMs: +redisMs.toFixed(2) },
      };
    } catch (err) {
      this.log.error(TraceCodes.HEALTH_CHECK_FAILED, err);
      throw new ServiceUnavailableException('dependency down');
    }
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
