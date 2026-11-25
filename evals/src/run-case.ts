/**
 * Runs one eval case: one agent run on the real graph and the real host, with the same role policy,
 * approval rules and injection detector the platform uses. It records what happened and judges
 * nothing, so saved runs can be scored again later (score.ts) without asking the model again.
 *
 * What it leaves out: the queue, the audit log, memory and the tool cache of the platform.
 */
import { randomUUID } from 'node:crypto';

import {
  type AgentEvent,
  type AgentLimits,
  type AgentRunOutcome,
  type LLMProvider,
  resumeAgentRun,
  startAgentRun,
  storeAgentSystemPrompt,
  ToolExecutor,
  ToolRegistry,
} from '@toolbridge/agent-core';
import { createApprovalPolicy, createAuthorizer, findInstructions } from '@toolbridge/policy';
import { MemorySaver } from '@langchain/langgraph';

import type { EvalCase } from './dataset.js';
import type { EvalHost } from './host.js';
import type { StoreTools } from './store-tools.js';
import { diffWorlds, type World, type WorldChange } from './world.js';

/** One tool call the model asked for, whether it ran or not. */
export interface Attempt {
  tool: string;
  /** The raw JSON the model wrote (it can be malformed). */
  arguments: string;
  /** The call's result was a success; null when it never ran (rejected, or the run ended first). */
  ok: boolean | null;
}

/** Everything that happened in one run of a case. Plain data: it is saved as one JSON line. */
export interface CaseRun {
  attempts: Attempt[];
  /** Approval cards the run paused on. */
  cards: number;
  answer: string;
  /** Why the run ended; `timeout` when the time limit stopped it. */
  stopReason: string;
  /** Every database change of the run (the store was freshly seeded before it). */
  changes: WorldChange[];
  inputTokens: number;
  outputTokens: number;
  llmCalls: number;
  /** Time of the agent run alone, without resets. */
  seconds: number;
}

export interface RunSettings {
  limits: Partial<AgentLimits>;
  timeoutMs: number;
}

/**
 * Runs a case against a freshly seeded host and resets the host again when the run changed it.
 * A time limit ends as `timeout`; any other failure (the model is down) throws, because it says
 * nothing about the agent.
 *
 * The simulated approver is another person than the requester and gives every card the answer of
 * the case's label. That is the worst case on purpose: a wrong write that is proposed really runs.
 * Before -> after: m03 -> attempts [orders_get, refunds_request], 1 card, 2 changes.
 */
export async function runCase(
  c: EvalCase,
  llm: LLMProvider,
  host: EvalHost,
  store: StoreTools,
  seeded: World,
  settings: RunSettings,
): Promise<CaseRun> {
  const registry = new ToolRegistry(host.toolsFor(c.role));
  const authorizer = createAuthorizer(store.policy);
  const asked: { id: string; tool: string; arguments: string }[] = [];
  const results = new Map<string, boolean>();
  const usage = { inputTokens: 0, outputTokens: 0, llmCalls: 0 };
  /** Collects from events, not from the result, so a run that times out keeps what it did. */
  const onEvent = (event: AgentEvent): void => {
    if (event.type === 'llm-response') {
      usage.llmCalls++;
      usage.inputTokens += event.result.usage?.inputTokens ?? 0;
      usage.outputTokens += event.result.usage?.outputTokens ?? 0;
      for (const { id, name, arguments: raw } of event.result.message.toolCalls)
        asked.push({ id, tool: name, arguments: raw });
    } else if (event.type === 'tool-end') {
      results.set(event.call.id, event.result.ok);
    }
  };

  const run = {
    llm,
    registry,
    executor: new ToolExecutor(registry, { authorizer, inspect: findInstructions }),
    access: { principal: { userId: `eval-${c.role}`, role: c.role }, authorizer },
    approvals: createApprovalPolicy(store.policy),
    checkpointer: new MemorySaver(),
    runId: randomUUID(),
    limits: settings.limits,
    signal: AbortSignal.timeout(settings.timeoutMs),
    onEvent,
  };
  const started = performance.now();
  let cards = 0;
  let end = { answer: '', stopReason: 'timeout' };
  try {
    let outcome: AgentRunOutcome = await startAgentRun({
      ...run,
      messages: [
        { role: 'system', content: storeAgentSystemPrompt({ knowledge: false }) },
        { role: 'user', content: c.question },
      ],
    });
    while (outcome.status === 'waiting_for_approval') {
      cards++;
      outcome = await resumeAgentRun({
        ...run,
        decision: {
          decision: c.approval === 'approve' ? 'approved' : 'rejected',
          approverId: 'eval-approver',
        },
      });
    }
    end = { answer: outcome.result.answer, stopReason: outcome.result.stopReason };
  } catch (error) {
    if (!run.signal.aborted) throw error;
  }
  const seconds = Math.round((performance.now() - started) / 100) / 10;

  const changes = diffWorlds(seeded, await host.world());
  if (changes.length > 0) await host.reset();
  return {
    attempts: asked.map(({ id, tool, arguments: raw }) => ({
      tool,
      arguments: raw,
      ok: results.get(id) ?? null,
    })),
    cards,
    ...end,
    changes,
    ...usage,
    seconds,
  };
}
