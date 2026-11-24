# ADR-0046: Tool-result cache: versioned per API, opt-in, in Redis

- **Status:** Accepted
- **Date:** 2026-11-24

## Context

The build plan asks to cache safe reads with a TTL, keyed by tenant, credential mode, user (delegated mode) or role (service mode) and arguments, and to invalidate on related writes. A cache can go wrong in two ways: it shows old data, or it shows someone else's data.

Facts that shape it:

- **The spec does not say what a write touches.** In the host API, cancelling an order also changes inventory, and rejecting a refund also changes the order. RFC 9111, section 4.4, only requires a cache to invalidate the target URI of an unsafe request; other URIs are optional.
- **Reads and writes overlap.** Several workers run legs at once, so a read can start before a write and end after it.
- **Redis runs with `noeviction`**, which BullMQ requires, so a cache without TTLs would grow until writes fail.
- **Measured (development audit log, 42 successful reads in runs):** 7 would have hit within 60 s and 13 within 300 s, none inside one run; the median read takes 20 ms. Most of those repeats come from scripted checks, so real traffic may repeat less. The gain is mainly fewer calls to the tenant's API, not speed: a model call takes seconds.

## Decision

`ToolExecutor` gets a `ToolResultCache` port (cache-aside); the platform implements it in Redis (`ToolCache`), shared by all workers.

- **Order:** access, arguments, credential, **cache**, breaker, rate, write-ahead row, send. A hit needs the same rights and a live session, but no API. This moves the credential check in front of the breaker and the rate (ADR 0041 had it after them).
- **Entry key:** sha256 of spec and its version, connection version (`updatedAt`), credential mode, role, user, tool and canonical arguments, under the tenant's prefix. In delegated mode the user is the one whose token makes **this call**: the approver for calls on an approved card. Only successful read results are stored, as the model sees them (shaped, at most 8,000 characters).
- **Invalidation:** one version counter per tenant and API origin. Every write to the API raises it, before and after it is sent, whatever its outcome; direct tool calls too. An entry carries the version seen **before** its call went out and is valid only while that is still the current one. So one write ends all cached reads of that API.
- **Off by default:** `cacheTtlSeconds` on the connection, 0 to 300. The demo uses 60.
- **Failure:** the cache client gives up within about a second. An unreadable cache is a miss; a failed invalidation is logged and the TTL bounds the damage.
- **Audit:** `finished` rows carry `cached`.

## Alternatives considered

### Invalidate only related reads (by URI, tag or declared relations)

- More hits after a write.
- Not chosen (owner's choice): the spec's URIs and tags miss real side effects, and one missing relation in a hand-written list means old data. Writes are rare here, because most need an approval.

### LangGraph's node cache (`cachePolicy`)

- Built in, with a TTL. The documentation describes caching a node's result by its input.
- Not chosen: our tool node also runs writes, audit and refusals, and the documentation describes no invalidation except the TTL.

### In each worker's memory

- No network, no customer data in Redis.
- Not chosen: a write on one worker could not invalidate another's entries.

### Delete entries on a write instead of a version

- No counter.
- Not chosen: it needs an index of all entries of an API, and a read that overlapped the write would store old data after the delete.

### On by default

- Not chosen (owner's choice): only the tenant knows whether its users change data outside the platform and how old an answer may be.

## Consequences

**Positive**

- Repeated reads send nothing to the tenant's API, use no rate, and work while its circuit is open.
- Invalidation is correct without any tenant setup, across resources, workers, runs and specs of one API.
- A wrong key can only cause a miss for a different identity, never a shared result (tests, each checked by breaking the code on purpose).

**Negative**

- Changes made outside the platform (the host's own UI, the MCP server, another tenant on the same API) are noticed only when the TTL ends. The model can therefore propose a write based on data up to one TTL old; the host API still validates the write.
- A write that times out and commits later, a worker that dies during a write, or a Redis restored from a snapshot can leave old data for up to one TTL.
- A user whose rights are reduced **at the host** can see their own earlier results for up to one TTL in delegated mode.
- A busy tenant that writes often gets few hits.
- Results, which can hold customer data, lie in Redis unencrypted for up to the TTL, as they already do in MongoDB's checkpoints and events (owner's choice; encrypting only the cache would not help).
- A call that is refused for a missing credential now says so even while the circuit is open.
- Version counters have no TTL: one small key per tenant and API, kept forever. If a counter could expire, an old entry might match it again.
- If Redis is down, the cache steps aside but the rate limiter and the queue still wait for it.
- Two equal reads at the same moment both go to the API (no request coalescing).

**Follow-ups**

- Step 4.9: a cached result is untrusted text like any other; flagging must run on hits too.
- Cache rules from the API itself (`Cache-Control: no-store`) are not read.

## References

- [RFC 9111, section 4.4](https://www.rfc-editor.org/rfc/rfc9111#section-4.4), [BullMQ: going to production](https://docs.bullmq.io/guide/going-to-production), [LangGraph.js node caching](https://docs.langchain.com/oss/javascript/langgraph/graph-api-nodes), [Cache-Aside pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside), read 2026-11-24.
- ADR 0032 (audit), 0038 (delegation), 0041 (breaker and rate).
