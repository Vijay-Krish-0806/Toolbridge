import OpenAI from 'openai';
import type { LLMProvider } from './provider.js';
import {
  ChunkAccumulator,
  fromWireCompletion,
  toWireMessages,
  toWireTools,
} from './openai-mapping.js';
import type { GenerateRequest, GenerateResult, StreamEvent } from './types.js';

export interface OpenAICompatibleOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  /** Per-request timeout. Local models on a small GPU are slow, so the default is generous. */
  timeoutMs?: number;
}

/**
 * The adapter for any OpenAI-compatible Chat Completions server (Ollama, LM Studio,
 * llama.cpp server, or OpenAI itself). It only translates; all logic lives in the agent loop.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  private readonly client: OpenAI;
  private readonly model: string;

  /**
   * Creates the SDK client once and reuses it for every request. The SDK retries failed
   * requests twice (network errors, 429, 5xx) and gives up after `timeoutMs`.
   */
  constructor(options: OpenAICompatibleOptions) {
    this.model = options.model;
    this.client = new OpenAI({
      baseURL: options.baseURL,
      apiKey: options.apiKey,
      timeout: options.timeoutMs ?? 300_000,
      maxRetries: 2,
    });
  }

  /** Sends one request, waits for the whole answer, and converts it to our GenerateResult. */
  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const completion = await this.client.chat.completions.create({
      ...this.toWireRequest(request),
      stream: false,
    });
    return fromWireCompletion(completion);
  }

  /**
   * Sends one request with `stream: true` and yields our events as chunks arrive.
   * It is an async generator (`async *`): the caller reads it with `for await`, and each
   * `yield` hands one event over without waiting for the whole answer.
   * `include_usage` asks the server for a final chunk with token counts.
   */
  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    const chunks = await this.client.chat.completions.create({
      ...this.toWireRequest(request),
      stream: true,
      stream_options: { include_usage: true },
    });
    const accumulator = new ChunkAccumulator();
    for await (const chunk of chunks) {
      yield* accumulator.push(chunk);
    }
    yield* accumulator.finish();
  }

  /** Builds the request fields shared by `generate` and `stream`: model, messages and tools. */
  private toWireRequest(request: GenerateRequest) {
    const tools = request.tools ?? [];
    return {
      model: this.model,
      messages: toWireMessages(request.messages),
      // Some servers reject an empty tools array, so leave the field out instead.
      ...(tools.length > 0 && { tools: toWireTools(tools) }),
    };
  }
}
