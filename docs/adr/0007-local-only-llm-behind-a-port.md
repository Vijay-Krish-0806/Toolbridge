# ADR-0007: Local-only LLM behind an LLMProvider port

- **Status:** Accepted
- **Date:** 2026-11-17

## Context

The agent needs a chat model that supports tool calling. The project has a hard cost guard: no API keys and no paid services. The laptop has an RTX 2050 with 4 GB VRAM and 16 GB RAM. Tests must run without any model. Later phases may compare models or add a hosted one, so the agent loop must not depend on one vendor's SDK or wire format.

The smoke test on 2026-11-17 measured `qwen3.5:4b` on Ollama 0.40.16: the model loads 56% CPU / 44% GPU (4.2 GB at 16K context), produces about 10 tokens per second, and takes 8 to 10 seconds per tool-calling turn, most of it spent on "thinking" tokens. It returned well-formed tool calls through `/v1/chat/completions`, both streamed and not streamed.

## Decision

All core code depends on our own `LLMProvider` port (`generate` and `stream`, with provider-neutral message, tool-call and stream-event types). The only real adapter is `OpenAICompatibleProvider`, built on the official `openai` SDK (7.57.0) and pointed at Ollama's OpenAI-compatible endpoint, running `qwen3.5:4b`. Tests use a scripted `FakeProvider`. The context window is set server side through a versioned Modelfile (`infra/ollama/qwen3.5-4b-16k.Modelfile`, 16K), because the OpenAI API cannot set it per request.

## Alternatives considered

### Hosted API (OpenAI, Anthropic and others)

- Much stronger and faster tool calling.
- Rejected: costs money and needs keys, which breaks the cost guard. It can still plug in later behind the same port, with a spend cap set first.

### Ollama's native `/api/chat` instead of the OpenAI-compatible endpoint

- Supports per-request `num_ctx` and exposes thinking as a first-class field.
- Rejected: ties the adapter to Ollama. The OpenAI format also works with LM Studio, llama.cpp server and hosted OpenAI.

### Plain `fetch` with our own SSE parsing instead of the `openai` SDK

- No dependency, and every byte is visible.
- Rejected: about 80 more lines of parsing and retry code to own. The port types keep the SDK from leaking past the adapter, and the raw curl smoke test already shows the wire format.

### Setting `OLLAMA_CONTEXT_LENGTH` globally instead of a Modelfile

- One environment variable, affecting every model.
- Rejected: it changes the developer's machine settings and is not visible in the repo. Modelfile variants can sit side by side for the Step 1.4 measurements.

## Consequences

**Positive**

- The agent loop and tests are independent of any vendor. A new provider is one new adapter.
- Free, private and offline.

**Negative**

- Slow (about 10 s per turn) and weaker at tool calling than frontier models, so later steps need Zod validation of arguments, retry caps and tight tool descriptions.
- The OpenAI-compatible endpoint has no `tool_choice`, so the loop must accept a plain text answer at any step.
- `LLM_CONTEXT_LENGTH` must be kept in sync with the Modelfile by hand.
- The thinking text (Ollama's non-standard `reasoning` field) is currently dropped by the adapter.

**Follow-ups**

- Step 1.4: measure speed and memory at 8K, 16K and 32K, and whether turning thinking down (`reasoning_effort`) is worth the quality cost.

## References

- https://docs.ollama.com/api/openai-compatibility
- https://docs.ollama.com/context-length
- https://ollama.com/library/qwen3.5/tags
- https://github.com/openai/openai-node
- BUILD_PLAN.md sections 1.1 and 2
