# ADR-0029: One identity model: host-minted session tokens, no ToolBridge accounts

- **Status:** Accepted (built in Step 4.4b)
- **Date:** 2026-11-22

## Context

ToolBridge now has three kinds of people: end users chatting inside the host app (the embedded widget), operators using the console (playground chat, approval inbox), and approvers of high-risk writes. Step 4.3 needs a rule that the approver of a high-risk action is not the user who triggered it, which only works if both are identified the same way. ToolBridge today has tenant API keys and a platform admin key, but no user identities (ADR 0019).

## Decision

**Every caller, approvers included, is a host user carried by a short-lived session token that the host's backend mints with its tenant API key (ADR 0027). ToolBridge stores no user accounts or passwords.**

- Session token claims: tenant, `sub` (host user id), role, `exp`, `jti`, audience. The role comes only from the verified token.
- Approver != triggerer compares host user ids (`sub`) from two session tokens.
- The console signs in through a **dev-only** login page that mints a session token from the tenant API key for a chosen host user and role. It is disabled outside development.
- Real SSO and user management are out of scope (listed as v3 ideas in the build plan).

## Alternatives considered

- **ToolBridge user accounts for the console and approvers.** Not chosen: a second identity system to secure (passwords, resets, sessions), and approver != triggerer would have to map ToolBridge users to host users.
- **Console signs in with the tenant API key directly.** Not chosen: every console action would be "the tenant", so approvals could not be attributed to a person.
- **SSO (OIDC) now.** Not chosen: no identity provider in the local-only setup, and it adds an external dependency the plan avoids.

## Consequences

- **Positive:** one way to identify people everywhere (widget, console, approvals, audit). No passwords stored in ToolBridge.
- **Negative:** ToolBridge trusts the host's backend to assert the right user and role; a leaked tenant API key can mint any role of that tenant (mitigated by allowing only roles in the tenant's policy, short expiry and `jti` revocation). The dev login page is a powerful shortcut: it must stay off outside development, and a test should show that.
- **Follow-ups:** Step 4.4b builds the token exchange and the dev login; Step 4.3 uses host user ids for approvals.
