/**
 * Runs the MCP server over stdio: the host (for example Claude Code) starts this process and talks
 * to it through stdin/stdout. Stdout is the protocol channel, so this file must never write to it;
 * every log line goes to stderr (console.error).
 * Run with `pnpm --filter @toolbridge/mcp-server stdio`.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { loadMcpServerConfig, loadRepoEnv } from './config.js';
import { createMcpServer, createRuntime } from './server.js';

/** Builds the runtime once, then serves every connection from it until stdin closes or Ctrl+C. */
async function main(): Promise<void> {
  loadRepoEnv();
  const config = loadMcpServerConfig();
  const runtime = await createRuntime(config);
  const { compiled } = runtime;
  console.error(
    `toolbridge-mcp (stdio): ${String(compiled.tools.length)} tools from ${compiled.model.title}` +
      ` (${compiled.cached ? 'cache hit' : 'compiled'}), calling ${config.hostApi.baseUrl}`,
  );

  const handle = serveStdio(() => createMcpServer(runtime));
  /** Closes the transport and the HTTP pool so the process can exit. */
  const shutdown = (): void => {
    void handle.close();
    runtime.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('end', () => {
    runtime.close();
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
