import { INestApplication, ValidationPipe } from '@nestjs/common';

// Everything that must be identical in the real server (main.ts) and in the
// e2e tests. If validation were only switched on in main.ts, the tests would
// be testing a different app than the one you deploy.
export function configureApp(app: INestApplication) {
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.enableShutdownHooks();
  return app;
}
