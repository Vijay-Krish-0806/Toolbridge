import { Global, Module, type DynamicModule } from '@nestjs/common';
import { SafeHttpClient } from '@toolbridge/agent-core';

import type { PlatformConfig } from '../config.js';

export const PLATFORM_CONFIG = Symbol('PLATFORM_CONFIG');
export const SPEC_FETCH_CLIENT = Symbol('SPEC_FETCH_CLIENT');

/**
 * App-wide providers: the validated config, and the SSRF-safe HTTP client used to fetch specs by
 * URL. The client's private-address allowlist comes only from platform config, never from tenants.
 */
@Global()
@Module({})
export class CoreModule {
  /** Built from an already-validated config, so nothing below reads process.env directly. */
  static register(config: PlatformConfig): DynamicModule {
    return {
      module: CoreModule,
      providers: [
        { provide: PLATFORM_CONFIG, useValue: config },
        {
          provide: SPEC_FETCH_CLIENT,
          useValue: new SafeHttpClient({
            allowPrivateHosts: config.PLATFORM_ALLOW_PRIVATE_HOSTS,
            maxResponseBytes: config.MAX_SPEC_BYTES,
          }),
        },
      ],
      exports: [PLATFORM_CONFIG, SPEC_FETCH_CLIENT],
    };
  }
}
