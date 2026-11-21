/**
 * Step 3.4: one structured answer from a local chat model, for query rewriting and reranking.
 * Ollama's native /api/chat (docs.ollama.com/api/chat, checked 2026-11-21; the pages give no
 * version for these options), not the OpenAI-compatible endpoint the agent uses, because only the
 * native one takes all four settings we need:
 * - `format`: a JSON schema the answer must follow, so no parsing of free text,
 * - `think: false`: no reasoning tokens, which would cost seconds per call,
 * - `temperature: 0` and a fixed `seed`: the same input gives the same output, so an experiment
 *   measures the method, not luck.
 * Plain fetch: no SDK for one endpoint.
 */
import { z } from 'zod';

export interface OllamaJsonOptions {
  /** Ollama's root URL, without /v1, for example http://127.0.0.1:11434. */
  baseUrl: string;
  model: string;
  timeoutMs?: number;
}

const chatResponse = z.object({ message: z.object({ content: z.string() }) });

export class OllamaJson {
  private readonly url: string;

  /** Stores the settings; no request is made until the first call. */
  constructor(private readonly options: OllamaJsonOptions) {
    this.url = `${options.baseUrl.replace(/\/+$/, '')}/api/chat`;
  }

  /**
   * Asks once and returns the answer validated against `schema`.
   * Before -> after: `('Rewrite...', 'reverse the payment', z.object({ query: z.string() }))` ->
   * `{ query: 'chargeback payment dispute bank' }`.
   */
  async ask<T>(system: string, user: string, schema: z.ZodType<T>): Promise<T> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.options.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        stream: false,
        think: false,
        format: z.toJSONSchema(schema),
        options: { temperature: 0, seed: 42 },
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
    });
    if (!response.ok) {
      throw new Error(
        `Ollama chat failed: HTTP ${String(response.status)} ${await response.text()}`,
      );
    }
    const { message } = chatResponse.parse(await response.json());
    return schema.parse(JSON.parse(message.content));
  }
}
