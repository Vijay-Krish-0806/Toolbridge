import { Inject, Injectable, Logger } from '@nestjs/common';
import { createKnowledgeTool, type Tool, ToolExecutionError } from '@toolbridge/agent-core';
import type { KnowledgeIndex, KnowledgeScope } from '@toolbridge/retrieval';
import type { Types } from 'mongoose';

import { KNOWLEDGE_INDEX } from '../common/core.module.js';

/** Passages per search: enough for a question that touches two sections, small enough to read. */
const PASSAGES_PER_SEARCH = 4;

/**
 * Whose documents: one API (spec) of one tenant. Always built from a run record or a checked
 * command, never from the model or a request body.
 */
export function knowledgeScope(tenantId: Types.ObjectId, specId: Types.ObjectId): KnowledgeScope {
  return { tenantId: tenantId.toHexString(), source: specId.toHexString() };
}

/**
 * Policy search for agent runs (Step 3.3's knowledge index in the platform, ADR 0054). The scope is
 * fixed when the tool is built, so the model can only ask; it cannot choose whose documents it reads.
 */
@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(@Inject(KNOWLEDGE_INDEX) private readonly index: KnowledgeIndex) {}

  /**
   * The `knowledge_search` tool for one API of one tenant, or undefined when it has no documents.
   * A search that fails becomes a plain error result: the run goes on without it, and the model
   * never sees internal addresses.
   */
  async tool(tenantId: Types.ObjectId, specId: Types.ObjectId): Promise<Tool | undefined> {
    const scope = knowledgeScope(tenantId, specId);
    if (!(await this.index.hasDocuments(scope))) return undefined;
    return createKnowledgeTool({
      search: async (query) => {
        try {
          const matches = await this.index.search(scope, query, PASSAGES_PER_SEARCH);
          return matches.map((m) => ({
            id: m.id,
            section: m.headingPath.join(' > '),
            text: m.text,
          }));
        } catch (error) {
          this.logger.error(
            `Policy search failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          throw new ToolExecutionError(
            'internal',
            'The policy search is unavailable right now. Say that you could not check the policies.',
          );
        }
      },
    });
  }
}
