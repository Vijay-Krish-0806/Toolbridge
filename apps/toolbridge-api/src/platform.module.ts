import {
  Global,
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnModuleInit,
} from '@nestjs/common';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { MongoSaver } from '@toolbridge/checkpoint-mongo';
import { OllamaEmbeddingProvider, ToolIndex } from '@toolbridge/retrieval';
import type { Connection } from 'mongoose';

import { AuditLog } from './audit/audit-log.js';
import { CoreModule, TOOL_INDEX } from './common/core.module.js';
import type { PlatformConfig } from './config.js';
import { ConnectionsService } from './connections/connections.service.js';
import { MODEL } from './domain/models.js';
import { EventLog } from './events/event-log.js';
import { PoliciesService } from './policies/policies.service.js';
import { RunQueue } from './runs/run-queue.js';
import { RunToolsService } from './runs/run-tools.js';
import { UserTokenStore } from './sessions/user-token-store.js';
import { SpecsService } from './specs/specs.service.js';

/** LangGraph's checkpointer (ADR 0030), shared by the API (reads run state) and the workers. */
export const CHECKPOINTER = Symbol('CHECKPOINTER');

/** Creates the checkpoint indexes once per process. */
@Injectable()
export class CheckpointSetup implements OnModuleInit {
  constructor(@Inject(CHECKPOINTER) private readonly saver: MongoSaver) {}

  async onModuleInit(): Promise<void> {
    await this.saver.setup();
  }
}

/**
 * What both processes need (Step 4.4a): the API (HTTP) and the worker (runs legs) are separate
 * programs that share the same domain code. This module holds that shared part: config, MongoDB,
 * specs, connections, policies, the audit log, the run's tools, the checkpointer and the queue.
 * Global, so the API's and the worker's own providers can inject these without re-importing.
 */
@Global()
@Module({})
export class PlatformModule {
  static register(config: PlatformConfig): DynamicModule {
    const shared = [
      SpecsService,
      ConnectionsService,
      PoliciesService,
      AuditLog,
      RunToolsService,
      RunQueue,
      EventLog,
      UserTokenStore,
    ];
    return {
      module: PlatformModule,
      imports: [
        CoreModule.register(config),
        MongooseModule.forRoot(config.MONGO_URI, {
          dbName: config.PLATFORM_MONGO_DB,
          autoIndex: false,
        }),
        MongooseModule.forFeature(Object.values(MODEL)),
      ],
      providers: [
        {
          provide: TOOL_INDEX,
          useFactory: (connection: Connection) => {
            if (!connection.db) throw new Error('MongoDB connection has no database yet.');
            return new ToolIndex(connection.db, new OllamaEmbeddingProvider(config.embedding));
          },
          inject: [getConnectionToken()],
        },
        {
          provide: CHECKPOINTER,
          useFactory: (connection: Connection) => {
            if (!connection.db) throw new Error('MongoDB connection has no database yet.');
            return new MongoSaver({ db: connection.db });
          },
          inject: [getConnectionToken()],
        },
        CheckpointSetup,
        ...shared,
      ],
      exports: [MongooseModule, TOOL_INDEX, CHECKPOINTER, ...shared],
    };
  }
}
