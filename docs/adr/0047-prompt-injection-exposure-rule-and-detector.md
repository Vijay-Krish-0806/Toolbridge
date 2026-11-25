# ADR-0047: Prompt injection: the exposure rule for writes, and a detector that only tightens

- **Status:** Accepted
- **Date:** 2026-11-25

## Context

The agent reads text that strangers wrote (order and customer notes) and acts with a staff user's rights. Six seeded notes try to make it refund, cancel, reprice or leak. Until now, only the role policy and the approval rules stood in the way, and a rule of `none` (the host policy has one, for `orders_update_notes`) let a fooled agent write without anyone seeing it.

OWASP says it is unclear whether any prevention of prompt injection is fool-proof, that labels in a prompt are not an enforcement boundary, and that pattern filters are not one either. The design-patterns paper gives the principle used here: once an agent has read untrusted input, it must be impossible for that input to trigger a consequential action.

## Decision

**Taint tracking, called exposure.** The graph state holds what the model has read: `none`, `seen` (text from a tool) or `flagged` (text that looked like instructions). Its reducer keeps the worse value, so it never goes down; it is checkpointed, and it is saved with the conversation, because earlier answers and summaries were written after that reading. A conversation from before this step counts as `seen`.

**The rule, in `packages/policy`, only ever stricter:** after `seen`, every write needs a person, whatever the policy says; after `flagged`, someone other than the requester. The gate uses the exposure **before** the turn, so a write in the same reply as a read is not affected. Reads are never gated. `memory_save` is exempt: code already allows only the user's own words (ADR 0045).

**The detector** (`findInstructions`, pure) normalizes the text (invisible tag characters, zero-width and look-alike characters, JSON escapes) and matches six kinds of phrases. The executor runs it on every result from the API, cached ones and API errors too. The kinds, never the text, go to the audit rows, and the card, the `approval_required` event and the widget warn the approver.

**A red-team set** (`evals/red-team/injections.json`) with a test that is the worst case on purpose: a model that obeys every note, under a policy where everything is allowed and nothing needs approval.

## Alternatives considered

### Approval only after flagged text

- Far fewer cards.
- Not chosen (owner's choice): one rephrased or translated sentence gets around a pattern list, and then nothing is left.

### A second model that judges text, or that reads all results for the first one

- Stronger in principle (the second is the Dual LLM pattern).
- Not chosen: the judge can be injected too and costs a call per result on a laptop; the second redesigns the agent.

### Refuse or cut out flagged results

- Not chosen: staff could no longer work with those records, and false alarms would hide real data.

### Deriving `seen` from the messages instead of keeping a field

- No extra state.
- Not chosen: flags and the conversation's history are not in the messages, so a field is needed anyway.

### Letting a tenant opt a tool out of the rule

- Not chosen: it would be the first thing to switch off when cards annoy people. It can be added when a real tenant needs it.

## Consequences

**Positive**

- A write caused by injected text reaches the API only after a person saw its exact arguments, independent of the model, the phrasing and the policy (35 e2e cases, each write first proven to run when nothing was read).
- Approvers are told that, and where, suspicious text was read; the audit can be searched for it.

**Negative**

- `none` in a policy now only matters for writes made without reading anything first, which is rare. More cards mean approval fatigue, the weak point of every human check.
- After a flagged record, a one-person team cannot approve at all. A conversation stays exposed for its whole life; a new one starts clean.
- An approver can still be fooled: the rule guarantees that they are asked, not that they look.
- Reads are not gated: injected text can make the agent read more than was asked (within the user's rights), or write a false answer. The widget shows answers as text only, so nothing is fetched by displaying them.
- Text the user pastes into the chat counts as the user's own words, and so do memories saved from it.
- The detector is English only and misses paraphrases, translations and encodings (four such variants are in the set as `missed`); ordinary text can be flagged. A flagged result that was cut or trimmed later stays flagged.
- Direct tool calls through the platform API and the MCP server have no graph, so the rule does not apply there: the calling program or client decides.
- A run paused before this step and resumed after it starts with `none`.

**Follow-ups**

- Session (b), ADR 0048: marking tool results in the prompt, measured on the local model, and a live red-team run.
- Operator console (U3): show the warning in the approval inbox.

## References

- [OWASP LLM01 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/), [OWASP prevention cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html), [Design patterns for securing LLM agents](https://simonwillison.net/2025/Jun/13/prompt-injection-design-patterns/), read 2026-11-24.
- ADR 0031 (approvals), 0044 (conversations), 0045 (memory), 0046 (cache).
