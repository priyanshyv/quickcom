import { Global, Injectable, Module } from '@nestjs/common';
import { credentials } from '../config/credentials';
import { TraceCodes } from './trace-codes';

// One JSON object per line. Log shippers (Datadog, Loki, CloudWatch) can index
// JSON fields directly, which is what makes "show me every REDIS_ERROR from
// pod api-3 in the last 5 min" possible when you have 50 pods.
@Injectable()
export class LoggingService {
  info(code: TraceCodes, data: Record<string, unknown> = {}) {
    this.write('info', code, data);
  }

  error(code: TraceCodes, err: unknown, data: Record<string, unknown> = {}) {
    const e = err as Error;
    this.write('error', code, { ...data, error: e?.message ?? String(err) });
  }

  private write(level: string, code: TraceCodes, data: Record<string, unknown>) {
    // pid tells you WHICH instance logged it once you run several (phase 7).
    console.log(
      JSON.stringify({ ts: new Date().toISOString(), level, code, role: credentials.role, pid: process.pid, ...data }),
    );
  }
}

@Global()
@Module({ providers: [LoggingService], exports: [LoggingService] })
export class LoggingModule {}
