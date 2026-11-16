/**
 * Access check: proves the role rules in the OpenAPI spec are what the API enforces.
 *
 * For every operation in the live spec it reads "Allowed roles: ..." from the description, then
 * calls the operation with no token and as each role. Expected:
 *   no token          -> 401 (except public operations)
 *   role not allowed  -> 403
 *   role allowed      -> anything but 401/403, and never a 2xx for a write
 * It changes no data: path ids point to records that do not exist and write bodies are empty, so
 * allowed calls stop at validation (400) or lookup (404). Guards run before both, so a 403 is
 * decided before the body is even read.
 *
 * Run against a started, seeded API:  pnpm check:access
 */
import { loadConfig } from '../config.js';
import { ROLES, type Role } from '../domain/user.schema.js';

interface Operation {
  method: string;
  path: string;
  allowed: readonly Role[] | 'public';
}

interface OpenApiDoc {
  paths: Record<string, Record<string, { description?: string }>>;
}

const MISSING_ID = '000000000000000000000000'; // a valid ObjectId that no record has
const ID_PARAMS = new Set(['id', 'productId']);

const config = loadConfig();
const base = `http://127.0.0.1:${String(config.PORT)}`;

function parseOperations(doc: OpenApiDoc): Operation[] {
  return Object.entries(doc.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, op]) => {
      const description = op.description ?? '';
      if (description.includes('No login needed.'))
        return { method, path, allowed: 'public' as const };
      const match = /Allowed roles: ([^\n]+)\./.exec(description);
      if (!match?.[1]) throw new Error(`${method.toUpperCase()} ${path}: no "Allowed roles" line`);
      const allowed =
        match[1] === 'any signed-in staff role' ? ROLES : (match[1].split(', ') as Role[]);
      return { method, path, allowed };
    }),
  );
}

async function login(role: Role): Promise<string> {
  const response = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${role}@store.example`, password: config.SEED_STAFF_PASSWORD }),
  });
  if (!response.ok) throw new Error(`Login as ${role} failed: ${String(response.status)}`);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

async function call(op: Operation, token: string | null): Promise<number> {
  const url =
    base +
    op.path.replace(/\{(\w+)\}/g, (_, name: string) =>
      ID_PARAMS.has(name) ? MISSING_ID : 'DOES-NOT-EXIST',
    );
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    method: op.method.toUpperCase(),
    headers,
    body: op.method === 'get' ? undefined : '{}',
  });
  return response.status;
}

function check(op: Operation, who: Role | 'none', status: number): string | null {
  const isWrite = op.method !== 'get';
  if (op.allowed === 'public')
    return status === 401 || status === 403 ? `public but got ${String(status)}` : null;
  if (who === 'none') return status === 401 ? null : `expected 401, got ${String(status)}`;
  if (!op.allowed.includes(who))
    return status === 403 ? null : `expected 403, got ${String(status)}`;
  if (status === 401 || status === 403) return `allowed but got ${String(status)}`;
  if (isWrite && status < 300) return `write returned ${String(status)}: it changed data`;
  return null;
}

const doc = (await (await fetch(`${base}/docs/json`)).json()) as OpenApiDoc;
const operations = parseOperations(doc);
const tokens = Object.fromEntries(
  await Promise.all(ROLES.map(async (r) => [r, await login(r)] as const)),
);

const failures: string[] = [];
console.log(`${'OPERATION'.padEnd(44)} none  owner support warehouse`);
for (const op of operations) {
  const cells: string[] = [];
  for (const who of ['none', ...ROLES] as const) {
    const status = await call(op, who === 'none' ? null : (tokens[who] ?? null));
    const problem = check(op, who, status);
    if (problem) failures.push(`${op.method.toUpperCase()} ${op.path} as ${who}: ${problem}`);
    cells.push(
      `${String(status)}${problem ? '!' : ' '}`.padEnd(who === 'none' ? 6 : who.length + 1),
    );
  }
  console.log(`${`${op.method.toUpperCase()} ${op.path}`.padEnd(44)} ${cells.join('')}`);
}

console.log(`\n${String(operations.length)} operations x 4 callers checked.`);
if (failures.length > 0) {
  console.error(`\n${String(failures.length)} problem(s):\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('All access rules match the spec.');
