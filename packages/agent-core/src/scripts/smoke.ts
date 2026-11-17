/**
 * One real tool-calling round trip against the configured local model, through our adapter.
 * Not a test: it needs a running model. Run with `pnpm --filter @toolbridge/agent-core smoke`.
 */
import { loadLLMConfig } from '../config.js';
import { OpenAICompatibleProvider } from '../llm/openai-compatible.js';
import type { ChatMessage, GenerateResult, ToolDefinition } from '../llm/types.js';

const getOrder: ToolDefinition = {
  name: 'get_order',
  description: 'Get one order by its id, including status and line items.',
  parameters: {
    type: 'object',
    properties: { orderId: { type: 'string', description: 'The order id, e.g. ORD-1001' } },
    required: ['orderId'],
  },
};

// A canned tool result: real tools arrive in Step 1.2.
const fakeOrder = { orderId: 'ORD-1001', status: 'shipped', carrier: 'DHL', items: 2 };

/**
 * Throws if `condition` is false. `asserts condition` tells TypeScript the condition holds after
 * this call, so the type narrows (for example, `call` is no longer possibly undefined).
 */
function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Smoke check failed: ${message}`);
}

/**
 * Checks that the model asked for `get_order` with orderId ORD-1001, and returns the call's id,
 * which the tool result message must echo back.
 */
function expectGetOrderCall(result: GenerateResult): string {
  const call = result.message.toolCalls[0];
  check(call?.name === 'get_order', `expected a get_order call, got ${JSON.stringify(result)}`);
  const args = JSON.parse(call.arguments) as { orderId?: unknown };
  check(args.orderId === 'ORD-1001', `unexpected arguments ${call.arguments}`);
  return call.id;
}

/** Runs `run`, prints how many seconds it took under `label`, and returns its result. */
async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const value = await run();
  console.log(`${label}: ${((performance.now() - start) / 1000).toFixed(1)}s`);
  return value;
}

/**
 * Runs the three checks in order: a tool call (not streamed), the same call streamed, and a
 * final answer after we send a tool result back. Any failed check throws and stops the run.
 */
async function main(): Promise<void> {
  const config = loadLLMConfig();
  console.log(
    `model=${config.model} baseURL=${config.baseURL} context=${String(config.contextLength)}`,
  );
  const llm = new OpenAICompatibleProvider(config);
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are a store operations assistant. Use the tools to answer.' },
    { role: 'user', content: 'What is the status of order ORD-1001?' },
  ];

  // 1. Not streamed: the model should ask for the tool.
  const first = await timed('1. generate (tool call)', () =>
    llm.generate({ messages, tools: [getOrder] }),
  );
  const callId = expectGetOrderCall(first);
  console.log('   tool call:', first.message.toolCalls[0], 'usage:', first.usage);

  // 2. Streamed: same request, the call must arrive whole after accumulation.
  const streamed = await timed('2. stream (tool call)', async () => {
    let done: GenerateResult | undefined;
    for await (const event of llm.stream({ messages, tools: [getOrder] })) {
      if (event.type === 'tool-call') console.log('   event tool-call:', event.toolCall);
      if (event.type === 'done') done = event.result;
    }
    check(done !== undefined, 'stream ended without a done event');
    return done;
  });
  expectGetOrderCall(streamed);

  // 3. Round trip: send the tool result back and expect a text answer that uses it.
  const final = await timed('3. generate (answer from tool result)', () =>
    llm.generate({
      messages: [
        ...messages,
        first.message,
        { role: 'tool', toolCallId: callId, content: JSON.stringify(fakeOrder) },
      ],
      tools: [getOrder],
    }),
  );
  check(final.message.toolCalls.length === 0, 'expected a text answer, got another tool call');
  check(
    /shipped/i.test(final.message.content),
    `answer ignored the tool result: ${final.message.content}`,
  );
  console.log('   answer:', final.message.content);
  console.log('Smoke test passed.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
