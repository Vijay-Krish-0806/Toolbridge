/**
 * Measures speed and memory of the local model at several context sizes (8K, 16K, 32K).
 * Ollama-specific on purpose: its native /api/chat accepts `num_ctx` per request (the OpenAI
 * endpoint cannot), and /api/ps reports memory. Each size reloads the model, so this is slow.
 * Needs the local model and the running host API (for a realistic prompt).
 * Run with `pnpm --filter @toolbridge/agent-core bench:context`.
 */
import { loadHostApiConfig, loadLLMConfig } from '../config.js';
import { HostApiClient } from '../host-api/client.js';
import { shapeOrderPage } from '../host-api/shaping.js';

const CONTEXT_SIZES = [8_192, 16_384, 32_768];
const NS_PER_SECOND = 1e9;
const BYTES_PER_GB = 1024 ** 3;

/** The timing fields of a non-streamed /api/chat response. All durations are in nanoseconds. */
interface ChatTimings {
  load_duration: number;
  prompt_eval_count: number;
  prompt_eval_duration: number;
  eval_count: number;
  eval_duration: number;
}

/** One loaded model as reported by /api/ps. Sizes are in bytes. */
interface PsModel {
  name: string;
  size: number;
  size_vram: number;
  context_length: number;
}

/** Sends `body` as JSON to an Ollama endpoint and returns the parsed response. */
async function ollama<T>(baseUrl: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body !== undefined && {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  if (!response.ok) throw new Error(`${path} failed with HTTP ${String(response.status)}`);
  return (await response.json()) as T;
}

/**
 * Runs one fixed prompt at `numCtx` and reads back timings and memory. Thinking is off and the
 * answer is capped at 64 tokens, so every size does the same work and only the context differs.
 */
async function measure(baseUrl: string, model: string, prompt: string, numCtx: number) {
  const timings = await ollama<ChatTimings>(baseUrl, '/api/chat', {
    model,
    stream: false,
    think: false,
    options: { num_ctx: numCtx, num_predict: 64 },
    messages: [
      { role: 'system', content: 'You are a store operations assistant.' },
      { role: 'user', content: prompt },
    ],
  });
  const ps = await ollama<{ models: PsModel[] }>(baseUrl, '/api/ps');
  const loaded = ps.models.find((m) => m.name.startsWith(model)) ?? ps.models[0];
  return {
    numCtx,
    loadedContext: loaded?.context_length,
    memoryGb: loaded ? loaded.size / BYTES_PER_GB : NaN,
    gpuShare: loaded ? loaded.size_vram / loaded.size : NaN,
    loadSeconds: timings.load_duration / NS_PER_SECOND,
    promptTokens: timings.prompt_eval_count,
    promptTokensPerSecond:
      timings.prompt_eval_count / (timings.prompt_eval_duration / NS_PER_SECOND),
    outputTokens: timings.eval_count,
    outputTokensPerSecond: timings.eval_count / (timings.eval_duration / NS_PER_SECOND),
  };
}

/** Builds a realistic ~4.5K-token prompt from shaped orders, then measures each context size. */
async function main(): Promise<void> {
  const { baseURL, model } = loadLLMConfig();
  // The native API lives at the server root, not under the OpenAI-compatible /v1 path.
  const ollamaUrl = baseURL.replace(/\/v1\/?$/, '');
  const api = new HostApiClient(loadHostApiConfig());
  const orders = JSON.stringify(shapeOrderPage(await api.get('/orders', { limit: 60 })));
  const prompt = `Here are recent orders:\n${orders}\n\nWhich order has the highest total? Answer in one line.`;
  console.log(`model=${model}, prompt=${String(prompt.length)} chars\n`);

  console.log('num_ctx  loaded  memory  on GPU  load   prompt tok  prompt tok/s  output tok/s');
  for (const numCtx of CONTEXT_SIZES) {
    const r = await measure(ollamaUrl, model, prompt, numCtx);
    console.log(
      [
        String(r.numCtx).padEnd(7),
        String(r.loadedContext).padEnd(6),
        `${r.memoryGb.toFixed(2)} GB`.padEnd(7),
        `${(r.gpuShare * 100).toFixed(0)}%`.padEnd(6),
        `${r.loadSeconds.toFixed(1)}s`.padEnd(6),
        String(r.promptTokens).padEnd(11),
        r.promptTokensPerSecond.toFixed(0).padEnd(13),
        r.outputTokensPerSecond.toFixed(1),
      ].join(' '),
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
