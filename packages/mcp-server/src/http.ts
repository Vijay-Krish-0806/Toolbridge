/**
 * Runs the MCP server over Streamable HTTP at http://127.0.0.1:<MCP_HTTP_PORT>/mcp.
 * Stateless: the SDK builds a fresh McpServer for every request (cheap, since the compiled tools
 * and the login live in the shared runtime), so any number of instances could sit behind a load
 * balancer without sticky sessions.
 *
 * Safety: bound to 127.0.0.1 only, and the Host and Origin headers are checked before the MCP
 * handler sees a request. Without the Host check, a web page could use DNS rebinding to make
 * your browser talk to this local server. There is no caller authentication yet (Step 2.6 / Phase
 * 4); do not expose this port beyond localhost.
 * Run with `pnpm --filter @toolbridge/mcp-server http`.
 */
import { createServer } from 'node:http';

import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { loadMcpServerConfig, loadRepoEnv } from './config.js';
import { createMcpServer, createRuntime } from './server.js';

/** Builds the runtime, mounts the MCP handler at /mcp behind the localhost checks, and listens. */
async function main(): Promise<void> {
  loadRepoEnv();
  const config = loadMcpServerConfig();
  const runtime = await createRuntime(config);
  const handler = createMcpHandler(() => createMcpServer(runtime));
  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const httpServer = createServer((req, res) => {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return; // the guards answer 403
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/mcp') {
      res.writeHead(404).end('Not found: the MCP endpoint is /mcp');
      return;
    }
    void nodeHandler(req, res);
  });
  httpServer.listen(config.httpPort, '127.0.0.1', () => {
    console.error(
      `toolbridge-mcp (http): ${String(runtime.compiled.tools.length)} tools on http://127.0.0.1:${String(config.httpPort)}/mcp, calling ${config.hostApi.baseUrl}`,
    );
  });

  /** Stops accepting requests, then frees the MCP handler and the HTTP pool. */
  const shutdown = (): void => {
    httpServer.close();
    void handler.close();
    runtime.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
