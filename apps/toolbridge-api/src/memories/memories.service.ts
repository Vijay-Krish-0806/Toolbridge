import { createHash } from 'node:crypto';

import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createMemorySaveTool, type Tool } from '@toolbridge/agent-core';
import type { MongoStore } from '@toolbridge/checkpoint-mongo';
import { Types } from 'mongoose';

import { MEMORY_STORE, PLATFORM_CONFIG } from '../common/core.module.js';
import type { PlatformConfig } from '../config.js';

/** Whose memories. Always from a verified session or a run record, never from a request body. */
export interface MemoryOwner {
  tenantId: Types.ObjectId;
  /** As a session token or a run record has it. */
  specId: Types.ObjectId | string;
  userId: string;
}

/** What a user sees of one memory. */
export interface MemoryView {
  id: string;
  text: string;
  savedAt: Date;
}

/**
 * Long-term memories (Step 4.7, ADR 0045), kept in a LangGraph store on MongoDB with expiry.
 *
 * This service is the only code that builds a namespace. The store itself knows nothing about
 * tenants: whoever holds a namespace can read it, so it is made in one place from a verified
 * identity. Memories are per tenant, spec and user; not per role, because they hold only what the
 * user typed themselves.
 */
@Injectable()
export class MemoriesService {
  constructor(
    @Inject(MEMORY_STORE) private readonly store: MongoStore,
    @Inject(PLATFORM_CONFIG) private readonly config: PlatformConfig,
  ) {}

  /** A run's memory: the store and this user's namespace in it. */
  forRun(owner: MemoryOwner): { store: MongoStore; namespace: string[] } {
    return { store: this.store, namespace: namespaceOf(owner) };
  }

  /** The `memory_save` tool for a run of this user, about this message. */
  tool(owner: MemoryOwner, userMessage: string): Tool {
    return createMemorySaveTool({
      userMessage,
      maxChars: this.config.MEMORY_MAX_CHARS,
      save: (text) => this.save(owner, text),
    });
  }

  /**
   * Saves a text; `false` when the user is at their limit. The same text again only starts its
   * lifetime over (the key is its hash). Two runs saving at the same moment can pass the limit by
   * one or two: it bounds storage, it is not a security rule.
   */
  private async save(owner: MemoryOwner, text: string): Promise<boolean> {
    const namespace = namespaceOf(owner);
    const key = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
    const limit = this.config.MEMORY_MAX_ITEMS;
    const known = await this.store.get(namespace, key);
    if (!known && (await this.store.search(namespace, { limit })).length >= limit) return false;
    await this.store.put(namespace, key, { text });
    return true;
  }

  /** The user's live memories, newest first. */
  async list(owner: MemoryOwner): Promise<MemoryView[]> {
    const limit = this.config.MEMORY_MAX_ITEMS;
    const items = await this.store.search(namespaceOf(owner), { limit });
    return items.map((item) => ({
      id: item.key,
      text: String(item.value.text),
      savedAt: item.updatedAt,
    }));
  }

  /** Deletes one memory of the user, or 404 (also for another user's id). */
  async remove(owner: MemoryOwner, id: string): Promise<void> {
    const namespace = namespaceOf(owner);
    if (!(await this.store.get(namespace, id))) throw new NotFoundException('Memory not found.');
    await this.store.delete(namespace, id);
  }
}

/**
 * Before -> after: tenant 6b…, spec 7c…, user 'ann.b@shop.com' ->
 * ['6b…', '7c…', 'YW5uLmJAc2hvcC5jb20', 'memories'].
 * The user id is encoded because LangGraph labels may not contain "." or ":", and host user ids
 * often do (email addresses, 'auth0|…'). Base64url never maps two ids to one label.
 */
function namespaceOf(owner: MemoryOwner): string[] {
  return [
    owner.tenantId.toHexString(),
    new Types.ObjectId(owner.specId).toHexString(), // one spelling, whatever case it came in
    Buffer.from(owner.userId, 'utf8').toString('base64url'),
    'memories',
  ];
}
