/**
 * Step 3.4 experiment: query rewriting (query expansion). Users say "reverse the payment", the
 * policy says "chargeback"; users say "take it off the store", the tool says "update product
 * status". A model rewrites the question into search words first, and we search with the
 * original plus the rewrite, so names and ids in the original are never lost.
 */
import { z } from 'zod';

import type { OllamaJson } from './ollama-json.js';

/** What is being searched: the wording that helps differs. */
export type RewriteTarget = 'tools' | 'policies';

const PROMPTS: Record<RewriteTarget, string> = {
  tools:
    'You turn a store staff request into a search query for a catalogue of API operations. ' +
    'Name every action needed (including a lookup first, if an id must be found) and the objects, ' +
    'using common API words such as get, list, search, create, update, cancel, approve, adjust, ' +
    'and add one or two synonyms. Keep it under 25 words. Do not answer the request.',
  policies:
    'You turn a store staff question into a search query for the store policy documents (refunds, ' +
    'shipping, escalation). Name the policy topic and the situation in plain policy words, and add ' +
    'one or two synonyms, for example "chargeback" for a reversed payment. Keep it under 25 words. ' +
    'Do not answer the question.',
};

const rewriteSchema = z.object({ query: z.string().min(1).max(400) });

/**
 * The search text for one question: the original, a newline, then the model's rewrite.
 * Before -> after: `('A customer says they will reverse the payment', 'policies')` ->
 * `'A customer says they will reverse the payment\nchargeback payment dispute escalation'`
 * (rewrite illustrative).
 */
export async function expandQuery(
  llm: OllamaJson,
  question: string,
  target: RewriteTarget,
): Promise<string> {
  const { query } = await llm.ask(PROMPTS[target], question, rewriteSchema);
  return `${question}\n${query}`;
}
