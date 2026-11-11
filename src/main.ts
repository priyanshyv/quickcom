import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { credentials } from './config/credentials';
import { LoggingService } from './logging/logging.service';
import { TraceCodes } from './logging/trace-codes';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn'] });

  configureApp(app); // validation + graceful shutdown (shared with e2e tests)
  // Demo pages (Leaflet maps etc.) — http://localhost:4000/ops.html
  app.useStaticAssets(join(__dirname, '..', 'public'));

  await app.listen(credentials.port);
  app.get(LoggingService).info(TraceCodes.APP_STARTED, { port: credentials.port, env: credentials.env });
}

bootstrap();
