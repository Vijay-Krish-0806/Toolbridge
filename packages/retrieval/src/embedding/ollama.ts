/**
 * Ollama's native embed endpoint (POST /api/embed, checked against docs.ollama.com/api/embed,
 * Ollama 0.40.16). It takes many inputs per request, so a whole spec embeds in a few calls.
 * Plain fetch: no SDK needed for one endpoint.
 */
import { z } from 'zod';

import type { EmbeddingProvider } from './provider.js';

export interface OllamaEmbeddingOptions {
  /** Ollama's root URL, without /v1, for example http://127.0.0.1:11434. */
  baseUrl: string;
  model: string;
  dimensions: number;
  /** Texts per request. Bigger batches are faster but hold more memory on a small GPU. */
  batchSize?: number;
  /** Per request. The first call also loads the model, which took about 20 s on this laptop. */
  timeoutMs?: number;
}

const embedResponse = z.object({ embeddings: z.array(z.array(z.number())) });

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly url: string;
  private readonly batchSize: number;
  private readonly timeoutMs: number;

  /** Stores the settings; no request is made until the first embed call. */
  constructor(options: OllamaEmbeddingOptions) {
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.url = `${options.baseUrl.replace(/\/+$/, '')}/api/embed`;
    this.batchSize = options.batchSize ?? 32;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  /** Embeds texts in batches of `batchSize`, keeping the input order. */
  async embed(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += this.batchSize) {
      vectors.push(...(await this.embedBatch(texts.slice(start, start + this.batchSize))));
    }
    return vectors;
  }

  /**
   * One request. `truncate: false` makes an over-long text an error instead of a silently cut
   * vector. `dimensions` asks for exactly the size the index expects, and every returned vector
   * is checked against it, so a model swap fails loudly instead of corrupting the index.
   */
  private async embedBatch(input: string[]): Promise<number[][]> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        input,
        dimensions: this.dimensions,
        truncate: false,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(
        `Ollama embed failed: HTTP ${String(response.status)} ${await response.text()}`,
      );
    }
    const { embeddings } = embedResponse.parse(await response.json());
    if (embeddings.length !== input.length) {
      throw new Error(
        `Ollama returned ${String(embeddings.length)} vectors for ${String(input.length)} texts.`,
      );
    }
    for (const vector of embeddings) {
      if (vector.length !== this.dimensions) {
        throw new Error(
          `Expected ${String(this.dimensions)}-dimension vectors from ${this.model}, got ${String(vector.length)}.`,
        );
      }
    }
    return embeddings;
  }
}
