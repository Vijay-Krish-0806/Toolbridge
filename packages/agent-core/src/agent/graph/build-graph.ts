/**
 * Wires the nodes into a graph and compiles it.
 *
 *   START -> selectTools -> callModel --(answered, or budget?)-- yes -----------------> finalize -> END
 *                              ^             | no                                       ^
 *                              |             v                                          |
 *                              |       approvalGate --(rejected)--> callModel           |
 *                              |             | (approved, or nothing to approve)        |
 *                              |             v                                          |
 *                              +------- executeTools --(limit hit?)-- yes --------------+
 *
 * Two kinds of edges:
 * - a normal EDGE (`addEdge(a, b)`) always goes from a to b;
 * - a CONDITIONAL EDGE (`addConditionalEdges(a, router, [...])`) calls the router after `a` and
 *   goes to the node it names. The array lists the possible targets, so LangGraph can check the
 *   graph and draw it.
 *
 * `compile()` checks the wiring (every node reachable, no edge to an unknown node) and returns a
 * runnable graph with `invoke`, `stream` and `getState`. With a CHECKPOINTER (Step 4.3), LangGraph
 * saves the state after every super-step under the run's `thread_id`; that is what lets
 * `approvalGate` pause a run with `interrupt()` and continue it later, even after a restart.
 *
 * How it runs: LangGraph executes in SUPER-STEPS. In each super-step it runs the nodes that are
 * due, merges their updates into the state with the reducers, and then follows the edges to find
 * the next nodes. Our graph runs one node per super-step.
 */
import { type BaseCheckpointSaver, END, START, StateGraph } from '@langchain/langgraph';

import {
  NODE,
  approvalGate,
  callModel,
  executeTools,
  finalize,
  routeAfterApproval,
  routeAfterModel,
  routeAfterTools,
  selectTools,
} from './nodes.js';
import { AgentContext, AgentState } from './state.js';

/**
 * Builds and compiles the agent graph. It holds no per-run data (that lives in state and
 * context), so it is built once per checkpointer and shared by every run. Without a
 * checkpointer the graph cannot pause, so approval rules must not be passed to such a run.
 */
export function buildAgentGraph(checkpointer?: BaseCheckpointSaver) {
  return new StateGraph(AgentState, AgentContext)
    .addNode(NODE.selectTools, selectTools)
    .addNode(NODE.callModel, callModel)
    .addNode(NODE.approvalGate, approvalGate)
    .addNode(NODE.executeTools, executeTools)
    .addNode(NODE.finalize, finalize)
    .addEdge(START, NODE.selectTools)
    .addEdge(NODE.selectTools, NODE.callModel)
    .addConditionalEdges(NODE.callModel, routeAfterModel, [NODE.approvalGate, NODE.finalize])
    .addConditionalEdges(NODE.approvalGate, routeAfterApproval, [
      NODE.executeTools,
      NODE.callModel,
      NODE.finalize,
    ])
    .addConditionalEdges(NODE.executeTools, routeAfterTools, [NODE.callModel, NODE.finalize])
    .addEdge(NODE.finalize, END)
    .compile(checkpointer ? { checkpointer } : {});
}

export type AgentGraph = ReturnType<typeof buildAgentGraph>;
