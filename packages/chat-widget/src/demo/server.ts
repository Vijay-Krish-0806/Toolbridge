/**
 * `pnpm demo` (Step 7.0 a): a tiny stand-in HOST BACKEND for trying the widget before the real
 * host web app exists. It serves one page with `<toolbridge-chat>`, the widget's built files,
 * and `POST /api/session?user=support`, which does what any host backend does: sign the user in
 * to the host API, then mint a ToolBridge session with the tenant key (from .env.local) and the
 * user's own host token. Only on 127.0.0.1:3001, for development.
 */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import { hostLogin, mintSession } from './host-session.js';

const PORT = 3001;
const demoPage = fileURLToPath(new URL('../../demo/index.html', import.meta.url));
const distDir = fileURLToPath(new URL('../', import.meta.url));
const USERS = ['owner', 'support', 'warehouse'] as const;

if (!process.env.TOOLBRIDGE_API_KEY) {
  throw new Error('No TOOLBRIDGE_API_KEY: run `pnpm demo:setup` first (it writes .env.local).');
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${String(PORT)}`);
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        const page = (await readFile(demoPage, 'utf8')).replace(
          '%TOOLBRIDGE_API_URL%',
          process.env.TOOLBRIDGE_API_URL ?? '',
        );
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
      } else if (req.method === 'GET' && /^\/widget\/[a-z-]+\.js$/.test(url.pathname)) {
        const file = `${distDir}${url.pathname.slice('/widget/'.length)}`;
        res.writeHead(200, { 'content-type': 'text/javascript' }).end(await readFile(file));
      } else if (req.method === 'POST' && url.pathname === '/api/session') {
        const user = USERS.find((u) => u === url.searchParams.get('user'));
        if (!user) {
          res.writeHead(400).end('{"message":"user must be owner, support or warehouse"}');
          return;
        }
        const session = await mintSession(await hostLogin(user));
        // Only the token and its expiry reach the browser.
        res
          .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          .end(JSON.stringify({ token: session.token, expiresAt: session.expiresAt }));
      } else {
        res.writeHead(404).end();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ message }));
    }
  })();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `Widget demo on http://localhost:${String(PORT)} (needs host, platform API and worker)`,
  );
});
