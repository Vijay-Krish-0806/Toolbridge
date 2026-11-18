# ADR-0012: Gemini free tier as a documented manual fallback, not wired in yet

- **Status:** Accepted
- **Date:** 2026-11-18

## Context

The local model (ADR-0007) is slow, and it is unavailable if Ollama fails. Google offers a free Gemini API tier with an OpenAI-compatible endpoint (`https://generativelanguage.googleapis.com/v1beta/openai/`), so the existing `OpenAICompatibleProvider` might serve as a fallback with no new code. On 2026-11-18 we tried it with the unchanged Step 1.1 smoke script:

- `gemini-2.5-flash` returned 404: "no longer available to new users".
- `gemini-3.8-flash` returned 503: "currently experiencing high demand" (the SDK retried twice).
- `gemini-3.5-flash` returned a correct `get_order` tool call, both plain and streamed. Sending the tool result back failed with 400: "Function call is missing a thought_signature". Gemini's thinking models attach a signature to each tool call that must be echoed back in the next request. Our provider-neutral `ToolCall` drops unknown fields. Google's docs do not show where the signature sits in the OpenAI-compatible tool call format.
- Free-tier limits shown in AI Studio for `gemini-3.8-flash`: 5 requests per minute and 20 per day. An agent question takes 3 to 4 model calls, so that's about 5 questions a day.
- Google's terms for unpaid services: content may be used to improve Google products and read by human reviewers; "Do not submit sensitive, confidential, or personal information to the Unpaid Services."

## Decision

Document Gemini as an optional, manual fallback (a commented block in `.env.example`) for seeded demo data only. Do not change the port or add automatic fallback now. Multi-turn tool use with Gemini is known not to work until the thought signature is round-tripped.

## Alternatives considered

### Add an opaque `providerData` field to `ToolCall` now and round-trip the signature

- Would likely make Gemini tool loops work.
- Rejected for now: the exact OpenAI-format field is undocumented, so we'd be guessing. Finding it costs scarce free-tier requests, and the result would serve about 5 questions a day.

### Automatic `FallbackProvider` (Ollama first, then Gemini)

- No manual switching.
- Rejected for now: it silently sends store data to a service that may train on it. It isn't in the build plan, and the backup itself was unavailable (503) during testing.

### Paid Gemini tier

- Content is not used to improve products, and limits are higher.
- Rejected: it breaks the project's no-paid-services cost guard. If adopted later, set a spend cap first.

## Consequences

**Positive**

- Shows ports and adapters in practice: a hosted model answered a tool call through the same adapter, changing only configuration.
- The risks (data use, quotas, availability) are written down before anyone relies on the fallback.

**Negative**

- No working hosted fallback for tool loops today.
- Provider quirks (thought signatures) show that "OpenAI-compatible" does not mean identical.

**Follow-ups**

- If a hosted fallback is needed: add an opaque `providerData` field on `ToolCall` that adapters pass through, find the signature's field with one recorded raw response, then reconsider a `FallbackProvider` with a circuit breaker.

## References

- https://aistudio.google.com/docs/openai
- https://aistudio.google.com/docs/thought-signatures
- https://aistudio.google.com/docs/pricing
- https://aistudio.google.com/docs/terms
- ADR-0007
