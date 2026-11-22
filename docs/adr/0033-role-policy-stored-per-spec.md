# ADR-0033: Role policy stored per spec, deny-all without one

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

Until now every agent run used one policy file from the platform's configuration (`PLATFORM_POLICY_FILE`, Step 4.3). That cannot work for more than one tenant: each tenant's API has its own tools and roles. Step 4.3b stores a role policy per spec, validated with `parsePolicy` and tied to the spec version, and a spec without a policy must deny everything. It comes after Step 4.10 so that policy changes are auditable.

## Decision

**Each upload is a new immutable version of the spec's policy. Runs load the highest version for every leg; with no version they get a built-in deny-all policy.**

- **Storage:** `policyversions` rows `{tenantId, specId, version, document, policyHash, specVersion, createdBy, createdAt}`, unique on `(tenantId, specId, version)`. Rows are only inserted, so the versions are the audit trail of policy changes (who, when, which hash). There is no delete: to remove access, upload a policy that allows nothing.
- **Document as text:** the validated policy is stored as JSON text, because role names may contain characters MongoDB does not allow in field names (`.`, `$`). It is parsed again when loaded.
- **Endpoints** (tenant API key, another tenant's spec is 404): `PUT /specs/:id/policy` returns the version, spec version, hash and warnings (an invalid policy is 422); `GET /specs/:id/policy` returns the current policy with `stale`, or 404 "no policy, so every tool is denied"; `GET /specs/:id/policy/versions` returns the history.
- **Tied to the spec version, carried forward:** each version records the spec version it was checked against. Warnings name exact tool names the spec lacks and patterns that match no tool. When the spec gets a new version, the policy stays in force and `GET` shows `stale: true`. New or changed write tools are still disabled by default (Step 2.6a), so carrying a pattern like `orders_*` forward cannot switch a new write on by itself.
- **Deny by default as a storage rule:** no row means `DENY_ALL` (no roles; every write needs approval), so the menu is empty for every role, owner included. The rule does not depend on a file being present or a default being configured.
- **Per leg:** the policy is loaded on start and again on resume, so a change applies to the next leg. Each audit row records the `policyVersion` that authorized the call (null for deny-all and for direct calls).
- **Approval gate fix found by the deny-all test:** the gate treated a call to a tool that was not on the menu as an unknown write and paused for approval. With an empty menu, every invented call would have put a card in the inbox. The gate now evaluates only calls to offered tools; the others are refused in `executeTools` and never run (new unit test in `approval.test.ts`).
- **The file setting is removed** from the API. `specs/host-store.policy.json` stays as the policy to upload for the host store, and for the local tools (chat CLI, `policy:check`).

## Alternatives considered

- **One editable policy document per spec.** Simpler reads. Not chosen: an update erases the previous rules, so a separate change log would be needed; immutable versions give history and auditability for free.
- **Require a new policy for every spec version** (deny until re-uploaded). Strictest. Not chosen: every routine spec update would take all tools away until someone re-uploads the same policy. The stale flag makes review visible without an outage. (Decided 2026-11-22.)
- **Refuse unknown tool names (422).** Not chosen: a name that matches nothing allows nothing, so it is safe; and the host policy names `knowledge_search`, a built-in tool of the chat CLI that is not in the spec. Warnings report it without blocking.
- **Keep a platform default policy file.** Not chosen: a forgotten upload would silently give a tenant the default's rules; with deny-all, a forgotten upload shows up as "no tools", which is safe and obvious.

## Consequences

- **Positive:** tenants own their rules; deny by default holds even with no configuration (e2e: a spec without a policy offers 0 tools on every model call and runs no write, even for the owner role; it fails when the deny-all rule is replaced); one tenant cannot read, replace or list another's policy (e2e); policy history is auditable.
- **Negative:** policy changes are attributed to an API key, not a person, until Step 4.4b; a stale policy keeps working until someone reviews it; the policy text is parsed on every leg (small).
- **Follow-ups:** the console (U1b) shows the stale flag and warnings; 4.4b records the operator's user id on uploads.
