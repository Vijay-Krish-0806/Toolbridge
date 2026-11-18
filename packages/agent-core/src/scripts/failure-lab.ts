/**
 * Failure lab for Step 1.4: what happens when one tool result is bigger than the context window?
 * It fetches 100 orders straight from the host API (bypassing the tools' page cap), hands that raw
 * result to the model as if a tool had returned it, and asks about the FIRST order in the list.
 * Needs the local model and the running host API.
 * Run with `pnpm --filter @toolbridge/agent-core failure-lab`.
 */
import { STORE_AGENT_SYSTEM_PROMPT } from '../agent/system-prompt.js';
import { loadHostApiConfig, loadLLMConfig } from '../config.js';
import { HostApiClient } from '../host-api/client.js';
import { shapeOrderPage } from '../host-api/shaping.js';
import { OpenAICompatibleProvider } from '../llm/openai-compatible.js';
import type { ChatMessage } from '../llm/types.js';
import { DEFAULT_MAX_RESULT_CHARS, truncateResult } from '../tools/executor.js';

interface OrderPage {
  items: { number: string; totalCents: number }[];
}

/**
 * Builds a conversation where the model already "called" list_orders and got `content` back,
 * then asks it about the first order. Returns the model's answer and how many prompt tokens
 * the server reports it actually processed.
 */
async function askAboutFirstOrder(
  llm: OpenAICompatibleProvider,
  content: string,
): Promise<{ answer: string; inputTokens: number | undefined; seconds: number }> {
  const messages: ChatMessage[] = [
    { role: 'system', content: STORE_AGENT_SYSTEM_PROMPT },
    { role: 'user', content: 'List the most recent orders.' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_lab', name: 'list_orders', arguments: '{"limit":100}' }],
    },
    { role: 'tool', toolCallId: 'call_lab', content },
    {
      role: 'user',
      content: 'What is the order number and the total of the FIRST order in that list?',
    },
  ];
  const started = performance.now();
  const result = await llm.generate({ messages });
  return {
    answer: result.message.content,
    inputTokens: result.usage?.inputTokens,
    seconds: (performance.now() - started) / 1000,
  };
}

/**
 * Runs the oversized-result scenario three ways and prints what the model processed and answered:
 * A. the raw result (before the fix), B. the raw result cut by the executor's truncation rule,
 * C. the shaped result, then truncated: what list_orders now delivers.
 */
async function main(): Promise<void> {
  const llmConfig = loadLLMConfig();
  const llm = new OpenAICompatibleProvider(llmConfig);
  const api = new HostApiClient(loadHostApiConfig());

  const raw = JSON.stringify(await api.get('/orders', { limit: 100 }));
  const first = (JSON.parse(raw) as OrderPage).items[0];
  console.log(`model=${llmConfig.model} context=${String(llmConfig.contextLength)} tokens`);
  console.log(`expected answer: ${first?.number ?? '?'}, ${String(first?.totalCents)} cents\n`);

  const shaped = JSON.stringify(shapeOrderPage(JSON.parse(raw)));
  const scenarios: [string, string][] = [
    ['A. raw result (before)', raw],
    ['B. raw, truncated', truncateResult(raw, DEFAULT_MAX_RESULT_CHARS)],
    [
      `C. shaped (${String(shaped.length)} chars), then truncated`,
      truncateResult(shaped, DEFAULT_MAX_RESULT_CHARS),
    ],
  ];
  for (const [label, content] of scenarios) {
    console.log(`-- ${label}: model receives ${String(content.length)} chars`);
    const run = await askAboutFirstOrder(llm, content);
    console.log(
      `   prompt tokens processed: ${String(run.inputTokens)} (${run.seconds.toFixed(1)}s)`,
    );
    console.log(`   answer: ${run.answer.replace(/\s+/g, ' ')}\n`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
