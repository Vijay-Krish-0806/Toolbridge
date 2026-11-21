# ADR-0026: RBAC policy layer with defense in depth

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

Step 4.2. The agent calls the host API with one shared service login (`support@store.example` by default), so the host sees the same account whoever is chatting. Without a check in ToolBridge, anyone who can chat can use every tool that login allows (the confused-deputy problem). Most real specs carry no role information at all; the host store states roles only as description text ("Allowed roles: owner, support.").

Facts checked or measured on 2026-11-22:

- Host roles per generated tool (compiled from `specs/host-store.json`): 35 tools; owner may use all, support 26, warehouse 13. Several reads are restricted (warehouse cannot read customers or refunds; reports are owner-only), so "every role may read" would be wrong.
- MongoDB documents `$in` inside a `$vectorSearch` filter. Measured on Atlas Local 8.0.34: a filter on a field the index does not declare fails with "Path 'toolName' needs to be indexed as filter" (no silent ignore). `updateSearchIndex` on a vector index failed with `"mappings" is required`; drop and recreate worked (both indexes replaced in 2.6 s; a no-op run takes 27 ms).
- Atlas Local does not keep search indexes across a container stop and start (data survives); `ensureIndexes` recreates them.

## Decision

**A pure `packages/policy` decides access from a per-spec policy file (`specs/host-store.policy.json`), and the agent enforces it at three independent layers.**

- Policy model: role -> `allow` and `deny` lists of whole-name patterns (`*` wildcard). Deny by default (unknown role or unmatched tool), deny wins over allow, the file is validated strictly at load.
- Layer 1, menu: `selectToolMenu` keeps only allowed tools, and the vector selector pre-filters inside the database (`toolName: { $in: allowed }`), so k results are k allowed tools. Core tools outside the allowed set are dropped.
- Layer 2, run boundary (from ADR 0022): a call to a tool not offered in this run is refused.
- Layer 3, executor: `ToolExecutor` gets its own `authorizer` and checks every call first, before name lookup and argument validation, returning a `forbidden` result. With an authorizer and no principal, the call is refused (fail closed).
- Identity: `principal { userId, role }` is passed in the LangGraph run context, not state, so no node can change it. agent-core depends only on a `ToolAuthorizer` port.
- `policy:check` compares the policy file with the host's "Allowed roles" text and exits 1 on any difference.

## Alternatives considered

- **Derive roles from the spec text.** Not chosen: host-specific and fragile; most specs have no roles. Kept only as the drift check.
- **Store the matrix per tenant in toolbridge-api now.** Not chosen: no consumer yet; it moves there with the U2 role-matrix screen.
- **Filter after retrieval.** Not chosen: a restricted role would get fewer than k tools.
- **Rules by safety class (read/write).** Not built: the host's rules do not follow safety class, so nothing would use it.
- **Rely on the host's own 403s.** Not chosen: the host sees only the shared login.

## Consequences

- **Positive:** a forced or guessed call is blocked even if layers 1 and 2 have a bug. Tests remove each layer in turn and fail (`loop.test.ts` on both engines, `executor.test.ts`, `decide.test.ts`). Live, the same refund request was declined for warehouse (no refund tool offered) and filed for support.
- **Negative:** the policy file must be kept in step with the spec (the drift check covers only this host). Replacing an outdated search index makes search unavailable for a few seconds at startup. The CLI has no login: `--role` is trusted input there, which is acceptable only for local use.
- **Follow-ups:** a trusted identity source (ADR 0027); per-tenant role mapping (v2); a 4.3 rule that a high-risk approval cannot be approved by the user who triggered it; user-delegated host credentials (ADR 0027).
