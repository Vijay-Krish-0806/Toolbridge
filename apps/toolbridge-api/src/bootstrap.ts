import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

import type { PlatformConfig } from './config.js';

/**
 * App-wide settings shared by the server (main.ts) and the e2e tests, so both run exactly the
 * same validation and limits.
 */
export function configureApp(app: NestExpressApplication, config: PlatformConfig): void {
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
