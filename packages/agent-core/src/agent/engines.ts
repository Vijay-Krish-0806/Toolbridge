/**
 * The two agent engines by name. Both take an AgentRunInput and return an AgentRunResult, so a
 * caller picks one with a flag (`chat --engine graph`) and the rest of its code stays the same.
 */
import { runAgentGraph } from './graph/run-graph.js';
import { runAgent } from './loop.js';
import type { AgentRunInput, AgentRunResult } from './run-types.js';

export type AgentEngine = (input: AgentRunInput) => Promise<AgentRunResult>;

export const ENGINES = { loop: runAgent, graph: runAgentGraph } satisfies Record<
  string,
  AgentEngine
>;

export type EngineName = keyof typeof ENGINES;

/**
 * Reads an engine name from a flag value. Missing means `graph`, the default since ADR 0025;
 * `loop` is the raw baseline. An unknown name is an error listing the valid ones.
 * Before -> after: `'loop'` -> `'loop'`; `undefined` -> `'graph'`; `'x'` -> throws.
 */
export function parseEngineName(value: string | undefined): EngineName {
  if (value === undefined) return 'graph';
  if (value in ENGINES) return value as EngineName;
  throw new Error(`Unknown engine "${value}". Use one of: ${Object.keys(ENGINES).join(', ')}.`);
}
