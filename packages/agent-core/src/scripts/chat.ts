/**
 * A terminal chat with the store agent. Needs the local model and the running host API.
 *   pnpm --filter @toolbridge/agent-core chat                    interactive (/reset, /exit)
 *   pnpm --filter @toolbridge/agent-core chat "question"         one question, then exit
 *   pnpm --filter @toolbridge/agent-core chat --max-iterations 1 "question"
 *   pnpm --filter @toolbridge/agent-core chat --openapi "question"  use the tools generated from
 *     specs/host-store.json (+ overrides) instead of the five hand-written ones
 *   pnpm --filter @toolbridge/agent-core chat --openapi --retrieve 5 "question"  offer only the
 *     tools picked by vector search (Step 3.2; needs MongoDB and the embedding model)
 *   pnpm --filter @toolbridge/agent-core chat --openapi --knowledge "question"  add the
 *     knowledge_search tool over knowledge/host-store and check the answer's citations (Step 3.3)
 *   pnpm --filter @toolbridge/agent-core chat --openapi --role warehouse "question"  act as that
 *     role (Step 4.2): specs/host-store.policy.json decides which tools it may use. With
 *     --openapi the role defaults to support (the host login the agent uses); without --openapi
 *     there is no policy, because the policy is written for the generated tool names
 *   pnpm --filter @toolbridge/agent-core chat --engine loop "question"  run the raw loop instead of
 *     the LangGraph engine, the default since ADR 0025 (Step 4.1; works with every flag above)
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
import { createAuthorizer, parsePolicy } from '@toolbridge/policy';
import type { ToolDefinition as CompiledTool } from '@toolbridge/spec-compiler';
import { z } from 'zod';
import type { RunAccess } from '../agent/access.js';
import { ENGINES, type EngineName, parseEngineName } from '../agent/engines.js';
import type { AgentEvent, AgentLimits, AgentRunResult } from '../agent/run-types.js';
import { checkCitations, citationWarning, passageIds } from '../agent/citations.js';
import { storeAgentSystemPrompt } from '../agent/system-prompt.js';
import type { ToolSelector } from '../agent/tool-selector.js';
import { loadHostApiConfig, loadLLMConfig } from '../config.js';
import { HostApiClient } from '../host-api/client.js';
import { createHostStoreTools } from '../host-api/tools.js';
import { OpenAICompatibleProvider } from '../llm/openai-compatible.js';
import type { ChatMessage } from '../llm/types.js';
import { createFileLogger, logAgentEvent, logToolRetry } from '../logging/agent-logger.js';
import { ToolExecutor } from '../tools/executor.js';
import { ToolRegistry } from '../tools/registry.js';
import { KNOWLEDGE_TOOL_NAME } from '../tools/knowledge-tool.js';
import { createGeneratedTools } from './generated-tools.js';
import { createKnowledge } from './knowledge-setup.js';

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
 * Step 3.2: indexes the host tools (only changed ones are embedded) and returns a selector that
 * picks `k` of them per question. The index lives in its own database, apart from the platform's.
 * `close` ends the MongoDB connection, so the process can exit.
 */
async function createSelector(
  compiled: CompiledTool[],
  k: number,
  extraCore: string[],
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
    core: [...HOST_CORE_TOOLS, ...extraCore],
  });
  return { selector, close };
}

/**
 * Wires the real pieces together (model, host API client, tools, executor, logger) and returns a
 * function that answers one question, keeping the conversation between questions.
 */
async function createSession(options: {
  limits: Partial<AgentLimits>;
  openapi: boolean;
  retrieveK: number | undefined;
  knowledge: boolean;
  engine: EngineName;
  /** Who is chatting (Step 4.2). Set only with the generated tools, which the policy names. */
  access: RunAccess | undefined;
}) {
  const { limits, openapi, retrieveK } = options;
  const runEngine = ENGINES[options.engine];
  const llmConfig = loadLLMConfig();
  const llm = new OpenAICompatibleProvider(llmConfig);
  const generated = openapi ? await createGeneratedTools() : undefined;
  const knowledge = options.knowledge ? await createKnowledge(AGENT_DB) : undefined;
  const registry = new ToolRegistry([
    ...(generated?.tools ?? createHostStoreTools(new HostApiClient(loadHostApiConfig()))),
    ...(knowledge ? [knowledge.tool] : []),
  ]);
  // The tool index holds only API tools, so knowledge_search joins the always-offered core set.
  const retrieval =
    generated && retrieveK !== undefined
      ? await createSelector(generated.compiled, retrieveK, knowledge ? [KNOWLEDGE_TOOL_NAME] : [])
      : undefined;
  const selector = retrieval?.selector;
  const logger = createFileLogger(LOG_FILE);
  // The executor lives for the whole session, so retries log through whichever run is current.
  let runLogger = logger;
  const executor = new ToolExecutor(registry, {
    onRetry: (event) => {
      logToolRetry(runLogger, event);
    },
    // Layer 3: the executor gets its own reference to the rules, so it checks every call itself.
    ...(options.access && { authorizer: options.access.authorizer }),
  });
  const systemMessage: ChatMessage = {
    role: 'system',
    content: storeAgentSystemPrompt({ knowledge: knowledge !== undefined }),
  };
  let history: ChatMessage[] = [systemMessage];

  return {
    model: llmConfig.model,
    toolCount: registry.names().length,
    /** Closes the index connections that are open. */
    close: async () => {
      await retrieval?.close();
      await knowledge?.close();
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
      const retrieved = new Set<string>();

      let run: AgentRunResult;
      try {
        run = await runEngine({
          llm,
          registry,
          executor,
          messages: [...history, { role: 'user', content: question }],
          limits,
          ...(selector && { selector }),
          ...(options.access && { access: options.access }),
          onEvent: (event) => {
            if (event.type === 'tool-end') {
              for (const id of passageIds(event.call, event.result)) retrieved.add(id);
            }
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
      if (knowledge) {
        const citations = checkCitations(run.answer, retrieved);
        const warning = citationWarning(citations, retrieved.size, run.answer);
        runLogger.info({ citations, warning }, 'citations');
        console.log(`\n  [citations: ${citations.grounded.join(', ') || 'none'}]`);
        if (warning) console.log(`  warning: ${warning}`);
      }
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

/**
 * Loads the host-store policy and builds the access for one CLI user with `role`. The CLI has no
 * login, so the user id is a fixed "cli"; a real caller gets both from a verified token (4.4).
 * An unknown role is not an error here: the policy denies it every tool (deny by default).
 */
async function loadHostAccess(role: string): Promise<RunAccess> {
  const path = resolve(import.meta.dirname, '../../../../specs/host-store.policy.json');
  const policy = parsePolicy(JSON.parse(await readFile(path, 'utf8')));
  console.log(`role: ${role} (${path})`);
  return { principal: { userId: 'cli', role }, authorizer: createAuthorizer(policy) };
}

/** Reads flags, then runs either one question or an interactive prompt loop. */
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      'max-iterations': { type: 'string' },
      openapi: { type: 'boolean' },
      retrieve: { type: 'string' },
      knowledge: { type: 'boolean' },
      engine: { type: 'string' },
      role: { type: 'string' },
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
  const engine = parseEngineName(values.engine);
  if (values.role !== undefined && values.openapi !== true) {
    throw new Error('--role needs the generated tools (the policy names them): add --openapi.');
  }
  const access =
    values.openapi === true ? await loadHostAccess(values.role ?? 'support') : undefined;
  const session = await createSession({
    limits: maxIterations === undefined ? {} : { maxIterations },
    openapi: values.openapi === true,
    retrieveK,
    knowledge: values.knowledge === true,
    engine,
    access,
  });
  console.log(
    `${String(session.toolCount)} tools (${values.openapi === true ? 'generated from the spec' : 'hand-written'}), engine: ${engine}`,
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
