# ADR-0019: Multi-tenancy with the pool model, a tenant-scoped repository, and hashed API keys

- **Status:** Accepted
- **Date:** 2026-11-20

## Context

Step 2.6a turns ToolBridge into a platform (`apps/toolbridge-api`) where many tenants register their own specs and control their own tools. Two risks dominate:

- **Cross-tenant access.** If tenant B can read tenant A's spec by sending A's id (IDOR: insecure direct object reference), the platform leaks every tenant's API surface.
- **Stolen credentials.** Tenant API keys must not be usable by whoever reads the database.

Requirements: specs by upload or URL with versions and diffs (ADR 0017), tools listed and switched on or off, secure defaults, limits, and a test proving two tenants cannot see each other.

## Decision

1. **Pool model:** one database (`toolbridge`), shared collections, `tenantId` on every tenant-owned document, and every index starting with `tenantId`.
2. **One door to tenant data:** services never query tenant collections directly. They use `TenantScoped`, which cannot be built without a valid tenant id, adds `tenantId` to every filter, stamps it on inserts, and refuses filters or updates that try to set it.
3. **The tenant comes only from the API key.** The global guard resolves the key to a tenant; routes read it from the request, never from the URL or body. Another tenant's id, a malformed id and an unknown id all return the same 404.
4. **API keys:** `tb_<keyId>_<secret>`. `keyId` (16 hex) is the database id; the secret (32 random bytes) is shown once and stored as SHA-256. The guard looks the key up by id, then compares hashes with `timingSafeEqual`; an unknown id is compared against a dummy hash, so both cases cost the same and return the same 401. Tenants can hold several keys and revoke them; revoking the last active key is refused (409).
5. **Admin key:** `PLATFORM_ADMIN_KEY` creates tenants. It is validated at startup (at least 32 characters, not the example value) and compared in constant time over SHA-256 digests. Admin and tenant keys are not interchangeable.
6. **Secure defaults on specs:** new read tools start enabled, new write tools disabled. On a new version: tools that turned into writes count as new writes; write tools whose operation changed in a breaking way become `needs_review` (disabled); tools no longer in the spec become `removed` and cannot be enabled. Enabling a `needs_review` tool marks it reviewed.
7. **Fetching specs by URL** uses the SSRF-safe client from Step 2.3: the private-address check runs inside the connection's own DNS lookup (DNS rebinding cannot slip past it), redirects are never followed, responses are size-capped, and fetches time out. The private-host allowlist (`PLATFORM_ALLOW_PRIVATE_HOSTS`) is platform configuration only.
8. **Limits from config:** `MAX_SPEC_BYTES` (request body and fetched spec), `MAX_SPECS_PER_TENANT`, `SPEC_FETCH_TIMEOUT_MS`.
9. Compiled specs live in a content-addressed MongoDB store (gzip, shared across tenants). Sharing is safe because entries are only reachable through a tenant's own spec versions.

## Alternatives considered

### Bridge model (a collection set per tenant)

- Some physical separation without separate databases.
- Rejected: awkward in MongoDB (dynamic collection names, indexes per tenant) for little real gain over the pool model.

### Silo model (a database per tenant)

- The strongest isolation: a missed filter cannot leak across tenants, and per-tenant backups are trivial.
- Rejected for now: costly to operate with many tenants (connections, migrations, indexes per database). It remains the right choice for a large or regulated tenant later.

### Relying on each service to add `tenantId`

- Less code.
- Rejected: one forgotten filter is a breach. A test with the scope deliberately removed showed the isolation test catching the leak (200 instead of 404).

### Slow password hashing (bcrypt or Argon2) for API keys

- Standard for passwords.
- Not needed: the secret is 256 random bits, so brute force is impossible regardless of hash speed, and a fast hash keeps every request cheap.

### 403 for another tenant's resource

- Tells the caller precisely what happened.
- Rejected: it confirms that the id exists. 404 reveals nothing.

## Consequences

**Positive**

- 18 end-to-end tests (separate `toolbridge_e2e` database) and 17 unit tests: isolation and IDOR, key rules, rotation and revocation, re-upload rules, limits, and SSRF (private, metadata, IPv6 loopback, redirect, timeout, allowlist not tenant-settable).
- Isolation is enforced in one small, tested class instead of in every query.

**Negative**

- Pool-model risk remains for code that bypasses `TenantScoped` (the API-key lookup in the guard is the one deliberate exception). Code review must keep it that way.
- Tool settings are written one document at a time without a transaction; a crash mid-version can leave a partial update. Acceptable at this scale; a transaction or a bulk write would fix it.
- Specs by URL must be JSON; YAML is not supported yet.
- No rate limiting per tenant yet; one noisy tenant can load the shared database.
- Compiled specs are never evicted, because versions point at them.

**Follow-ups**

- 2.6b: tenant credentials with envelope encryption, and a tool-call endpoint that enforces enabled and status at call time.
- Per-tenant rate limits and audit logging (Phase 4).

## References

- ADR 0015 (SSRF-safe client), ADR 0017 (content-addressed cache and diff).
