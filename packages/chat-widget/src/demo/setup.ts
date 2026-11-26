/**
 * `pnpm demo:setup` (Step 7.0): prepares a ToolBridge tenant for the host-store demo, through the
 * platform API like any customer would: the host store spec, a connection, write tools enabled,
 * the host policy, DELEGATED credentials (each user's own host token), and the demo origins.
 *
 * It writes the tenant API key to `.env.local` files (git-ignored) for the demo host backends,
 * and never prints it. Running it again reuses the tenant whose key is already in `.env.local`.
 * Needs the platform API running, with PLATFORM_ALLOW_PRIVATE_HOSTS=localhost so it may call the
 * host API on this machine.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.TOOLBRIDGE_API_URL ?? 'http://127.0.0.1:4000';
const HOST_API = 'http://localhost:3000';
/** The demo host pages (this package's demo server, and apps/host-store-web in Step 7.0 b). */
const ORIGINS = ['http://localhost:3001', 'http://127.0.0.1:3001'];
const repo = (path: string) => fileURLToPath(new URL(`../../../../${path}`, import.meta.url));
/** Where the key is written (git-ignored: the root .gitignore has `.env.*`). */
const ENV_FILES = [repo('packages/chat-widget/.env.local'), repo('apps/host-store-web/.env.local')];

/** Reads a required environment variable, or stops with a clear message. */
function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example).`);
  return value;
}

/** One platform API call; fails loudly with the API's own message. */
async function call<T>(method: string, path: string, key: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${String(response.status)} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** The key already written by an earlier run, if it still works. */
async function existingKey(): Promise<string | undefined> {
  const file = ENV_FILES[0];
  if (!file || !existsSync(file)) return undefined;
  const key = /^TOOLBRIDGE_API_KEY=(.+)$/m.exec(readFileSync(file, 'utf8'))?.[1];
  if (!key) return undefined;
  const response = await fetch(`${API}/me`, { headers: { authorization: `Bearer ${key}` } });
  return response.ok ? key : undefined;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(repo(path), 'utf8'));

let key = await existingKey();
if (key) {
  console.log('Reusing the demo tenant from .env.local.');
} else {
  const created = await call<{ apiKey: string }>(
    'POST',
    '/admin/tenants',
    need('PLATFORM_ADMIN_KEY'),
    {
      name: 'Host Store (demo)',
    },
  );
  key = created.apiKey;
  console.log('Created the demo tenant.');
}

const specs = await call<{ id: string; name: string }[]>('GET', '/specs', key);
let specId = specs.find((s) => s.name === 'host-store')?.id;
if (!specId) {
  const registered = await call<{ spec: { id: string } }>('POST', '/specs', key, {
    name: 'host-store',
    document: readJson('specs/host-store.json'),
    overrides: readJson('specs/host-store.overrides.json'),
  });
  specId = registered.spec.id;
}
// The service login stays as the connection's credential (and the base URL); delegated runs use
// each user's own host token instead, so it is only used if the tenant switches back to service.
await call('PUT', `/specs/${specId}/connection`, key, {
  baseUrl: HOST_API,
  authKind: 'login',
  loginPath: '/auth/login',
  loginFields: { email: need('HOST_API_EMAIL'), password: need('HOST_API_PASSWORD') },
  // Step 4.5: the host store reads idempotency keys, so writes are safe to retry.
  idempotencyHeader: 'Idempotency-Key',
  // Step 4.8: reads may be reused for a minute; writes through the platform end that at once.
  cacheTtlSeconds: 60,
});
for (const tool of ['refunds_request', 'orders_update_notes']) {
  await call('PATCH', `/specs/${specId}/tools/${tool}`, key, { enabled: true });
}
await call('PUT', `/specs/${specId}/policy`, key, {
  policy: readJson('specs/host-store.policy.json'),
});
await call('PUT', '/tenant/credential-mode', key, { mode: 'delegated' });
await call('PUT', '/tenant/origins', key, { origins: ORIGINS });

const env = `# Written by pnpm demo:setup. Git-ignored; never commit. The key stays on the server side.
TOOLBRIDGE_API_URL=${API}
TOOLBRIDGE_API_KEY=${key}
TOOLBRIDGE_SPEC_ID=${specId}
`;
for (const file of ENV_FILES) {
  // Only next to apps that exist (apps/host-store-web arrives in Step 7.0 b).
  if (existsSync(dirname(file))) {
    writeFileSync(file, env, { mode: 0o600 });
    console.log(`Wrote ${file.replace(repo(''), '')}`);
  }
}
console.log(`Spec ${specId}: delegated credentials, origins ${ORIGINS.join(', ')}.`);
// Documents are loaded by the operator, not through the API (ADR 0054), so this is only a hint.
const { id: tenantId } = await call<{ id: string }>('GET', '/me', key);
console.log('To let the chat search the store policies:');
console.log(
  `  pnpm --filter @toolbridge/toolbridge-api knowledge:load --tenant ${tenantId} --spec ${specId} --dir knowledge/host-store`,
);
