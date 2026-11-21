/**
 * Wires the nodes into a graph and compiles it.
 *
 *   START -> selectTools -> callModel --(answered?)-- yes --> finalize -> END
 *                              ^             | no                ^
 *                              |             v                   |
 *                              +------- executeTools --(limit hit?)-- yes
 *
 * Two kinds of edges:
 * - a normal EDGE (`addEdge(a, b)`) always goes from a to b;
 * - a CONDITIONAL EDGE (`addConditionalEdges(a, router, [...])`) calls the router after `a` and
 *   goes to the node it names. The array lists the possible targets, so LangGraph can check the
 *   graph and draw it.
 *
 * `compile()` checks the wiring (every node reachable, no edge to an unknown node) and returns a
 * runnable graph with `invoke` and `stream`. Step 4.3 will pass a checkpointer here.
 *
 * How it runs: LangGraph executes in SUPER-STEPS. In each super-step it runs the nodes that are
 * due, merges their updates into the state with the reducers, and then follows the edges to find
 * the next nodes. Our graph runs one node per super-step.
 */
import { END, START, StateGraph } from '@langchain/langgraph';

import {
  NODE,
  callModel,
  executeTools,
  finalize,
  routeAfterModel,
  routeAfterTools,
  selectTools,
} from './nodes.js';
import { AgentContext, AgentState } from './state.js';

/**
 * Builds and compiles the agent graph. It holds no per-run data (that lives in state and
 * context), so it is built once and shared by every run.
 */
export function buildAgentGraph() {
  return new StateGraph(AgentState, AgentContext)
    .addNode(NODE.selectTools, selectTools)
    .addNode(NODE.callModel, callModel)
    .addNode(NODE.executeTools, executeTools)
    .addNode(NODE.finalize, finalize)
    .addEdge(START, NODE.selectTools)
    .addEdge(NODE.selectTools, NODE.callModel)
    .addConditionalEdges(NODE.callModel, routeAfterModel, [NODE.executeTools, NODE.finalize])
    .addConditionalEdges(NODE.executeTools, routeAfterTools, [NODE.callModel, NODE.finalize])
    .addEdge(NODE.finalize, END)
    .compile();
}

export type AgentGraph = ReturnType<typeof buildAgentGraph>;
