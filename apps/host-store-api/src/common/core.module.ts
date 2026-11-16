import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { HostConfig } from '../config.js';
import { Clock, createClock } from './clock.js';

export const HOST_CONFIG = Symbol('HOST_CONFIG');

/** App-wide providers: the validated config and the clock. Global, so features need not import it. */
@Global()
@Module({})
export class CoreModule {
  static register(config: HostConfig): DynamicModule {
    return {
      module: CoreModule,
      providers: [
        { provide: HOST_CONFIG, useValue: config },
        { provide: Clock, useValue: createClock(config.HOST_CLOCK_NOW) },
      ],
      exports: [HOST_CONFIG, Clock],
    };
  }
}
