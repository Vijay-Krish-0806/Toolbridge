# ADR-0014: Tool generation rules: flat inputs, JSON Schema definitions, and an overrides file

- **Status:** Accepted
- **Date:** 2026-11-19

## Context

Step 2.2 turns the `ApiModel` IR (ADR 0013) into tools a small local model can use. Tool quality decides whether `qwen3.5:4b` picks the right tool and sends valid arguments. Facts found while building:

- **The host spec itself was wrong in two places.** `page`/`limit` (18 params) and `dryRun` were `type: object`, because the properties had an initializer but no type annotation. 15 ObjectId path params were `$ref: Function` (an empty object), because the handler type is `Types.ObjectId`. A model reading these would send `{}`.
- In @nestjs/swagger 12.1.2, `ApiParam({ schema })` is **merged** with the type the plugin guessed (it gave `type: string` plus `allOf: [Function]`, which nothing can satisfy). `ApiParam({ type: String })` **replaces** it.
- Host descriptions refer to routes ("Find it with GET /customers?search="). The model never sees routes, only tool names.
- Tool names: the OpenAI SDK allows `a-z A-Z 0-9 _ -`, max 64. MCP spec 2025-11-25 recommends 1–128 of letters, digits and `_ - .`.
- Results: host 35 tools from 41 ops (about 5.6K tokens for the whole menu, roughly a third of the 16K context). GitHub 1,281 tools (about 458K tokens). Stripe 612 tools (about 380K tokens; largest single schema 43K characters). 0 invalid or duplicate names on all three; 34 ms to compile the big ones.

## Decision

1. `compileTools(model, overrides)` is pure. It returns `ToolDefinition`s as **plain JSON Schema data** (no Zod); runtime validation of arguments comes in 2.3.
2. **Flat inputs:** path, query, header and body fields become one object; a `Binding` per variant records where each argument goes. Name clashes get a location prefix (`body_id`). A non-object body becomes one `body` argument.
3. **Names:** snake_case of the operationId, with NestJS `XController_` shortened to `x_`; `method_path` when there is none; fit to `^[a-zA-Z0-9_-]{1,64}$` (cut plus hash), then de-duplicated with `_2`.
4. **Schemas:** keep only validation keys, depth limit 4 (cyclic refs expanded from `model.schemas` up to it), drop `readOnly` fields, flatten one-item `allOf`, `nullable` becomes `type: [T, "null"]`. Enums over 25 values lose the `enum` constraint and list values in the description instead, so no valid value is rejected.
5. **Safety and risk:** GET/HEAD/OPTIONS are read/low, DELETE write/high, other writes medium. A JSON **overrides file** (strict Zod schema) can hide, rename, re-describe, re-classify or merge operations. A merged tool runs the first variant whose required arguments are present.
6. Route mentions in descriptions are rewritten to tool names.
7. Wrong host types are fixed **in the host** (we own it), not patched in ToolBridge.

## Alternatives considered

### Nested inputs (`{ path: {}, query: {}, body: {} }`)

- No name clashes and a trivial mapping.
- Rejected: an extra level for every call; small models handle flat arguments better, and the binding map is cheap.

### Zod schemas in the tool definitions

- Same type as the hand-written Phase 1 tools.
- Rejected: the source is JSON Schema, MCP sends JSON Schema, and functions cannot be cached (2.4). Convert once, at execution time, if needed.

### Schema patches in the overrides file

- Needed one day for third-party specs we cannot change.
- Not now: our only spec is our own, so fixing the source is honest and cheaper. Add patches when a real foreign spec needs them.

### Trimming long enums

- Smaller schemas.
- Rejected: it would make the dropped values invalid. Loosening keeps the schema true.

## Consequences

**Positive**

- 35 clean host tools in a golden snapshot; names are valid for both OpenAI-style APIs and MCP.
- Human judgment (what is risky, what to hide or merge) lives in one reviewed file, not in code.

**Negative**

- The whole host menu takes about a third of the 16K context, and big APIs are far beyond any context.
- Depth limits do not limit width: one Stripe tool's schema is 43K characters.
- The ObjectId `pattern` was lost in the host spec (only the description says "24 hexadecimal characters").
- Tool names follow the spec's operationIds, so their quality depends on the spec author.

**Follow-ups**

- Phase 3: tool retrieval (send only relevant tools); this is now required, not optional.
- A per-tool schema size budget if wide schemas matter for a real spec.
- 2.3: convert `inputSchema` to a runtime validator, pick merged variants, and handle non-JSON bodies.

## References

- ADR 0013 (IR), ADR 0011 (context budget).
- MCP specification 2025-11-25, Tools: tool names.
- `openai` SDK `FunctionDefinition.name` documentation (installed package).
