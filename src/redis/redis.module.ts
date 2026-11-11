import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { credentials } from '../config/credentials';
import { LoggingService } from '../logging/logging.service';
import { TraceCodes } from '../logging/trace-codes';

export const REDIS = Symbol('REDIS');

// One shared connection for normal commands (GET/SET/GEOADD/EVAL...).
// Later phases add a SEPARATE connection for SUBSCRIBE, because a Redis
// connection in subscribe mode can't run normal commands (the standard
// pattern for Redis pub/sub).
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [LoggingService],
      useFactory: (log: LoggingService) => {
        const client = new Redis({
          host: credentials.redis.host,
          port: credentials.redis.port,
          maxRetriesPerRequest: 2,
        });
        client.on('ready', () => log.info(TraceCodes.REDIS_CONNECTED, { port: credentials.redis.port }));
        client.on('error', (err) => log.error(TraceCodes.REDIS_ERROR, err));
        return client;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown() {
    await this.redis.quit();
  }
}
