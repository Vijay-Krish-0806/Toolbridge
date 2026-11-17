import type { LLMProvider } from './provider.js';
import type { GenerateRequest, GenerateResult, StreamEvent } from './types.js';

/**
 * A scripted LLMProvider for tests: each call returns the next scripted result, in order.
 * It records every request, so tests can check what the model was shown.
 */
export class FakeProvider implements LLMProvider {
  readonly requests: GenerateRequest[] = [];
  private readonly script: GenerateResult[];

  /** `script` is the list of answers to give, one per call. It is copied so the caller's array is untouched. */
  constructor(script: GenerateResult[]) {
    this.script = [...script];
  }

  /**
   * Records the request, then returns the next scripted answer. Rejects when the script runs out,
   * so a test whose code calls the model more often than expected fails loudly.
   */
  generate(request: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(request);
    const next = this.script.shift();
    if (!next) {
      return Promise.reject(new Error('FakeProvider: script exhausted'));
    }
    return Promise.resolve(next);
  }

  /**
   * Plays the next scripted answer as a stream, in the same order a real adapter uses:
   * text pieces first, then one `tool-call` event per call, then `done`.
   */
  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    const result = await this.generate(request);
    // Word-sized pieces, so consumers are tested against text that really arrives in parts.
    // Splitting before each word keeps every character, so the pieces join back to the content.
    for (const piece of result.message.content.split(/(?<=\s)(?=\S)/)) {
      if (piece) yield { type: 'text-delta', text: piece };
    }
    for (const toolCall of result.message.toolCalls) {
      yield { type: 'tool-call', toolCall };
    }
    yield { type: 'done', result };
  }
}
