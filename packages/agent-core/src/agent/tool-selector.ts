/**
 * The tool-selection port (Step 3.2). The loop asks it which tools to offer for a request, so a
 * large tool set does not have to fit in the context. Adapter: VectorToolSelector in
 * packages/retrieval (vector search over the tool index); agent-core never imports it.
 */
export interface ToolSelection {
  /** Tool names to offer the model for this request. Unknown names are ignored by the loop. */
  names: string[];
  /** `fallback` when the selector was unsure and offered a wider menu. */
  mode: 'top_k' | 'fallback';
  /** Score of the best match, when the selector has scores. */
  topScore?: number;
}

export interface ToolSelector {
  /**
   * Picks tools for one request text.
   * Before -> after: `'refund the damaged order ORD-7'` ->
   * `{ names: ['refunds_request', 'orders_get', ...], mode: 'top_k', topScore: 0.9 }`.
   */
  select(query: string): Promise<ToolSelection>;
}
