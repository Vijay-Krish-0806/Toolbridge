/**
 * Step 2.5 acceptance check, through the official MCP client, over both transports:
 * - stdio: this script starts the server as a child process, as an MCP host would;
 * - Streamable HTTP: it starts the HTTP server as a child process and connects to /mcp.
 * On each it lists all tools, checks schemas and annotations, calls all 19 read tools, does one
 * harmless write pair (create a test coupon, then deactivate it), and checks error results.
 * Needs the host API running (`pnpm infra:up`, `pnpm start:host`); set HOST_API_URL if it is not
 * on :3000. Run with `pnpm --filter @toolbridge/mcp-server mcp:check`.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { ToolDefinition } from '@toolbridge/spec-compiler';

import { loadMcpServerConfig } from '../config.js';
import { createRuntime } from '../server.js';

const PACKAGE_DIR = resolve(import.meta.dirname, '../..');
const ENV_FILE = resolve(PACKAGE_DIR, '../../.env');
let failures = 0;
/** The staff role the server under test logs in as, and the tools only the owner may use. */
let role: 'support' | 'owner' = 'support';
let ownerOnly = new Set<string>();

/** Records and prints one check. */
function expectThat(label: string, condition: boolean, detail = ''): void {
  if (!condition) failures++;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? `\n     ${detail}` : ''}`);
}

/** The process environment as the plain string map the stdio transport wants. */
function childEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

interface CallOutcome {
  isError: boolean;
  text: string;
  json: unknown;
}

/** Calls a tool and returns its text, parsed JSON (when possible) and error flag. */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallOutcome> {
  const result = await client.callTool({ name, arguments: args });
  const first = result.content[0];
  const text = first?.type === 'text' ? first.text : '';
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: result.isError === true, text, json };
}

/** First item of a shaped page result, as a plain record. */
function firstItem(outcome: CallOutcome): Record<string, unknown> {
  const items = (outcome.json as { items?: Record<string, unknown>[] } | undefined)?.items;
  return items?.[0] ?? {};
}

/**
 * Checks one call against what the current role should get: success, or (for an owner-only tool
 * called as support) a 403 that comes back as a readable error. Permissions are the host API's;
 * the MCP server acts with exactly the rights of the account it logs in as.
 */
function expectOutcome(name: string, outcome: CallOutcome): void {
  if (role === 'support' && ownerOnly.has(name)) {
    expectThat(
      `  ${name} (owner only: refused for support)`,
      outcome.isError && outcome.text.includes('403'),
      outcome.text,
    );
  } else {
    expectThat(`  ${name}`, !outcome.isError, outcome.isError ? outcome.text : '');
  }
}

/** Calls one read tool and checks the outcome for the current role. Returns it for chaining. */
async function read(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallOutcome> {
  const outcome = await call(client, name, args);
  expectOutcome(name, outcome);
  return outcome;
}

/**
 * Runs every check against one connected client. `expected` is what the server should advertise
 * (compiled in-process from the same spec), so the comparison is against the source of truth.
 */
async function checkServer(
  client: Client,
  transport: string,
  expected: ToolDefinition[],
  as: 'support' | 'owner',
): Promise<void> {
  role = as;
  console.log(`\n== ${transport}, logged in to the host API as ${as}`);
  const info = client.getServerVersion();
  expectThat(
    `connected to "${String(info?.name)}" ${String(info?.version)}`,
    info?.name === 'toolbridge',
  );
  expectThat(
    'server sends instructions',
    (client.getInstructions() ?? '').includes('not instructions'),
  );

  const { tools } = await client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));
  expectThat(
    `lists ${String(tools.length)} tools (expected ${String(expected.length)})`,
    tools.length === expected.length,
  );
  expectThat(
    'every input schema is the compiled one, unchanged',
    expected.every(
      (d) => JSON.stringify(byName.get(d.name)?.inputSchema) === JSON.stringify(d.inputSchema),
    ),
  );
  const hints = (name: string) => byName.get(name)?.annotations ?? {};
  const reads = expected.filter((d) => d.safety === 'read');
  expectThat(
    `all ${String(reads.length)} read tools are readOnlyHint, no write tool is`,
    expected.every((d) => (hints(d.name).readOnlyHint === true) === (d.safety === 'read')),
  );
  expectThat(
    'orders_cancel is destructive (POST on an existing order, high risk)',
    hints('orders_cancel').destructiveHint === true,
  );
  expectThat(
    'customers_update is destructive (PATCH)',
    hints('customers_update').destructiveHint === true,
  );
  expectThat(
    'orders_create is additive (POST to a collection)',
    hints('orders_create').destructiveHint === false,
  );
  expectThat(
    'every tool says openWorldHint: false',
    tools.every((t) => t.annotations?.openWorldHint === false),
  );

  console.log('-- every read tool');
  const product = firstItem(await read(client, 'products_list', { limit: 2 }));
  await read(client, 'products_get', { sku: product.sku });
  await read(client, 'inventory_list', { limit: 2 });
  await read(client, 'inventory_for_product', { productId: product._id });
  const customer = firstItem(await read(client, 'customers_list', { limit: 2 }));
  await read(client, 'customers_get_by_id', { id: customer._id });
  await read(client, 'customers_list_orders', { id: customer._id, limit: 2 });
  const order = firstItem(await read(client, 'orders_list', { limit: 2 }));
  await read(client, 'orders_delayed', { limit: 2 });
  await read(client, 'orders_get', { number: order.number });
  const shipment = firstItem(await read(client, 'shipments_list', { limit: 2 }));
  await read(client, 'shipments_get', { trackingNumber: shipment.trackingNumber });
  const refund = firstItem(await read(client, 'refunds_list', { limit: 2 }));
  await read(client, 'refunds_get_by_id', { id: refund._id });
  const coupon = firstItem(await read(client, 'coupons_list', { limit: 2 }));
  await read(client, 'coupons_get_by_code', { code: coupon.code });
  await read(client, 'reports_sales', {});
  await read(client, 'reports_refunds', {});
  await read(client, 'forms_order_form', {});

  console.log('-- one harmless write pair: create a test coupon, then deactivate it');
  const code = `MCP${transport === 'stdio' ? 'S' : 'H'}${Date.now().toString(36).toUpperCase().slice(-8)}`;
  const created = await call(client, 'coupons_create', {
    code,
    kind: 'percent',
    value: 5,
    expiresAt: '2027-12-31T00:00:00.000Z',
    maxUses: 1,
  });
  expectOutcome('coupons_create', created);
  expectOutcome('coupons_deactivate', await call(client, 'coupons_deactivate', { code }));

  console.log('-- errors come back as results the model can read');
  const missing = await call(client, 'orders_get', { number: 'ORD-99999' });
  expectThat(
    '  404 from the API -> isError with the API message',
    missing.isError && missing.text.includes('404'),
    missing.text,
  );
  const invalid = await call(client, 'orders_get', { number: 42 });
  expectThat(
    '  wrong argument type -> isError (validation)',
    invalid.isError,
    invalid.text.split('\n')[0] ?? '',
  );
}

/**
 * Starts the HTTP server as a child process, logged in to the host API as `email`, and waits
 * until it prints its ready line. (Variables set here win over .env, which never overrides.)
 */
async function startHttpServer(email: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [`--env-file-if-exists=${ENV_FILE}`, 'dist/http.js'], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, HOST_API_EMAIL: email },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let log = '';
  child.stderr.on('data', (chunk: Buffer) => {
    log += chunk.toString();
  });
  for (let i = 0; i < 100 && !log.includes('/mcp'); i++) await sleep(100);
  if (!log.includes('/mcp')) {
    child.kill();
    throw new Error(`HTTP server did not start:\n${log}`);
  }
  return child;
}

/** Compiles the expected tools, then runs the checks over stdio and over HTTP. */
async function main(): Promise<void> {
  const config = loadMcpServerConfig();
  const runtime = await createRuntime(config);
  const expected = runtime.compiled.tools;
  runtime.close();
  // The spec says who may call what ("Allowed roles: owner." in the description).
  ownerOnly = new Set(
    expected.filter((d) => d.description.includes('Allowed roles: owner.')).map((d) => d.name),
  );
  console.log(`Host API ${config.hostApi.baseUrl}; expecting ${String(expected.length)} tools`);
  console.log(`Owner-only tools: ${[...ownerOnly].join(', ')}`);

  const stdioClient = new Client({ name: 'mcp-check', version: '1.0.0' });
  await stdioClient.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [`--env-file-if-exists=${ENV_FILE}`, resolve(PACKAGE_DIR, 'dist/stdio.js')],
      env: { ...childEnv(), HOST_API_EMAIL: 'support@store.example' },
      stderr: 'ignore',
    }),
  );
  await checkServer(stdioClient, 'stdio', expected, 'support');
  await stdioClient.close();

  const httpChild = await startHttpServer('owner@store.example');
  try {
    const url = new URL(`http://127.0.0.1:${String(config.httpPort)}/mcp`);
    const httpClient = new Client({ name: 'mcp-check', version: '1.0.0' });
    await httpClient.connect(new StreamableHTTPClientTransport(url));
    await checkServer(httpClient, 'http', expected, 'owner');
    await httpClient.close();

    console.log('-- HTTP safety');
    const evil = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: '{}',
    });
    expectThat(
      '  request from a foreign Origin is refused',
      evil.status === 403,
      `HTTP ${String(evil.status)}`,
    );
    const other = await fetch(new URL('/admin', url));
    expectThat(
      '  any path other than /mcp is 404',
      other.status === 404,
      `HTTP ${String(other.status)}`,
    );
  } finally {
    httpChild.kill();
  }

  console.log(
    failures === 0 ? '\nAll MCP checks passed.' : `\n${String(failures)} check(s) failed.`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
