# ADR-0052: Empty-answer guard: one checkpointed retry, then an honest stop

- **Status:** Accepted
- **Date:** 2026-11-25

## Context

The 4B model sometimes ends its turn with thinking only, or a few tokens, and no text (ADR 0023; 2 of 65 completed runs in the count of Step 4.7). The run then counted as a normal `answer` and the user saw nothing. After an approved write this is worst: the user cannot tell whether it happened.

## Decision

- A reply without tool calls and without text (also when its output was used up, `length`) is dropped, and the model is asked **once more per run**, with thinking off and a reminder in that one prompt only.
- The retry is an edge of the graph (`callModel` to `callModel`) and a state field (`emptyRetry`: `unused`, `due`, `used`), so it is checkpointed: a crash or another worker cannot add a second one.
- It is a normal model call: it counts as a step, in the token budget and in the usage ledger. Without room for it, it is not made.
- Empty again, or no room: the run completes with the new stop reason `empty_answer`. The widget shows a note whenever a completed run has no answer.
- A write the model asks for in the retry goes through the approval gate like any other. Tools are never run again.

## Alternatives considered

### A loop inside the model node

- Smaller change.
- Not chosen: not checkpointed, so a crash in between starts over, and the extra call is hidden from the step limit.

### Retry until there is text

- Not chosen: a small model can stay silent, and every call costs a minute on the laptop.

### Store the reminder as a user message

- Simpler.
- Not chosen: it is not the user's words, and would enter the run's history.

### A fixed text as the answer

- The user would see something without an extra call.
- Not chosen as the first step: the model usually has the result and can say it. It is what the widget does at the end.

## Consequences

**Positive**

- No silent end: there is text, or the user is told that there is none.
- 19 of 19 scripted scenarios hold, one required test was added (an empty reply after an approved write does not run it twice), and 9 of 10 rules broken on purpose were noticed. The tenth only takes a detour through two nodes that do nothing.

**Negative**

- How often the retry helps on the local model is not measured (live runs are deferred).
- Thinking off can make that one answer weaker.
- An answer that says little ("OK") is not empty and is not retried.
- The raw loop, a frozen baseline, does not have it.

## References

- ADR 0023 (where it was found), 0025 (graph), 0030 (checkpoints), 0042 (token budget).
