/**
 * Step 3.4: Reciprocal Rank Fusion, the merge step of hybrid search. Each list votes for its items
 * by rank, not by score: an item at rank r (1-based) gets weight / (60 + r) from that list, and
 * the votes are summed. Ranks are comparable across lists where raw scores are not (a BM25 score
 * of 7.2 and a cosine score of 0.85 have no common scale).
 *
 * The formula and the constant 60 are the ones MongoDB documents for $rankFusion. We fuse in code
 * because $rankFusion is disabled on our Atlas Local 8.0.34 image ("not allowed with the current
 * configuration", measured).
 */

/** MongoDB's documented rank constant. It flattens the curve: rank 1 is not worth 10 x rank 10. */
export const RRF_RANK_CONSTANT = 60;

export interface RankedList {
  /** Item ids, best first. */
  ids: string[];
  /** How much this list's votes count. Default 1. */
  weight?: number;
}

/**
 * Merges ranked lists into one, best first, with each id once.
 * Before -> after: `[{ ids: ['a', 'b'] }, { ids: ['b', 'c'] }]` ->
 * `[{ id: 'b', score: 1/62 + 1/61 }, { id: 'a', score: 1/61 }, { id: 'c', score: 1/62 }]`.
 * Ties keep the order in which ids were first seen, so the result is deterministic.
 */
export function reciprocalRankFusion(lists: RankedList[]): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const { ids, weight = 1 } of lists) {
    ids.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + weight / (RRF_RANK_CONSTANT + index + 1));
    });
  }
  return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}
