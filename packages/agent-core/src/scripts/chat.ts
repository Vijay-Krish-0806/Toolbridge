/**
 * A terminal chat with the store agent. Needs the local model and the running host API.
 *   pnpm --filter @toolbridge/agent-core chat                    interactive (/reset, /exit)
 *   pnpm --filter @toolbridge/agent-core chat "question"         one question, then exit
 *   pnpm --filter @toolbridge/agent-core chat --max-iterations 1 "question"
 */
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { type AgentEvent, type AgentLimits, runAgent } from '../agent/loop.js';
import { STORE_AGENT_SYSTEM_PROMPT } from '../agent/system-prompt.js';
import { loadHostApiConfig, loadLLMConfig } from '../config.js';
import { HostApiClient } from '../host-api/client.js';
import { createHostStoreTools } from '../host-api/tools.js';
import { OpenAICompatibleProvider } from '../llm/openai-compatible.js';
import type { ChatMessage } from '../llm/types.js';
import { ToolExecutor } from '../tools/executor.js';
import { ToolRegistry } from '../tools/registry.js';

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const clip = (text: string, max = 140): string =>
  text.length > max ? `${text.slice(0, max)}...` : text;

/** Prints one progress event as a short indented line, so you can watch the loop work. */
function printEvent(event: AgentEvent): void {
  switch (event.type) {
    case 'llm-response': {
      const { usage, message } = event.result;
      const tokens = usage
        ? `in ${String(usage.inputTokens)} / out ${String(usage.outputTokens)} tokens`
        : 'no usage';
      const action =
        message.toolCalls.length > 0
          ? `asks for ${String(message.toolCalls.length)} tool call(s)`
          : 'answers';
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
 * Wires the real pieces together (model, host API client, tools, executor) and returns a function
 * that answers one question, keeping the conversation between questions.
 */
function createSession(limits: Partial<AgentLimits>) {
  const llmConfig = loadLLMConfig();
  const llm = new OpenAICompatibleProvider(llmConfig);
  const registry = new ToolRegistry(createHostStoreTools(new HostApiClient(loadHostApiConfig())));
  const executor = new ToolExecutor(registry);
  const systemMessage: ChatMessage = { role: 'system', content: STORE_AGENT_SYSTEM_PROMPT };
  let history: ChatMessage[] = [systemMessage];

  return {
    model: llmConfig.model,
    /** Forgets the conversation, keeping only the system prompt. */
    reset: () => {
      history = [systemMessage];
    },
    /** Runs the agent on one question, prints the answer and a usage line, and keeps the history. */
    ask: async (question: string): Promise<void> => {
      const run = await runAgent({
        llm,
        registry,
        executor,
        messages: [...history, { role: 'user', content: question }],
        limits,
        onEvent: printEvent,
      });
      history = run.messages;

      const { usage } = run;
      console.log(
        run.stopReason === 'answer'
          ? `\nagent> ${run.answer}\n`
          : `\nagent stopped: ${run.stopReason}\n`,
      );
      console.log(
        `  [${String(usage.llmCalls)} model calls, ${String(usage.toolCalls)} tool calls, ` +
          `${String(usage.inputTokens)} in / ${String(usage.outputTokens)} out tokens]`,
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
