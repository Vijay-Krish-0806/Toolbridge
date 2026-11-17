/**
 * Acceptance check for Step 1.2: runs each host-store tool through the executor against the real,
 * running host API, then triggers each failure path. Needs `pnpm infra:up`, `pnpm seed` and
 * `pnpm start:host`. Note: the refund check creates one small pending refund; `pnpm seed` resets it.
 * Run with `pnpm --filter @toolbridge/agent-core tools:check`.
 */
import { loadHostApiConfig, type HostApiConfig } from '../config.js';
import { HostApiClient } from '../host-api/client.js';
import { createHostStoreTools } from '../host-api/tools.js';
import { type ToolExecutorOptions, type ToolResult, ToolExecutor } from '../tools/executor.js';
import { ToolRegistry } from '../tools/registry.js';

let failures = 0;
let callCount = 0;

/** Builds an executor over the five tools, optionally with a different account or URL. */
function executorFor(config: HostApiConfig, options: ToolExecutorOptions = {}): ToolExecutor {
  const registry = new ToolRegistry(createHostStoreTools(new HostApiClient(config)));
  return new ToolExecutor(registry, {
    onRetry: (e) => {
      console.log(
        `     retry ${String(e.attempt)} after ${e.error.code}, waiting ${String(e.delayMs)} ms`,
      );
    },
    ...options,
  });
}

/**
 * Runs one tool call, prints a one-line summary, and checks the result's `ok` flag (and error code,
 * when one is expected). Returns the parsed JSON on success, so later checks can reuse real data.
 */
async function check(
  label: string,
  executor: ToolExecutor,
  name: string,
  args: unknown,
  expected: { ok: true } | { ok: false; code: string },
): Promise<unknown> {
  callCount++;
  const raw = typeof args === 'string' ? args : JSON.stringify(args);
  const result: ToolResult = await executor.run({
    id: `call_${String(callCount)}`,
    name,
    arguments: raw,
  });
  const passed =
    result.ok === expected.ok &&
    (result.ok || (!expected.ok && result.error.code === expected.code));
  if (!passed) failures++;
  const summary = result.ok
    ? `ok, ${String(result.content.length)} chars: ${result.content.slice(0, 110)}...`
    : `error ${result.error.code}${result.error.status ? ` ${String(result.error.status)}` : ''}: ${result.error.message.split('\n').join(' ')}`;
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label}\n     ${summary}`);
  return result.ok ? JSON.parse(result.content) : undefined;
}

/**
 * Runs every check in order: the five tools on real data first, then each failure path.
 * The data each check needs (an order number, a customer id) comes from earlier results.
 */
async function main(): Promise<void> {
  const config = loadHostApiConfig();
  const support = executorFor(config);
  console.log(`Host API ${config.baseUrl} as ${config.email}\n`);

  console.log('-- The five tools against real data');
  const page = (await check(
    'list_orders (delivered, 3)',
    support,
    'list_orders',
    { status: 'delivered', limit: 3 },
    { ok: true },
  )) as { items: { number: string }[] } | undefined;
  const orderNumber = page?.items[0]?.number ?? 'ORD-10001';
  const order = (await check(
    `get_order ${orderNumber}`,
    support,
    'get_order',
    { orderNumber },
    { ok: true },
  )) as { customerId: string } | undefined;
  await check(
    'get_customer from that order',
    support,
    'get_customer',
    { customerId: order?.customerId },
    { ok: true },
  );
  await check(
    'list_products (search "lamp")',
    support,
    'list_products',
    { search: 'lamp', limit: 3 },
    { ok: true },
  );
  await check(
    `request_refund 100 cents on ${orderNumber}`,
    support,
    'request_refund',
    { orderNumber, amountCents: 100, reason: 'damaged' },
    { ok: true },
  );

  console.log('\n-- Failure paths (each must come back as a result, not a crash)');
  await check(
    'unknown tool',
    support,
    'delete_everything',
    {},
    { ok: false, code: 'unknown_tool' },
  );
  await check('invalid JSON', support, 'get_order', '{"orderNumber":', {
    ok: false,
    code: 'invalid_arguments',
  });
  await check(
    'schema violation',
    support,
    'get_order',
    { orderNumber: 42 },
    { ok: false, code: 'invalid_arguments' },
  );
  await check(
    'order that does not exist (404)',
    support,
    'get_order',
    { orderNumber: 'ORD-99999' },
    { ok: false, code: 'http_error' },
  );
  await check(
    'refund more than the order total (API rule)',
    support,
    'request_refund',
    { orderNumber, amountCents: 99_999_999, reason: 'damaged' },
    { ok: false, code: 'http_error' },
  );
  const warehouse = executorFor({ ...config, email: 'warehouse@store.example' });
  await check(
    'warehouse role refunds (403)',
    warehouse,
    'request_refund',
    { orderNumber, amountCents: 100, reason: 'damaged' },
    { ok: false, code: 'http_error' },
  );
  await check(
    '1 ms timeout on a read (retried twice)',
    executorFor(config, { timeoutMs: 1 }),
    'list_orders',
    {},
    { ok: false, code: 'timeout' },
  );

  const deadPort = { ...config, baseUrl: 'http://127.0.0.1:3999' };
  await check(
    'server down, read tool (retried twice)',
    executorFor(deadPort),
    'list_orders',
    {},
    { ok: false, code: 'network' },
  );
  await check(
    'server down, write tool (never retried)',
    executorFor(deadPort),
    'request_refund',
    { orderNumber, amountCents: 100, reason: 'damaged' },
    { ok: false, code: 'network' },
  );

  console.log(
    failures === 0 ? '\nAll tool checks passed.' : `\n${String(failures)} check(s) failed.`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
