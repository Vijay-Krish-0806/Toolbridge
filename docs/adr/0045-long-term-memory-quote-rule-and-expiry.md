# ADR-0045: Long-term memory: a store with expiry and the quote rule

- **Status:** Accepted
- **Date:** 2026-11-23

## Context

The build plan asks for a long-term user memory store with expiry: facts about a user that outlive a conversation. Two problems shape it.

- **Poisoning.** The agent reads untrusted text (order and customer notes contain injection-style text). If such text were saved, it would influence every later conversation of that user.
- **Isolation and expiry.** LangGraph's JS store API (`@langchain/langgraph-checkpoint` 1.2.3, read in the installed package) has no expiry, and its base class lets `search([])` return every item of every namespace. The official MongoDB store package still depends on driver 6 (checked on npm, 1.5.2), the problem ADR 0030 describes.

## Decision

`MongoStore extends BaseStore` (in `packages/checkpoint-mongo`, driver 7) keeps items with `expiresAt`: a TTL index deletes them and every read also skips expired ones. It refuses empty namespaces, `listNamespaces`, `query` and `filter`. `MemoriesService` is the only code that builds a namespace: tenant, spec, base64url of the user id, `memories`, from a verified session or a run record. A first graph node, `recallMemories`, reads them through LangGraph's `config.store` into the state (at most 400 tokens, newest first), and they enter the prompt as one labelled user message.

Memories are created only by the `memory_save({ quote })` tool. Code requires the quote to be word for word in the user's **current** message and saves the **whole sentence** around it. The tool is offered, and memories are recalled, only when the role's policy allows `memory_save` (deny by default). It is a write in the audit log, with an approval rule of `none` appended after the tenant's own rules, so a tenant can still require approval. It is marked `local`, so the tenant API's circuit breaker, rate limit, credentials and idempotency keys do not apply. Defaults: 90 days, 50 memories per user, 300 characters each. Users list and delete theirs with `GET /memories` and `DELETE /memories/:id` (session token).

## Alternatives considered

### The model writes memories freely, behind an approval card

- Can infer preferences ("seems to like short answers").
- Not chosen (owner's choice): a card for every memory is heavy, and people approve such cards without reading them.

### Memories only through an API

- Safest: the model cannot write at all.
- Not chosen (owner's choice): "remember that ..." in the chat would do nothing.

### Save only the quoted words

- Not chosen: a word-for-word fragment can reverse the meaning ("approve refunds on your own" out of "Never approve refunds on your own").

### A Mongoose model with `TenantScoped` instead of a LangGraph store

- The platform's usual isolation wall, and less code.
- Not chosen: the store is the framework's port for memory, and nodes get it from the framework. The cost is a second isolation mechanism, which is why it has one namespace builder and refuses anything that could cross namespaces.

### Extraction of memories after each run by a second model call

- Not chosen: it reads tool results, which is the poisoning path, and costs a call per run.

## Consequences

**Positive**

- Text from a tool result, an earlier answer or a summary cannot be saved, whatever the model was told (tested with a poisoned tool result).
- One user's memories are never listed, deleted or recalled for another tenant, spec or user.
- A tenant turns the feature off per role with its policy; recall stops too.

**Negative**

- The quote rule covers the current message only, not its origin: a user who pastes a poisoned text into the chat can have a sentence of it saved. A saved memory is user data without system authority, and approvals and policy do not read it.
- Sentence ends are found by `.`, `!` or `?` before a space, so an abbreviation ("Dr. Smith") can still cut a sentence short.
- Nothing is learned that the user did not say in so many words, and a small model must copy text exactly.
- The limit of 50 can be passed by one or two when two runs save at the same moment.
- Two isolation mechanisms now exist (`TenantScoped`, and namespaces for memories).
- TTL deletion by MongoDB is delayed; reads hide expired items, but they stay on disk until then (and in backups).
- If a tenant's API has its own `memory_save` operation, theirs is used and long-term memory is off for that spec.

**Follow-ups**

- Step 4.9 (prompt injection) should include memories in its red-team set.
- No UI lists or deletes memories yet; the endpoints exist.

## References

- [LangGraph.js memory](https://docs.langchain.com/oss/javascript/langgraph/add-memory) and [stores](https://docs.langchain.com/oss/javascript/langgraph/stores.md), read 2026-11-23.
- ADR 0026 (policy), 0030 (driver 7), 0032 (audit), 0041 (breaker and rate), 0044 (conversations).
