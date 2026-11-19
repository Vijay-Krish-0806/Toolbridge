import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { InjectConnection, MongooseModule } from '@nestjs/mongoose';
import type { SafeHttpClient } from '@toolbridge/agent-core';
import type { Connection } from 'mongoose';

import { Public } from './auth/auth.decorators.js';
import { PlatformAuthGuard } from './auth/platform-auth.guard.js';
import { CoreModule, OUTBOUND_HTTP } from './common/core.module.js';
import { CallsService } from './connections/calls.service.js';
import {
  AdminConnectionsController,
  ConnectionsController,
} from './connections/connections.controller.js';
import { ConnectionsService } from './connections/connections.service.js';
import type { PlatformConfig } from './config.js';
import { createIndexes, MODEL } from './domain/models.js';
import { SpecsController } from './specs/specs.controller.js';
import { SpecsService } from './specs/specs.service.js';
import { AdminTenantsController, TenantController } from './tenants/tenants.controller.js';
import { TenantsService } from './tenants/tenants.service.js';

/** Liveness check; the only route without a key. */
@Controller('health')
export class HealthController {
  @Get()
  @Public()
  check() {
    return { status: 'ok' };
  }
}

/** Startup and shutdown work: build indexes before serving, close the fetch pool on exit. */
@Injectable()
export class Lifecycle implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @Inject(OUTBOUND_HTTP) private readonly fetchClient: SafeHttpClient,
  ) {}

  /** The unique (tenantId, ...) indexes are part of correctness, so they exist before any request. */
  async onModuleInit(): Promise<void> {
    await createIndexes(this.connection);
  }

  /** Frees the HTTP connection pool. */
  onApplicationShutdown(): void {
    this.fetchClient.close();
  }
}

@Module({})
export class AppModule {
  /** Built from an already-validated config, so nothing below reads process.env directly. */
  static register(config: PlatformConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.register(config),
        MongooseModule.forRoot(config.MONGO_URI, {
          dbName: config.PLATFORM_MONGO_DB,
          autoIndex: false,
        }),
        MongooseModule.forFeature(Object.values(MODEL)),
      ],
      controllers: [
        HealthController,
        AdminTenantsController,
        AdminConnectionsController,
        TenantController,
        SpecsController,
        ConnectionsController,
      ],
      providers: [
        // Global: every route needs a key unless it is marked @Public().
        { provide: APP_GUARD, useClass: PlatformAuthGuard },
        TenantsService,
        SpecsService,
        ConnectionsService,
        CallsService,
        Lifecycle,
      ],
    };
  }
}
