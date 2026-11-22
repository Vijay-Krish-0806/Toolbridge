import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { corsPreflight } from './auth/cors-preflight.js';
import type { PlatformConfig } from './config.js';
import { TenantsService } from './tenants/tenants.service.js';

/**
 * App-wide settings shared by the server (main.ts) and the e2e tests, so both run exactly the
 * same validation and limits.
 */
export function configureApp(app: NestExpressApplication, config: PlatformConfig): void {
  // Browsers ask first (OPTIONS) before a cross-origin call; answered before any route runs.
  app.use(corsPreflight(app.get(TenantsService)));
  // Uploaded specs arrive as JSON bodies; anything larger than MAX_SPEC_BYTES is refused (413).
  app.useBodyParser('json', { limit: config.MAX_SPEC_BYTES });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // drop properties without validation decorators
      forbidNonWhitelisted: true, // ...and reject the request instead of silently dropping them
      transform: true,
    }),
  );
}
