/**
 * `pnpm --filter @toolbridge/host-store-web check:keys` (Step 7.0): proves the tenant API key
 * never reaches a browser. It reads the key from .env.local (without printing it) and searches
 * every file the build ships to browsers (.next/static) and every prerendered page for it.
 * Exits 1 on a find. Run after `next build`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const appDir = new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const env = readFileSync(join(appDir, '.env.local'), 'utf8');
const key = /^TOOLBRIDGE_API_KEY=(.+)$/m.exec(env)?.[1]?.trim();
if (!key) throw new Error('No TOOLBRIDGE_API_KEY in .env.local: run pnpm demo:setup first.');

/** Every file below `dir`. */
function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const shipped = [
  ...files(join(appDir, '.next', 'static')),
  ...files(join(appDir, '.next', 'server', 'app')).filter((f) => /\.(html|rsc|txt)$/.test(f)),
];
if (shipped.length === 0) throw new Error('No build output: run next build first.');
const leaks = shipped.filter((file) => readFileSync(file, 'utf8').includes(key));
console.log(`Checked ${String(shipped.length)} browser-facing build files for the tenant API key.`);
if (leaks.length > 0) {
  console.error(`FOUND in: ${leaks.join(', ')}`);
  process.exit(1);
}
console.log('Not found: the key stays on the server.');
