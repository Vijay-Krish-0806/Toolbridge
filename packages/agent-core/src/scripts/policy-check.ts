/**
 * Checks specs/host-store.policy.json against the host's own rules (Step 4.2). Not a test, and
 * host-specific: the host writes "Allowed roles: owner, support." into each operation's
 * description, so we can compare. Most real specs say nothing about roles, which is why ToolBridge
 * keeps its own policy file in the first place.
 *   pnpm --filter @toolbridge/agent-core policy:check
 *
 * For every generated tool and every role it prints a mismatch when:
 * - the host allows the role but our policy denies it (the agent is stricter than the API: safe,
 *   but users cannot do their job), or
 * - our policy allows the role but the host denies it (the agent offers a tool that would fail
 *   with 403: confusing, and a sign the policy is wrong).
 * It exits with code 1 when anything differs, so it can run in CI.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { decide, parsePolicy } from '@toolbridge/policy';
import { compileTools, loadSpec, normalize, parseOverrides } from '@toolbridge/spec-compiler';

const SPECS = resolve(import.meta.dirname, '../../../../specs');
/** The host's roles. "any signed-in staff role" in a description means all of them. */
const HOST_ROLES = ['owner', 'support', 'warehouse'];
/** Tools that are ours, not the host API's: not in the spec, so not compared. */
const PLATFORM_TOOLS = ['knowledge_search'];

/**
 * Reads the roles a description allows.
 * Before -> after: `'... Allowed roles: owner, support.'` -> `['owner', 'support']`;
 * `'... Allowed roles: any signed-in staff role.'` -> all host roles; no sentence -> undefined.
 */
function allowedRoles(description: string): string[] | undefined {
  const found = /Allowed roles: ([^.]*)\./.exec(description)?.[1];
  if (found === undefined) return undefined;
  if (found === 'any signed-in staff role') return HOST_ROLES;
  return found.split(',').map((role) => role.trim());
}

/** Compares every tool and role, prints the result, and sets the exit code. */
async function main(): Promise<void> {
  const raw = JSON.parse(await readFile(resolve(SPECS, 'host-store.json'), 'utf8')) as {
    paths: Record<string, Record<string, { operationId?: string; description?: string }>>;
  };
  const descriptions = new Map<string, string>();
  for (const operations of Object.values(raw.paths)) {
    for (const op of Object.values(operations)) {
      if (op.operationId) descriptions.set(op.operationId, op.description ?? '');
    }
  }
  const { model } = normalize(await loadSpec(resolve(SPECS, 'host-store.json')));
  const overrides = parseOverrides(
    JSON.parse(await readFile(resolve(SPECS, 'host-store.overrides.json'), 'utf8')),
  );
  const { tools } = compileTools(model, overrides);
  const policy = parsePolicy(
    JSON.parse(await readFile(resolve(SPECS, 'host-store.policy.json'), 'utf8')),
  );

  const problems: string[] = [];
  for (const tool of tools) {
    // A merged tool runs one of several operations: a role needs access to every one of them.
    const perVariant = tool.variants.map((v) =>
      allowedRoles(descriptions.get(v.operationId) ?? ''),
    );
    if (perVariant.some((roles) => roles === undefined)) {
      problems.push(`${tool.name}: an operation has no "Allowed roles" sentence`);
      continue;
    }
    for (const role of HOST_ROLES) {
      const host = perVariant.every((roles) => roles?.includes(role) === true);
      const ours = decide(policy, role, tool.name).allowed;
      if (host && !ours) problems.push(`${tool.name}: host allows ${role}, policy denies`);
      if (!host && ours) problems.push(`${tool.name}: policy allows ${role}, host denies (403)`);
    }
  }
  for (const role of Object.keys(policy.roles)) {
    if (!HOST_ROLES.includes(role))
      problems.push(`policy role "${role}" does not exist in the host`);
  }

  const compared = tools.length * HOST_ROLES.length;
  console.log(
    `Compared ${String(tools.length)} tools x ${String(HOST_ROLES.length)} roles = ${String(compared)} decisions ` +
      `(skipped platform tools: ${PLATFORM_TOOLS.join(', ')}).`,
  );
  if (problems.length === 0) {
    console.log('Policy matches the host: no differences.');
    return;
  }
  for (const problem of problems) console.log(`  - ${problem}`);
  console.log(`${String(problems.length)} difference(s).`);
  process.exitCode = 1;
}

await main();
