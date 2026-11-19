# ADR-0020: Envelope encryption for tenant credentials, with a local master key behind a port

- **Status:** Accepted
- **Date:** 2026-11-20

## Context

Step 2.6b lets tenants store the credentials ToolBridge uses to call their APIs (bearer tokens, API keys, basic auth, or a login). If the database leaks (a stolen backup, a misconfigured replica, a read-only injection bug), those credentials must not leak with it. The cost guard rules out cloud services, so there is no KMS. Requirements: AES-256-GCM, a random 12-byte IV per encryption, the key version stored beside each wrapped data key, the master key validated at startup, secrets never logged, and tests for wrong-tenant AAD and tampering.

## Decision

1. **Envelope encryption** (`crypto/envelope.ts`, `node:crypto` only):
   - Each secret is encrypted with its own random 32-byte data key (DEK): AES-256-GCM with a fresh random 12-byte IV.
   - The DEK is wrapped (encrypted) by the master key (KEK) with AES-256-GCM and its own fresh IV. The stored wrapped DEK carries `keyVersion`.
   - Both layers use the same **AAD**, `tenant:<tenantId>:connection:<connectionId>`. A ciphertext copied into another tenant's record, or anything tampered with, fails the GCM tag check.
   - Every failure raises one fixed message ("could not be decrypted"); plaintext DEKs are zeroed after use.
2. **Key provider port:** `KeyProvider.wrap/unwrap`. `LocalKeyProvider` holds `PLATFORM_MASTER_KEY` (base64 of exactly 32 bytes, validated at startup, never echoed in errors), its version, and optional previous keys. A KMS provider (AWS KMS, Google Cloud KMS, Vault Transit) can replace it without changing callers.
3. **Rotation:** set a new current key and version, move the old key to `PLATFORM_PREVIOUS_MASTER_KEYS`, call `POST /admin/connections/rewrap` (re-wraps only the DEKs; ciphertexts are unchanged), then drop the old key.
4. **Write-only API:** `PUT /specs/:id/connection` accepts secrets; responses and `GET` show metadata only (`hasSecret`, scheme names, `keyVersion`).
5. **Use at call time only:** `POST /specs/:id/tools/:name/call` checks the tool is current, active and enabled; only then is the connection decrypted, inside an `AuthProvider` for that one call. Calls go through the SSRF-safe client with the platform allowlist.

## Honest limits

- **A local master key protects against a database leak, not against a compromised server.** Anyone who can read the platform's environment or memory has the master key and can decrypt everything; anyone who can run code in the platform can simply call the decrypt path.
- A KMS narrows this: the master key never leaves the KMS, every unwrap is an audited and rate-limitable API call, and access can be revoked. It still cannot help once an attacker controls the running server and its KMS credentials.
- Plaintext secrets exist briefly in process memory during a call, and as JavaScript strings, which cannot be reliably wiped.

## Alternatives considered

### Encrypt every secret directly with the master key

- Simpler: one layer.
- Rejected: rotating the master key means re-encrypting every secret, and with a KMS every secret would travel to it on every use.

### MongoDB client-side field-level encryption or Queryable Encryption

- Encryption handled by the driver, with a key vault.
- Not now: it needs extra libraries and a key vault setup (not evaluated here), and it hides the mechanism this project is meant to teach. Worth evaluating later.

### Store secrets in a secrets manager (Vault, AWS Secrets Manager) and keep only references

- Strongest operational model.
- Rejected under the local-only cost guard; the `KeyProvider` port leaves the door open.

### AES-CBC with HMAC

- Widely supported.
- Rejected: GCM gives authenticated encryption in one primitive. The rule GCM imposes, never reuse an IV with the same key, is easy to keep with a fresh random IV and a fresh key per secret.

## Consequences

**Positive**

- 10 envelope unit tests (round trip, unique IVs, wrong-tenant AAD, tampered ciphertext, tag, IV and wrapped DEK, wrong master key, rotation, key length).
- 10 e2e tests, including the stored document never containing the secret, a ciphertext copied between tenants failing to decrypt (the test catches it when AAD binding is removed on purpose), login credentials used through a returned token, disabled tools refused at call time, and a full rotation: v1, then v2 with v1 as previous, re-wrap, then v2 alone.
- Against the real host API, the platform called `orders_get` with an encrypted login, and the host's own role check still applied.

**Negative**

- Losing the master key loses every stored credential; it must be backed up separately from the database.
- A login connection logs in on every call (no token cache yet).
- Re-wrapping is a single admin request over all connections; at scale it should be a batched background job.

**Follow-ups**

- A KMS-backed `KeyProvider` when a cloud budget exists.
- Token caching per connection, audit events for credential changes and decrypts (Phase 4).

## References

- ADR 0015 (executor, SSRF), ADR 0019 (multi-tenancy, API keys).
- Node.js `crypto` docs: `createCipheriv`, AES-GCM, `setAAD`, `getAuthTag`.
