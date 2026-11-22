import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';

import { MODEL } from '../domain/models.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';

/**
 * Idempotency keys on every write route (Step 4.5). Registered as a GLOBAL interceptor, so a new
 * write route gets it automatically. Guards run before interceptors, so the user is known.
 */
@Module({
  imports: [MongooseModule.forFeature([MODEL.Idempotency])],
  providers: [{ provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor }],
})
export class IdempotencyModule {}
