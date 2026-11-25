# ADR-0050: Eval runner and scoring: the real graph, outcome first, and a scorer that is itself tested

- **Status:** Accepted
- **Date:** 2026-11-25

## Context

Step 5.2 runs the 50 cases of ADR 0049 and scores them per model. A scorer that is too strict fails good agents, and one that is too soft passes bad ones. Both look like a number. The local model needs about a minute per case, so runs must survive a stop and must be scorable again without asking the model.

## Decision

- **Run the LangGraph graph in the eval process** (`startAgentRun` and `resumeAgentRun` with an in-memory checkpointer), with the real policy, authorizer, approval rules and injection detector, against a freshly seeded host. The model settings are the app's own.
- **A worst-case approver:** another person, who gives every card the answer of the case's label, also for a write nobody asked for.
- **Running and scoring are separate.** `runCase` records what happened; `scoreRun` is pure. Runs are appended to a JSONL file with a fingerprint of the code, tools, policy, prompt, model digest, limits and the case's inputs. Labels are not part of it, so a corrected label scores old runs again.
- **Success = the outcome:** the database in a closed world, the facts in the answer, a normal end with a non-empty answer, no unasked write even tried, no forbidden read.
- **The exception:** the 9 cases with neither a change nor a fact (no data, refused by a business rule, rejected by the approver) also need the right calls, with the right arguments. Otherwise "not found", said without looking, would pass.
- **Separate scores:** tools, arguments, calls against the reference, tokens, seconds, and unasked writes tried and run. Rates carry a 95% Wilson interval.
- **20 cases need a judge too** (a question back, a refusal, "no data"). Until session (b) their number is an upper bound and is reported on its own line.
- **The scorer is tested with scripted agents** (`scorer:check`) through the same graph and host. Good ones must pass (reference, extra reads, another right path), bad ones must fail (does nothing, claims it is done, extra write, harmful repeat, obeys the note), and wrong arguments must cost the argument score.

## Alternatives considered

### Through the platform (API, worker, Redis)

- Covers the queue, audit, memory and cache too.
- Not chosen: slower, more moving parts, and those have their own e2e tests. A bad score should point at the agent.

### A careful approver that rejects wrong writes

- Closer to real use.
- Not chosen: it hides the model's mistakes.

### Temperature 0 and a fixed seed

- Less noise.
- Not chosen: it would measure another agent than the one that ships. `--repeat` shows the noise instead.

### One weighted total

- A single number to compare.
- Not chosen: the weights would be arbitrary, and a safety failure could be averaged away.

## Consequences

**Positive**

- 9 scripted agents, 264 runs in about 3.5 minutes without a model: all scored as they must be. 11 of 11 rules broken on purpose in the compiled code were noticed.
- This check found a hole in the first version: looking up the wrong order and saying "not found" passed.

**Negative**

- A write with the same tool as an expected one, but another target, is seen by its effect only. If the host refuses it, the case can still pass (the argument score shows it).
- A read-only case is decided by the facts in the answer, so a lucky guess would pass. The values are specific (amounts, emails), so a guess is unlikely but possible for short ones ("12", "gold").
- Facts are found as whole words: "not delivered" contains "delivered".
- Not covered: memory, cache, queue, audit and delegated credentials.
- Repeats of one case are not independent, so intervals over repeats are too narrow.

**Follow-ups**

- Session (b): the judge with a hand check, the model runs, results in `docs/results/`.

## References

- [Demystifying evals for AI agents (Anthropic, 2026-01-09)](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), read 2026-11-25.
- ADR 0030 and 0031 (durable runs, approvals), 0047 (injection), 0049 (dataset).
