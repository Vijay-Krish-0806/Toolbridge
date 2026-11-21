/**
 * Step 3.4 experiment: reranking. A first-stage search is fast but judges each candidate alone;
 * a reranker reads the question and the candidates together and reorders them. A dedicated
 * reranker model would be the usual choice, but Ollama has no rerank endpoint (its docs list none)
 * and none is in its official library, so this uses the local chat model listwise: it sees
 * numbered candidates and returns the numbers of the best ones, best first.
 * Numbers instead of ids keep the answer short: output tokens are the slow part on this laptop.
 */
import { z } from 'zod';

import type { OllamaJson } from './ollama-json.js';
import type { RewriteTarget } from './rewrite.js';

export interface Candidate {
  id: string;
  text: string;
}

/** How many candidates the model picks; the rest keep their first-stage order behind them. */
const PICK = 8;
/** Characters of each candidate the model reads: enough for a name and a description. */
const SNIPPET = 400;

const PROMPTS: Record<RewriteTarget, string> = {
  tools:
    'You rank API operations for a store staff request. Pick the operations an assistant would ' +
    'call to fulfil it, including a lookup it needs first (for example finding a customer by ' +
    `name before updating them). Return the numbers of the ${String(PICK)} most useful candidates, best first.`,
  policies:
    'You rank store policy passages for a staff question. Pick the passages that answer it or ' +
    `state the rule that applies. Return the numbers of the ${String(PICK)} most useful passages, best first.`,
};

const rerankSchema = z.object({ best: z.array(z.number().int()).max(20) });

/**
 * Reorders candidates for one question. Picks the model returns come first (invalid or repeated
 * numbers are dropped), then every other candidate in its original order, so nothing is lost.
 * Before -> after: `('rename SKU-12', [a: products_list, b: products_update, ...])`, model answers
 * `{ best: [2, 1] }` -> `[products_update, products_list, ...the rest in original order]`.
 */
export async function rerank(
  llm: OllamaJson,
  question: string,
  candidates: Candidate[],
  target: RewriteTarget,
): Promise<Candidate[]> {
  if (candidates.length <= 1) return candidates;
  const listing = candidates
    .map((c, i) => `[${String(i + 1)}] ${c.text.slice(0, SNIPPET).replace(/\s+/g, ' ')}`)
    .join('\n');
  const { best } = await llm.ask(
    PROMPTS[target],
    `Request: ${question}\n\nCandidates:\n${listing}`,
    rerankSchema,
  );
  const picked = [...new Set(best)]
    .filter((n) => n >= 1 && n <= candidates.length)
    .map((n) => candidates[n - 1])
    .filter((c): c is Candidate => c !== undefined);
  const pickedIds = new Set(picked.map((c) => c.id));
  return [...picked, ...candidates.filter((c) => !pickedIds.has(c.id))];
}
