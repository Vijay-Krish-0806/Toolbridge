import { Global, Module, type DynamicModule } from '@nestjs/common';
import { SafeHttpClient } from '@toolbridge/agent-core';

import type { PlatformConfig } from '../config.js';
import { LocalKeyProvider } from '../crypto/key-provider.js';

export const PLATFORM_CONFIG = Symbol('PLATFORM_CONFIG');
export const OUTBOUND_HTTP = Symbol('OUTBOUND_HTTP');
export const KEY_PROVIDER = Symbol('KEY_PROVIDER');

/**
 * App-wide providers:
 * - the validated config;
 * - the SSRF-safe HTTP client for every outbound call (fetching specs, calling tenant APIs). Its
 *   private-address allowlist comes only from platform config, never from tenants;
 * - the key provider holding the master key(s) for envelope encryption. The only place the
 *   master key enters the app.
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
          provide: OUTBOUND_HTTP,
          useValue: new SafeHttpClient({
            allowPrivateHosts: config.PLATFORM_ALLOW_PRIVATE_HOSTS,
            maxResponseBytes: config.MAX_SPEC_BYTES,
          }),
        },
        {
          provide: KEY_PROVIDER,
          useValue: new LocalKeyProvider(
            config.PLATFORM_MASTER_KEY_VERSION,
            config.PLATFORM_MASTER_KEY,
            config.PLATFORM_PREVIOUS_MASTER_KEYS,
          ),
        },
      ],
      exports: [PLATFORM_CONFIG, OUTBOUND_HTTP, KEY_PROVIDER],
    };
  }
}
