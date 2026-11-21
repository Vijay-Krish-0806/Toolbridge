/**
 * The access-control port (Step 4.2, ADR 0026). agent-core asks "may this person use this tool?"
 * through this interface and never knows how the answer is made. Adapter: `createAuthorizer` in
 * packages/policy (a role-to-tool matrix). The app that wires the pieces passes it in.
 *
 * Why the agent needs its own check: it calls the host API with ONE shared service login, so the
 * host sees the same account whoever is chatting. Without this layer, anyone who can chat could
 * use every tool that login can (the "confused deputy" problem).
 */

/** Who is asking. Comes from a trusted source (a login or a signed token), never from the chat. */
export interface Principal {
  userId: string;
  role: string;
}

export type AccessDecision = { allowed: true } | { allowed: false; reason: string };

export interface ToolAuthorizer {
  /**
   * Decides one tool for one person. Must be pure and fast: it runs for every tool on every menu
   * and again for every call.
   */
  authorize(principal: Principal, toolName: string): AccessDecision;
}

/** Access control for one run: who is asking, and the rules to check them against. */
export interface RunAccess {
  principal: Principal;
  authorizer: ToolAuthorizer;
}
