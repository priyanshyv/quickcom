import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { credentials } from './config/credentials';
import { LoggingService } from './logging/logging.service';
import { TraceCodes } from './logging/trace-codes';

async function bootstrap() {
  // rawBody: webhook signatures are computed over the exact bytes received,
  // so we keep them next to the parsed JSON (req.rawBody).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn'], rawBody: true });

  configureApp(app); // validation + graceful shutdown (shared with e2e tests)
  // Demo pages (Leaflet maps etc.) — http://localhost:4000/ops.html
  app.useStaticAssets(join(__dirname, '..', 'public'));

  // A pure worker pod doesn't serve HTTP: it only runs the background jobs
  // (outbox relay, queue consumer, sweepers), which start in app.init().
  if (credentials.role === 'worker') {
    await app.init();
    app.get(LoggingService).info(TraceCodes.APP_STARTED, { role: 'worker', env: credentials.env });
    return;
  }
  await app.listen(credentials.port);
  app.get(LoggingService).info(TraceCodes.APP_STARTED, { port: credentials.port, env: credentials.env });
}

bootstrap();
