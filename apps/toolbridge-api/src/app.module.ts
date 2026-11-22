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
import { getConnectionToken, InjectConnection, MongooseModule } from '@nestjs/mongoose';
import {
  type LLMProvider,
  OpenAICompatibleProvider,
  type SafeHttpClient,
} from '@toolbridge/agent-core';
import { OllamaEmbeddingProvider, ToolIndex } from '@toolbridge/retrieval';
import type { Connection } from 'mongoose';

import { Public } from './auth/auth.decorators.js';
import { PlatformAuthGuard } from './auth/platform-auth.guard.js';
import { AGENT_LLM, CoreModule, OUTBOUND_HTTP, TOOL_INDEX } from './common/core.module.js';
import { CallsService } from './connections/calls.service.js';
import {
  AdminConnectionsController,
  ConnectionsController,
} from './connections/connections.controller.js';
import { ConnectionsService } from './connections/connections.service.js';
import type { PlatformConfig } from './config.js';
import { createIndexes, MODEL } from './domain/models.js';
import { ApprovalsService } from './runs/approvals.service.js';
import { RunToolsService } from './runs/run-tools.js';
import { ApprovalsController, RunsController } from './runs/runs.controller.js';
import { RunsService } from './runs/runs.service.js';
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

/** Replacements for tests: the e2e suite runs agent runs against a scripted model. */
export interface AppOverrides {
  llm?: LLMProvider;
}

@Module({})
export class AppModule {
  /** Built from an already-validated config, so nothing below reads process.env directly. */
  static register(config: PlatformConfig, overrides: AppOverrides = {}): DynamicModule {
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
        RunsController,
        ApprovalsController,
      ],
      providers: [
        // Global: every route needs a key unless it is marked @Public().
        { provide: APP_GUARD, useClass: PlatformAuthGuard },
        {
          provide: TOOL_INDEX,
          useFactory: (connection: Connection) => {
            if (!connection.db) throw new Error('MongoDB connection has no database yet.');
            return new ToolIndex(connection.db, new OllamaEmbeddingProvider(config.embedding));
          },
          inject: [getConnectionToken()],
        },
        TenantsService,
        SpecsService,
        ConnectionsService,
        CallsService,
        {
          provide: AGENT_LLM,
          useValue:
            overrides.llm ??
            new OpenAICompatibleProvider({
              baseURL: config.llm.baseURL,
              apiKey: config.llm.apiKey,
              model: config.llm.model,
            }),
        },
        RunToolsService,
        RunsService,
        ApprovalsService,
        Lifecycle,
      ],
    };
  }
}
