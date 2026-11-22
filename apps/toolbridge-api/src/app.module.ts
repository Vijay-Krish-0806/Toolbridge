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
import { InjectConnection } from '@nestjs/mongoose';
import type { SafeHttpClient } from '@toolbridge/agent-core';
import type { ToolIndex } from '@toolbridge/retrieval';
import type { Connection } from 'mongoose';

import { AuditController } from './audit/audit.controller.js';
import { Public } from './auth/auth.decorators.js';
import { PlatformAuthGuard } from './auth/platform-auth.guard.js';
import { OUTBOUND_HTTP, TOOL_INDEX } from './common/core.module.js';
import { CallsService } from './connections/calls.service.js';
import {
  AdminConnectionsController,
  ConnectionsController,
} from './connections/connections.controller.js';
import type { PlatformConfig } from './config.js';
import { createIndexes } from './domain/models.js';
import { PlatformModule } from './platform.module.js';
import { PoliciesController } from './policies/policies.controller.js';
import { ApprovalsService } from './runs/approvals.service.js';
import { ApprovalsController, RunsController } from './runs/runs.controller.js';
import { RunsService } from './runs/runs.service.js';
import { SessionsController } from './sessions/sessions.controller.js';
import { SessionsService } from './sessions/sessions.service.js';
import { SpecsController } from './specs/specs.controller.js';
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

/**
 * Startup and shutdown work: build indexes (including the vector search index) before serving,
 * close the fetch pool on exit.
 */
@Injectable()
export class Lifecycle implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @Inject(OUTBOUND_HTTP) private readonly fetchClient: SafeHttpClient,
    @Inject(TOOL_INDEX) private readonly toolIndex: ToolIndex,
  ) {}

  /** The unique (tenantId, ...) indexes are part of correctness, so they exist before any request. */
  async onModuleInit(): Promise<void> {
    await createIndexes(this.connection);
    await this.toolIndex.ensureIndexes();
  }

  /** Frees the HTTP connection pool. */
  onApplicationShutdown(): void {
    this.fetchClient.close();
  }
}

/**
 * The HTTP API. Shared domain code comes from PlatformModule; agent runs are queued here and
 * executed by the worker program (WorkerModule), never inside the API process (Step 4.4a).
 */
@Module({})
export class AppModule {
  /** Built from an already-validated config, so nothing below reads process.env directly. */
  static register(config: PlatformConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [PlatformModule.register(config)],
      controllers: [
        HealthController,
        AdminTenantsController,
        AdminConnectionsController,
        TenantController,
        SpecsController,
        ConnectionsController,
        RunsController,
        ApprovalsController,
        AuditController,
        PoliciesController,
        SessionsController,
      ],
      providers: [
        // Global: every route needs a key unless it is marked @Public().
        { provide: APP_GUARD, useClass: PlatformAuthGuard },
        TenantsService,
        CallsService,
        RunsService,
        ApprovalsService,
        SessionsService,
        Lifecycle,
      ],
    };
  }
}
