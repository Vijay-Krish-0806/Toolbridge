# ADR-0049: Agent eval dataset: closed-world outcomes, and labels proved by replay

- **Status:** Accepted
- **Date:** 2026-11-25

(0048 is reserved for the deferred prompt-marking experiment of Step 4.9.)

## Context

Step 5.1 needs 50 cases that score the agent: question, role, expected tools, outcome, tags. A wrong label makes a right agent look wrong, and we would then "fix" code that works. The agent can also do more than asked (a second refund, a write on another record), which a check of only the expected record does not see. Step 5.5 will tune on these numbers.

## Decision

**One JSON file** (`evals/agent/host-store.json`), validated by a strict Zod schema, independent of engine and model, in a new workspace package `@toolbridge/evals`.

- **The outcome decides success, in a closed world.** A case lists every database change the run may make, down to the fields. Anything else (other record, field, collection, deletion) is a failure. Only the host's audit and idempotency records are ignored.
- **An attempted write counts.** A write that is neither a step nor in `allowedWrites` fails the case, even if an approver would have stopped it.
- **`steps` is for the tool-selection score**, not for success: an ordered list of alternatives, extra reads allowed, only the arguments that matter.
- **Facts, not sentences.** `mustInclude` holds values that a tool result contains and the question does not. Whether the wording asks back or refuses well is left to the judge of 5.2 (`behavior`).
- **Labels are proved** by `dataset:check`, without a model: (1) static, against the compiled tools, the role policy and the category's rules; (2) an oracle replay of the case's own calls, as that role, on a freshly seeded host; (3) evidence calls that prove the claim of the label: the host really answers 403 or 409, the name really has several matches, the record really does not exist, the injection case really reads poisoned text and the others do not.
- **Own database and host process** (`host_store_eval`, port 3190). The name is a constant, because a reset drops the database. A port that already answers stops the run.
- **35 dev and 15 test cases.** In each category, the lowest sha256 of the id are test, so nobody picked them. Step 5.5 tunes on dev and reports test.

## Alternatives considered

### Success = the exact tool sequence

- Simple to score.
- Not chosen: several paths are right (Anthropic calls this too rigid and brittle). Kept as a separate score because the plan asks for tool-selection accuracy.

### Check only the expected record

- Shorter labels.
- Not chosen: it cannot see the write nobody asked for, the failure that matters most here.

### Phrase lists for "asks back" and "refuses"

- Deterministic.
- Not chosen: right answers use many wordings, so the score would measure phrasing.

### Importing the host's seed code for reset and expected values

- Faster than a process per reset.
- Not chosen: ToolBridge code never imports host code. A reset takes about 1.4 s and runs only after a case that changed something.

### A test file for the checker

- Not chosen: the check command is the proof. It was itself checked by breaking labels: 25 of 25 were caught.

## Consequences

**Positive**

- 50 of 50 labels hold, and a renamed tool, a changed policy or a changed seed breaks the check instead of the scores.
- Building it exposed two weak fact checks (a count that matched the month of a date, and a date missed inside a timestamp) and one trap worth a case (the sales report's end date is exclusive).

**Negative**

- All questions are written by Claude Code from the tool list and seed, also the test cases. They are not drawn from real failures, and the author knew the tool names. Scores describe this set only.
- 5 to 14 cases per category: one case moves a category by 7 to 20 points. Good for comparing versions, not for absolute claims.
- Some dev and test cases are similar (two refund requests), so the split is weaker than it looks.
- For 11 cases (ambiguous, and forbidden by role) doing nothing passes every check in code. Only the judge can fail those.
- Labels hold for this seed and host only. A case in which two different outcomes are both right cannot be expressed.

**Follow-ups**

- 5.2: runner and scoring reuse `host.ts` and `world.ts`; report success with and without the 11 judge-only cases.
- Held-out questions written by the owner, when there are some.

## References

- [Demystifying evals for AI agents (Anthropic, 2026-01-09)](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), [τ-bench abstract (arXiv 2406.12045)](https://arxiv.org/abs/2406.12045), read 2026-11-25.
- ADR 0024 (decision rule before the run), 0026 (roles), 0047 (injection).
