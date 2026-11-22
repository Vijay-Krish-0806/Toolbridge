import { Module, type DynamicModule } from '@nestjs/common';
import { type LLMProvider, OpenAICompatibleProvider } from '@toolbridge/agent-core';

import { AGENT_LLM } from '../common/core.module.js';
import type { PlatformConfig } from '../config.js';
import { PlatformModule } from '../platform.module.js';
import { RunExecutor } from './run-executor.js';
import { RunWorker } from './run-worker.js';

/** Replacements for tests: the e2e suite runs legs against a scripted model. */
export interface WorkerOverrides {
  llm?: LLMProvider;
}

/**
 * The worker program (Step 4.4a): no HTTP, only the run queue consumer. It shares the domain
 * code with the API through PlatformModule and adds the model and the leg executor.
 * apps/toolbridge-worker boots it with NestFactory.createApplicationContext.
 */
@Module({})
export class WorkerModule {
  static register(config: PlatformConfig, overrides: WorkerOverrides = {}): DynamicModule {
    return {
      module: WorkerModule,
      imports: [PlatformModule.register(config)],
      providers: [
        {
          provide: AGENT_LLM,
          useValue:
            overrides.llm ??
            new OpenAICompatibleProvider({
              baseURL: config.llm.baseURL,
              apiKey: config.llm.apiKey,
              model: config.llm.model,
              maxOutputTokens: config.llm.maxOutputTokens,
            }),
        },
        RunExecutor,
        RunWorker,
      ],
    };
  }
}
