# ToolBridge: rules for Claude Code

Source: section 4 of `docs/BUILD_PLAN.md`. The workspace rules in `../CLAUDE.md` also apply.

- Read `docs/BUILD_PLAN.md` and work only on the step I name. Do not start the next step.
- Before coding, post a short plan: files to create or change, interfaces, and tests. Wait for my go-ahead on anything that changes architecture.
- Keep code simple and typed. Prefer small modules with one responsibility. No dead code or speculative abstractions.
- Write tests alongside code. A step is not done until its acceptance checks pass.
- Check current official docs and versions before adding dependencies or using fast-moving APIs. Justify every new dependency in one line.
- Never commit secrets. Use `.env.example` and validate config at startup.
- Record each non-trivial decision as an ADR in `docs/adr/` with alternatives considered.
- When finished: summarize what changed, how to run it, what I should learn from it, and any shortcuts you took.
- Explain concepts when I ask. Teaching me matters as much as the code.
- If anything is ambiguous, ask one focused question instead of guessing.
- At the end of every step, write a short learning note to the shared learning inbox as described in section 1.2 of the build plan. Keep it under about 400 words and include only links you have actually opened.

## Learning inbox

- Location: `../learning-inbox/` (that is, `/learning/learning-inbox/`). It is outside this repo and is never committed to it.
- File name: `toolbridge-step-<id>-<topic-slug>.md`, one per step, plus one summary note per phase.
- Format: the frontmatter and headings in section 1.2 of `docs/BUILD_PLAN.md`.
