/**
 * A terminal chat with the store agent. Needs the local model and the running host API.
 *   pnpm --filter @toolbridge/agent-core chat                    interactive (/reset, /exit)
 *   pnpm --filter @toolbridge/agent-core chat "question"         one question, then exit
 *   pnpm --filter @toolbridge/agent-core chat --max-iterations 1 "question"
 * Each run is logged as JSON lines to logs/agent.ndjson, tagged with its runId.
 */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { type AgentEvent, type AgentLimits, type AgentRunResult, runAgent } from '../agent/loop.js';
import { STORE_AGENT_SYSTEM_PROMPT } from '../agent/system-prompt.js';
import { loadHostApiConfig, loadLLMConfig } from '../config.js';
import { HostApiClient } from '../host-api/client.js';
import { createHostStoreTools } from '../host-api/tools.js';
import { OpenAICompatibleProvider } from '../llm/openai-compatible.js';
import type { ChatMessage } from '../llm/types.js';
import { createFileLogger, logAgentEvent, logToolRetry } from '../logging/agent-logger.js';
import { ToolExecutor } from '../tools/executor.js';
import { ToolRegistry } from '../tools/registry.js';

/** Where run logs go, relative to the folder the CLI runs in (packages/agent-core). */
const LOG_FILE = 'logs/agent.ndjson';
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
 * Wires the real pieces together (model, host API client, tools, executor, logger) and returns a
 * function that answers one question, keeping the conversation between questions.
 */
function createSession(limits: Partial<AgentLimits>) {
  const llmConfig = loadLLMConfig();
  const llm = new OpenAICompatibleProvider(llmConfig);
  const registry = new ToolRegistry(createHostStoreTools(new HostApiClient(loadHostApiConfig())));
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
    options: { 'max-iterations': { type: 'string' } },
    allowPositionals: true,
  });
  const maxIterations =
    values['max-iterations'] === undefined ? undefined : Number(values['max-iterations']);
  const session = createSession(maxIterations === undefined ? {} : { maxIterations });

  const question = positionals.join(' ').trim();
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
