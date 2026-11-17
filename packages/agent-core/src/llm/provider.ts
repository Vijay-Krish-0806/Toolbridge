import type { GenerateRequest, GenerateResult, StreamEvent } from './types.js';

/**
 * The LLM port. Core code depends on this interface, never on a vendor SDK.
 * Adapters: OpenAICompatibleProvider (Ollama today) and FakeProvider (tests).
 */
export interface LLMProvider {
  /** Returns the whole answer at once. */
  generate(request: GenerateRequest): Promise<GenerateResult>;
  /** Yields the answer as it is produced, ending with a `done` event. */
  stream(request: GenerateRequest): AsyncIterable<StreamEvent>;
}
