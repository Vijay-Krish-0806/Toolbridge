/**
 * A terminal chat with the store agent. Needs the local model and the running host API.
 *   pnpm --filter @toolbridge/agent-core chat                    interactive (/reset, /exit)
 *   pnpm --filter @toolbridge/agent-core chat "question"         one question, then exit
 *   pnpm --filter @toolbridge/agent-core chat --max-iterations 1 "question"
 *   pnpm --filter @toolbridge/agent-core chat --openapi "question"  use the tools generated from
 *     specs/host-store.json (+ overrides) instead of the five hand-written ones
 *   pnpm --filter @toolbridge/agent-core chat --openapi --retrieve 5 "question"  offer only the
 *     tools picked by vector search (Step 3.2; needs MongoDB and the embedding model)
 * Each run is logged as JSON lines to logs/agent.ndjson, tagged with its runId.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import {
  connectToolIndex,
  DEFAULT_SELECTOR,
  loadEmbeddingConfig,
  VectorToolSelector,
} from '@toolbridge/retrieval';
import {
  compileTools,
  loadSpec,
  normalize,
  parseOverrides,
  type ToolDefinition as CompiledTool,
} from '@toolbridge/spec-compiler';
import { z } from 'zod';
import { type AgentEvent, type AgentLimits, type AgentRunResult, runAgent } from '../agent/loop.js';
import { STORE_AGENT_SYSTEM_PROMPT } from '../agent/system-prompt.js';
import type { ToolSelector } from '../agent/tool-selector.js';
import { loadHostApiConfig, loadLLMConfig } from '../config.js';
import { HostApiClient } from '../host-api/client.js';
import { createHostStoreTools } from '../host-api/tools.js';
import { TokenLogin } from '../openapi/auth.js';
import { createOpenApiTools } from '../openapi/generated-tools.js';
import { SafeHttpClient } from '../openapi/http-client.js';
import { OpenAICompatibleProvider } from '../llm/openai-compatible.js';
import type { ChatMessage } from '../llm/types.js';
import { createFileLogger, logAgentEvent, logToolRetry } from '../logging/agent-logger.js';
import { ToolExecutor } from '../tools/executor.js';
import { ToolRegistry } from '../tools/registry.js';
import type { Tool } from '../tools/tool.js';

/** Where run logs go, relative to the folder the CLI runs in (packages/agent-core). */
const LOG_FILE = 'logs/agent.ndjson';
/** The chat CLI's own tool index: one local "tenant" and the host spec. */
const AGENT_DB = 'toolbridge_agent';
const HOST_SCOPE = { tenantId: 'local', specId: 'host-store' };
/** Always offered: most store conversations start by looking up an order (Step 3.2 baseline). */
const HOST_CORE_TOOLS = ['orders_get'];
const GREY = '\x1b[90m';
const RESET = '\x1b[0m';

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const clip = (text: string, max = 140): string =>
  text.length > max ? `${text.slice(0, max)}...` : text;

/**
 * Returns a function that prints agent events to the terminal. Thinking streams in grey after
 * "thinking:", the answer streams after "agent>", and every other event is one indented line.
 * `mode` remembers what is being streamed, so a line break is added when the kind of output changes.
 */
function createPrinter(): (event: AgentEvent) => void {
  let mode: 'none' | 'reasoning' | 'text' = 'none';

  /** Ends any streamed output (and the grey colour) before printing a normal line. */
  const endStream = (): void => {
    if (mode !== 'none') process.stdout.write(`${RESET}\n`);
    mode = 'none';
  };

  return (event) => {
    switch (event.type) {
      case 'reasoning-delta':
        if (mode !== 'reasoning') {
          endStream();
          process.stdout.write(`${GREY}  thinking: `);
          mode = 'reasoning';
        }
        process.stdout.write(event.text);
        return;
      case 'text-delta':
        if (mode !== 'text') {
          endStream();
          process.stdout.write('\nagent> ');
          mode = 'text';
        }
        process.stdout.write(event.text);
        return;
      default:
        endStream();
        printStep(event);
    }
  };
}

/** Prints one completed step (a model call or a tool call) as a short indented line. */
function printStep(event: AgentEvent): void {
  switch (event.type) {
    case 'reasoning-delta':
    case 'text-delta':
      return;
    case 'tools-selected': {
      const { mode, topScore } = event.selection;
      const score = topScore === undefined ? '' : `, top score ${topScore.toFixed(3)}`;
      console.log(
        `  [retrieval] ${String(event.offered.length)} tools (${mode}${score}): ${event.offered.join(', ')}`,
      );
      return;
    }
    case 'llm-response': {
      const { usage, message } = event.result;
      const tokens = usage
        ? `in ${String(usage.inputTokens)} / out ${String(usage.outputTokens)} tokens`
        : 'no usage';
      const action =
        message.toolCalls.length > 0
          ? `asks for ${String(message.toolCalls.length)} tool call(s)`
          : 'answered';
      console.log(
        `  [model #${String(event.iteration)}] ${action}, ${seconds(event.durationMs)}, ${tokens}`,
      );
      return;
    }
    case 'tool-start':
      console.log(`    -> ${event.call.name} ${event.call.arguments}`);
      return;
    case 'tool-end': {
      const { result } = event;
      const outcome = result.ok
        ? `ok, ${String(result.content.length)} chars`
        : `error ${result.error.code}${result.error.status ? ` ${String(result.error.status)}` : ''}: ${clip(result.error.message)}`;
      console.log(`    <- ${event.call.name} ${outcome} (${seconds(event.durationMs)})`);
      return;
    }
  }
}

/**
 * Compiles the host spec and its overrides into tools (Steps 2.1 to 2.3) that call the host API
 * through the SSRF-safe client, logged in as the configured staff account. Also returns the
 * compiled definitions, which the tool index embeds.
 */
async function createGeneratedTools(): Promise<{ tools: Tool[]; compiled: CompiledTool[] }> {
  const config = loadHostApiConfig();
  const specs = resolve(import.meta.dirname, '../../../../specs');
  const { model } = normalize(await loadSpec(resolve(specs, 'host-store.json')));
  const overrides = parseOverrides(
    JSON.parse(await readFile(resolve(specs, 'host-store.overrides.json'), 'utf8')),
  );
  const client = new SafeHttpClient({ allowPrivateHosts: [new URL(config.baseUrl).hostname] });
  const auth = new TokenLogin({
    client,
    loginUrl: new URL('/auth/login', config.baseUrl),
    credentials: { email: config.email, password: config.password },
    tokenField: 'accessToken',
  });
  const { tools } = compileTools(model, overrides);
  return {
    tools: createOpenApiTools(tools, {
      baseUrl: config.baseUrl,
      securitySchemes: model.securitySchemes,
      auth,
      client,
    }),
    compiled: tools,
  };
}

/**
 * Step 3.2: indexes the host tools (only changed ones are embedded) and returns a selector that
 * picks `k` of them per question. The index lives in its own database, apart from the platform's.
 * `close` ends the MongoDB connection, so the process can exit.
 */
async function createSelector(
  compiled: CompiledTool[],
  k: number,
): Promise<{ selector: ToolSelector; close: () => Promise<void> }> {
  const { MONGO_URI } = z.object({ MONGO_URI: z.string().min(1) }).parse(process.env);
  const { index, close } = await connectToolIndex({
    mongoUri: MONGO_URI,
    dbName: AGENT_DB,
    embedding: loadEmbeddingConfig(),
  });
  const summary = await index.reindex(HOST_SCOPE, compiled);
  const last = compiled.at(-1);
  if (last && summary.unchanged < summary.total) await index.waitUntilSearchable(HOST_SCOPE, last);
  console.log(`tool index: ${JSON.stringify(summary)}`);
  const selector = new VectorToolSelector(index, HOST_SCOPE, {
    ...DEFAULT_SELECTOR,
    k,
    kFallback: Math.max(k, DEFAULT_SELECTOR.kFallback),
    core: HOST_CORE_TOOLS,
  });
  return { selector, close };
}

/**
 * Wires the real pieces together (model, host API client, tools, executor, logger) and returns a
 * function that answers one question, keeping the conversation between questions.
 */
async function createSession(
  limits: Partial<AgentLimits>,
  openapi: boolean,
  retrieveK: number | undefined,
) {
  const llmConfig = loadLLMConfig();
  const llm = new OpenAICompatibleProvider(llmConfig);
  const generated = openapi ? await createGeneratedTools() : undefined;
  const registry = new ToolRegistry(
    generated?.tools ?? createHostStoreTools(new HostApiClient(loadHostApiConfig())),
  );
  const retrieval =
    generated && retrieveK !== undefined
      ? await createSelector(generated.compiled, retrieveK)
      : undefined;
  const selector = retrieval?.selector;
  const logger = createFileLogger(LOG_FILE);
  // The executor lives for the whole session, so retries log through whichever run is current.
  let runLogger = logger;
  const executor = new ToolExecutor(registry, {
    onRetry: (event) => {
      logToolRetry(runLogger, event);
    },
  });
  const systemMessage: ChatMessage = { role: 'system', content: STORE_AGENT_SYSTEM_PROMPT };
  let history: ChatMessage[] = [systemMessage];

  return {
    model: llmConfig.model,
    toolCount: registry.names().length,
    /** Closes the tool index connection, if retrieval is on. */
    close: async () => {
      await retrieval?.close();
    },
    /** Forgets the conversation, keeping only the system prompt. */
    reset: () => {
      history = [systemMessage];
    },
    /**
     * Runs the agent on one question: streams its thinking and answer to the terminal, logs every
     * step under a new runId, prints a usage line, and keeps the history for the next question.
     */
    ask: async (question: string): Promise<void> => {
      const runId = randomUUID();
      runLogger = logger.child({ runId });
      runLogger.info({ model: llmConfig.model, question }, 'run-start');
      const print = createPrinter();

      let run: AgentRunResult;
      try {
        run = await runAgent({
          llm,
          registry,
          executor,
          messages: [...history, { role: 'user', content: question }],
          limits,
          ...(selector && { selector }),
          onEvent: (event) => {
            print(event);
            logAgentEvent(runLogger, event);
          },
        });
      } catch (error) {
        runLogger.error({ err: error }, 'run-failed');
        throw error;
      }
      history = run.messages;

      const { usage } = run;
      runLogger.info({ stopReason: run.stopReason, usage, answer: run.answer }, 'run-end');
      if (run.stopReason !== 'answer') console.log(`\nagent stopped: ${run.stopReason}`);
      console.log(
        `\n  [${String(usage.llmCalls)} model calls, ${String(usage.toolCalls)} tool calls, ` +
          `${String(usage.inputTokens)} in / ${String(usage.outputTokens)} out tokens]` +
          `\n  [run ${runId}, logged to ${LOG_FILE}]\n`,
      );
      // The context is the memory budget: past it, Ollama silently drops the oldest tokens.
      if (usage.lastInputTokens > 0.8 * llmConfig.contextLength) {
        console.log(
          `  warning: the last prompt used ${String(usage.lastInputTokens)} of ${String(llmConfig.contextLength)} context tokens. Use /reset soon.`,
        );
      }
    },
  };
}

/** Reads flags, then runs either one question or an interactive prompt loop. */
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      'max-iterations': { type: 'string' },
      openapi: { type: 'boolean' },
      retrieve: { type: 'string' },
    },
    allowPositionals: true,
  });
  const maxIterations =
    values['max-iterations'] === undefined ? undefined : Number(values['max-iterations']);
  const retrieveK = values.retrieve === undefined ? undefined : Number(values.retrieve);
  if (retrieveK !== undefined && (!Number.isInteger(retrieveK) || retrieveK < 1)) {
    throw new Error('--retrieve needs a whole number of tools, for example --retrieve 5.');
  }
  if (retrieveK !== undefined && values.openapi !== true) {
    throw new Error('--retrieve works with the generated tools: add --openapi.');
  }
  const session = await createSession(
    maxIterations === undefined ? {} : { maxIterations },
    values.openapi === true,
    retrieveK,
  );
  console.log(
    `${String(session.toolCount)} tools (${values.openapi === true ? 'generated from the spec' : 'hand-written'})`,
  );

  try {
    await converse(session, positionals.join(' ').trim());
  } finally {
    await session.close();
  }
}

/** Answers one question, or runs the interactive prompt loop when there is none. */
async function converse(
  session: Awaited<ReturnType<typeof createSession>>,
  question: string,
): Promise<void> {
  if (question) {
    console.log(`you> ${question}`);
    await session.ask(question);
    return;
  }

  console.log(`Store agent on ${session.model}. Commands: /reset, /exit\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('close', () => process.exit(0));
  for (;;) {
    const line = (await rl.question('you> ')).trim();
    if (line === '/exit') break;
    if (line === '/reset') {
      session.reset();
      console.log('  (conversation cleared)\n');
    } else if (line) {
      await session.ask(line);
    }
  }
  rl.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
