/**
 * Step 3.3: the knowledge tool. The model calls it for questions about store rules, and cites the
 * passages it gets back. Retrieval sits behind the KnowledgeSearcher port, so agent-core needs no
 * MongoDB code; packages/retrieval's KnowledgeIndex fits it with a one-line adapter.
 */
import { z } from 'zod';

import { defineTool, type Tool } from './tool.js';

/** One passage the model may quote and cite. */
export interface KnowledgePassage {
  /** The citation id, for example `refund-policy#damaged-items`. */
  id: string;
  /** Where it comes from, for example `Refund policy > Damaged items`. */
  section: string;
  text: string;
}

export interface KnowledgeSearcher {
  /** The passages that best answer the query, best first. */
  search(query: string): Promise<KnowledgePassage[]>;
}

export const KNOWLEDGE_TOOL_NAME = 'knowledge_search';

/**
 * Builds the `knowledge_search` tool. Its result repeats the citation rule next to the passages,
 * because a small model follows an instruction it has just read better than one from the start.
 * Before -> after: `{ query: 'can a broken $15 vase be refunded?' }` ->
 * `{ passages: [{ id: 'refund-policy#damaged-items', section: '...', text: '...' }, ...],
 *    citeAs: '...' }`.
 */
export function createKnowledgeTool(searcher: KnowledgeSearcher): Tool {
  return defineTool({
    name: KNOWLEDGE_TOOL_NAME,
    description:
      "Search the store's policy documents (refund policy, shipping rules, escalation guide). " +
      'Use it for questions about rules: what is allowed, who may do something, time limits, ' +
      'and how to handle a case. Returns passages, each with an id to cite. It does not look up ' +
      'orders or customers; use the store tools for those.',
    safety: 'read',
    // It runs inside the platform and never calls the tenant's API. Its text is trusted: only the
    // operator can load documents (ADR 0054), so reading a rule does not count as exposure.
    local: true,
    input: z.object({
      query: z
        .string()
        .min(3)
        .max(300)
        .describe('The policy question in plain words, for example "refund for a damaged item".'),
    }),
    execute: async ({ query }) => {
      const passages = await searcher.search(query);
      return {
        passages,
        citeAs:
          'Answer only from these passages and cite each one you use by its id in square ' +
          'brackets, for example [refund-policy#damaged-items]. If none answers the question, ' +
          'say the policies do not cover it.',
      };
    },
  });
}
