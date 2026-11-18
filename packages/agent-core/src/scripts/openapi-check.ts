/**
 * Step 2.3a acceptance check: the tools generated from specs/host-store.json must reproduce the
 * five hand-written tools (same data, same failure paths), and the HTTP layer must refuse unsafe
 * destinations. Needs `pnpm infra:up`, `pnpm seed` and `pnpm start:host`.
 * Note: one check creates a small pending refund; `pnpm seed` resets it.
 * Run with `pnpm --filter @toolbridge/agent-core openapi:check`.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  compileTools,
  loadSpec,
  normalize,
  parseOverrides,
  type ApiModel,
  type SecurityScheme,
  type ToolDefinition,
} from '@toolbridge/spec-compiler';

import { loadHostApiConfig, type HostApiConfig } from '../config.js';
import { HostApiClient } from '../host-api/client.js';
import { createHostStoreTools } from '../host-api/tools.js';
import { type AuthProvider, StaticCredentials, TokenLogin } from '../openapi/auth.js';
import { createOpenApiTools } from '../openapi/generated-tools.js';
import { SafeHttpClient } from '../openapi/http-client.js';
import { type ToolExecutorOptions, type ToolResult, ToolExecutor } from '../tools/executor.js';
import { ToolRegistry } from '../tools/registry.js';

const SPECS = resolve(import.meta.dirname, '../../../../specs');
let failures = 0;
let callCount = 0;
const clients: SafeHttpClient[] = [];

/** Loads the host spec and overrides and compiles them, exactly as Step 2.2 does. */
async function compileHostTools(): Promise<{ model: ApiModel; tools: ToolDefinition[] }> {
  const { model } = normalize(await loadSpec(resolve(SPECS, 'host-store.json')));
  const overrides = parseOverrides(
    JSON.parse(await readFile(resolve(SPECS, 'host-store.overrides.json'), 'utf8')),
  );
  return { model, tools: compileTools(model, overrides).tools };
}

interface Setup {
  baseUrl: string;
  auth?: AuthProvider;
  /** Allowlist the base URL's host for private addresses (needed for 127.0.0.1). Default true. */
  allowPrivate?: boolean;
  executor?: ToolExecutorOptions;
}

/** Builds an executor over the generated tools with the given base URL, auth and allowlist. */
function generatedExecutor(
  defs: ToolDefinition[],
  schemes: Record<string, SecurityScheme>,
  setup: Setup,
): ToolExecutor {
  const host = new URL(setup.baseUrl).hostname;
  const client = new SafeHttpClient({
    allowPrivateHosts: setup.allowPrivate === false ? [] : [host],
  });
  clients.push(client);
  const tools = createOpenApiTools(defs, {
    baseUrl: setup.baseUrl,
    securitySchemes: schemes,
    client,
    ...(setup.auth && { auth: setup.auth }),
  });
  return new ToolExecutor(new ToolRegistry(tools), setup.executor);
}

/** A login provider for one staff account, using the client's allowlist for the host. */
function loginAs(config: HostApiConfig, email: string, password = config.password): TokenLogin {
  const client = new SafeHttpClient({ allowPrivateHosts: [new URL(config.baseUrl).hostname] });
  clients.push(client);
  return new TokenLogin({
    client,
    loginUrl: new URL('/auth/login', config.baseUrl),
    credentials: { email, password },
    tokenField: 'accessToken',
  });
}

/**
 * Wraps a provider so its first token is a bad one: proves that a 401 makes the tool log in
 * again and retry once (what happens when a cached token expires mid-run).
 */
function expiredFirst(inner: AuthProvider): AuthProvider {
  let expired = true;
  return {
    secretFor: (name, scheme, signal) =>
      expired ? Promise.resolve('expired-token') : inner.secretFor(name, scheme, signal),
    invalidate: () => {
      expired = false;
      return inner.invalidate?.() ?? true;
    },
  };
}

/**
 * Runs one tool call, prints a one-line summary, and checks the `ok` flag and error code.
 * Returns the parsed JSON on success, so later checks can reuse real data.
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
    ? `ok, ${String(result.content.length)} chars: ${result.content.slice(0, 100)}...`
    : `error ${result.error.code}${result.error.status ? ` ${String(result.error.status)}` : ''}: ${result.error.message.split('\n').join(' ')}`;
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label}\n     ${summary}`);
  if (!result.ok) return undefined;
  try {
    return JSON.parse(result.content) as unknown;
  } catch {
    return result.content; // truncated by the executor's result cap: no longer valid JSON
  }
}

/** Compares a generated tool's result with the hand-written tool's result on the same input. */
function same(label: string, generated: unknown, handWritten: unknown): void {
  const passed = JSON.stringify(generated) === JSON.stringify(handWritten);
  if (!passed) failures++;
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label}`);
}

/**
 * Step 2.3b: a shaped generated result must be about as small as the hand-shaped Phase 1 one.
 * Passes at up to 1.5x, because generated lists also keep `_id` (later tools chain by id).
 */
function compact(label: string, generated: unknown, handWritten: unknown): void {
  const g = JSON.stringify(generated).length;
  const h = JSON.stringify(handWritten).length;
  const passed = g <= 1.5 * h;
  if (!passed) failures++;
  console.log(
    `${passed ? 'PASS' : 'FAIL'} ${label}: ${String(g)} chars vs ${String(h)} hand-shaped (${(g / h).toFixed(2)}x)`,
  );
}

/** Records a pass or failure for a plain condition. */
function expectThat(label: string, condition: boolean): void {
  if (!condition) failures++;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}`);
}

/** Runs every check in order: parity with the hand-written tools, failure paths, then safety. */
async function main(): Promise<void> {
  const config = loadHostApiConfig();
  const { model, tools } = await compileHostTools();
  const schemes = model.securitySchemes;
  const support = generatedExecutor(tools, schemes, {
    baseUrl: config.baseUrl,
    auth: loginAs(config, config.email),
  });
  const handWritten = new ToolExecutor(
    new ToolRegistry(createHostStoreTools(new HostApiClient(config))),
  );
  console.log(
    `Host API ${config.baseUrl} as ${config.email}; ${String(tools.length)} generated tools\n`,
  );

  console.log('-- Generated tools on real data, compared with the hand-written ones');
  const page = (await check(
    'orders_list (delivered, 3)',
    support,
    'orders_list',
    { status: 'delivered', limit: 3 },
    { ok: true },
  )) as { items: { number: string; _id: string }[] } | undefined;
  const first = page?.items[0];
  const orderNumber = first?.number ?? 'ORD-10001';
  const handPage = (await check(
    'list_orders (hand-written)',
    handWritten,
    'list_orders',
    { status: 'delivered', limit: 3 },
    { ok: true },
  )) as { orders: { number: string }[] } | undefined;
  same(
    '  same three orders in the same order',
    page?.items.map((o) => o.number),
    handPage?.orders.map((o) => o.number),
  );

  const byNumber = (await check(
    `orders_get by number ${orderNumber}`,
    support,
    'orders_get',
    { number: orderNumber },
    { ok: true },
  )) as { _id: string; customerId: string } | undefined;
  const handOrder = await check(
    `get_order ${orderNumber} (hand-written)`,
    handWritten,
    'get_order',
    { orderNumber },
    { ok: true },
  );
  same('  identical order data', byNumber, handOrder);
  const byId = await check(
    'orders_get by id (second variant of the merged tool)',
    support,
    'orders_get',
    { id: byNumber?._id },
    { ok: true },
  );
  same('  same order either way', byId, byNumber);

  const customer = await check(
    'customers_get_by_id from that order',
    support,
    'customers_get_by_id',
    { id: byNumber?.customerId },
    { ok: true },
  );
  const handCustomer = await check(
    'get_customer (hand-written)',
    handWritten,
    'get_customer',
    { customerId: byNumber?.customerId },
    { ok: true },
  );
  same('  identical customer data', customer, handCustomer);

  const products = (await check(
    'products_list (search "lamp")',
    support,
    'products_list',
    { search: 'lamp', limit: 3 },
    { ok: true },
  )) as { items: { sku: string }[] } | undefined;
  const handProducts = (await check(
    'list_products (hand-written)',
    handWritten,
    'list_products',
    { search: 'lamp', limit: 3 },
    { ok: true },
  )) as { products: { sku: string }[] } | undefined;
  same(
    '  same products',
    products?.items.map((p) => p.sku),
    handProducts?.products.map((p) => p.sku),
  );

  console.log('\n-- Result shaping (2.3b)');
  compact('  orders_list is compact', page, handPage);
  compact('  products_list is compact', products, handProducts);
  const big = (await check(
    'orders_list, 40 per page',
    support,
    'orders_list',
    { limit: 40 },
    { ok: true },
  )) as { total: number; hasMore: boolean; nextPage: number | null } | undefined;
  expectThat(
    `  pagination hint: total ${String(big?.total)}, hasMore ${String(big?.hasMore)}, nextPage ${String(big?.nextPage)}`,
    big !== undefined && big.total > 40 && big.hasMore && big.nextPage === 2,
  );
  const lastPage = Math.ceil((big?.total ?? 1) / 40);
  const last = (await check(
    `orders_list, last page (${String(lastPage)})`,
    support,
    'orders_list',
    { limit: 40, page: lastPage },
    { ok: true },
  )) as { hasMore: boolean; nextPage: number | null } | undefined;
  expectThat(
    '  last page says hasMore false, nextPage null',
    last?.hasMore === false && last.nextPage === null,
  );
  const truncated = await check(
    'orders_list, 100 per page (over the 8,000-char cap)',
    support,
    'orders_list',
    { limit: 100 },
    { ok: true },
  );
  expectThat(
    '  truncated, but the paging hint survived (it comes before the items)',
    typeof truncated === 'string' &&
      truncated.includes('"hasMore":true') &&
      truncated.includes('[truncated'),
  );
  const delayed = (await check(
    'orders_delayed (nested allowlist)',
    support,
    'orders_delayed',
    { limit: 2 },
    { ok: true },
  )) as { items: { order?: Record<string, unknown>; daysLate?: number }[] } | undefined;
  const firstDelayed = delayed?.items[0];
  expectThat(
    '  nested fields kept (order.number, daysLate), order line items dropped',
    firstDelayed === undefined ||
      (typeof firstDelayed.order?.number === 'string' &&
        typeof firstDelayed.daysLate === 'number' &&
        firstDelayed.order.items === undefined),
  );
  const detail = (await check(
    'customers_get_by_id keeps every field (no allowlist on detail tools)',
    support,
    'customers_get_by_id',
    { id: byNumber?.customerId },
    { ok: true },
  )) as Record<string, unknown> | undefined;
  expectThat(
    '  detail still has notes and address',
    detail !== undefined && 'notes' in detail && 'address' in detail,
  );

  await check(
    `refunds_request 100 cents on ${orderNumber} (uses the order id from orders_get)`,
    support,
    'refunds_request',
    {
      orderId: byNumber?._id,
      amountCents: 100,
      reason: 'damaged',
    },
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
  await check('invalid JSON', support, 'orders_get', '{"number":', {
    ok: false,
    code: 'invalid_arguments',
  });
  await check(
    'schema violation (number must be a string)',
    support,
    'orders_get',
    { number: 42 },
    { ok: false, code: 'invalid_arguments' },
  );
  await check(
    'merged tool with neither id nor number',
    support,
    'orders_get',
    {},
    { ok: false, code: 'invalid_arguments' },
  );
  await check(
    'order that does not exist (404)',
    support,
    'orders_get',
    { number: 'ORD-99999' },
    { ok: false, code: 'http_error' },
  );
  await check(
    'refund more than the order total (API rule)',
    support,
    'refunds_request',
    {
      orderId: byNumber?._id,
      amountCents: 99_999_999,
      reason: 'damaged',
    },
    { ok: false, code: 'http_error' },
  );
  const warehouse = generatedExecutor(tools, schemes, {
    baseUrl: config.baseUrl,
    auth: loginAs(config, 'warehouse@store.example'),
  });
  await check(
    'warehouse role requests a refund (403)',
    warehouse,
    'refunds_request',
    {
      orderId: byNumber?._id,
      amountCents: 100,
      reason: 'damaged',
    },
    { ok: false, code: 'http_error' },
  );
  await check(
    '1 ms timeout on a read (retried twice)',
    generatedExecutor(tools, schemes, {
      baseUrl: config.baseUrl,
      auth: loginAs(config, config.email),
      executor: { timeoutMs: 1 },
    }),
    'orders_list',
    {},
    { ok: false, code: 'timeout' },
  );
  const dead = { baseUrl: 'http://127.0.0.1:3999', auth: new StaticCredentials({ bearer: 'x' }) };
  await check(
    'server down, read tool (retried twice)',
    generatedExecutor(tools, schemes, dead),
    'orders_list',
    {},
    { ok: false, code: 'network' },
  );
  await check(
    'server down, write tool (never retried)',
    generatedExecutor(tools, schemes, dead),
    'orders_cancel',
    {
      id: byNumber?._id,
      reason: 'test',
    },
    { ok: false, code: 'network' },
  );

  console.log('\n-- Auth');
  await check(
    'expired token: 401, logs in again, retries once',
    generatedExecutor(tools, schemes, {
      baseUrl: config.baseUrl,
      auth: expiredFirst(loginAs(config, config.email)),
    }),
    'orders_get',
    { number: orderNumber },
    { ok: true },
  );
  await check(
    'bad static token: 401 comes back to the model',
    generatedExecutor(tools, schemes, {
      baseUrl: config.baseUrl,
      auth: new StaticCredentials({ bearer: 'not-a-real-token' }),
    }),
    'orders_list',
    {},
    { ok: false, code: 'http_error' },
  );
  await check(
    'wrong password: login fails clearly',
    generatedExecutor(tools, schemes, {
      baseUrl: config.baseUrl,
      auth: loginAs(config, config.email, 'wrong-password'),
    }),
    'orders_list',
    {},
    { ok: false, code: 'http_error' },
  );
  await check(
    'no credentials configured',
    generatedExecutor(tools, schemes, { baseUrl: config.baseUrl }),
    'orders_list',
    {},
    {
      ok: false,
      code: 'internal',
    },
  );

  console.log('\n-- Safety (SSRF and path tricks)');
  const noAllowlist = { auth: new StaticCredentials({ bearer: 'x' }), allowPrivate: false };
  await check(
    '127.0.0.1 without allowlist',
    generatedExecutor(tools, schemes, { ...noAllowlist, baseUrl: config.baseUrl }),
    'orders_list',
    {},
    {
      ok: false,
      code: 'blocked',
    },
  );
  await check(
    '"localhost" (checked inside DNS lookup)',
    generatedExecutor(tools, schemes, {
      ...noAllowlist,
      baseUrl: config.baseUrl.replace('127.0.0.1', 'localhost'),
    }),
    'orders_list',
    {},
    { ok: false, code: 'blocked' },
  );
  await check(
    'cloud metadata address 169.254.169.254',
    generatedExecutor(tools, schemes, {
      ...noAllowlist,
      baseUrl: 'http://169.254.169.254',
    }),
    'orders_list',
    {},
    { ok: false, code: 'blocked' },
  );
  await check(
    'IPv6 loopback [::1]',
    generatedExecutor(tools, schemes, { ...noAllowlist, baseUrl: 'http://[::1]:3000' }),
    'orders_list',
    {},
    {
      ok: false,
      code: 'blocked',
    },
  );
  await check(
    'path value ".."',
    support,
    'orders_get',
    { number: '..' },
    { ok: false, code: 'blocked' },
  );
  await check(
    'path value with slashes stays one segment (404, not another route)',
    support,
    'orders_get',
    {
      number: '../../customers',
    },
    { ok: false, code: 'http_error' },
  );

  console.log(
    failures === 0
      ? '\nAll generated-tool checks passed.'
      : `\n${String(failures)} check(s) failed.`,
  );
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const client of clients) client.close();
  });
