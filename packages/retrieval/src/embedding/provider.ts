/**
 * The embedding port. Core code depends on this interface, never on a vendor API, the same way
 * agent-core depends on LLMProvider. Adapter today: OllamaEmbeddingProvider.
 */
export interface EmbeddingProvider {
  /** Model id. Part of every cache key: vectors from different models are not comparable. */
  readonly model: string;
  /** Length of every vector this provider returns. The vector index is built for this size. */
  readonly dimensions: number;
  /**
   * Embeds texts, one vector per text, in the same order.
   * Before -> after: `['refund an order', 'list customers']` -> `[[0.01, ...], [-0.03, ...]]`
   * (two arrays of `dimensions` numbers).
   */
  embed(texts: string[]): Promise<number[][]>;
  /**
   * Embeds a search query. Instruction-aware models (Qwen3-Embedding) want a task instruction on
   * the query side only; documents go through `embed` unchanged, so changing the instruction
   * never re-embeds the index.
   * Before -> after: `'refund a damaged order'` -> one vector of `dimensions` numbers.
   */
  embedQuery(query: string): Promise<number[]>;
}
