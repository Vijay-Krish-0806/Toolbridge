/**
 * The PUBLIC event schema of a ToolBridge run (Step 4.4a), version 1. This is the contract the
 * stream `GET /runs/:id/events` speaks and the chat widget (U1b) reads; see docs/run-events.md.
 *
 * Versioning: adding an optional field or a new event type keeps `v: 1` (clients must ignore
 * types and fields they do not know). Removing or changing the meaning of a field is a new
 * version. Internal events (model reasoning, raw model results, tool results, the tool menu) are
 * never part of it.
 */
import { z } from 'zod';

export const RUN_EVENTS_VERSION = 1;

/** A piece of the assistant's answer text (pieces are combined about every 100 ms). */
const textDelta = z.object({ text: z.string() });

/** The agent began calling a tool. `arguments` is the JSON text the model wrote. */
const toolCallStarted = z.object({
  callId: z.string(),
  tool: z.string(),
  arguments: z.string(),
});

/** A tool call ended. No result content: only whether it worked and, if not, the error code. */
const toolCallFinished = z.object({
  callId: z.string(),
  tool: z.string(),
  ok: z.boolean(),
  errorCode: z.string().optional(),
  durationMs: z.number(),
});

/** The run paused: a person must approve or reject these calls (all or nothing). */
const approvalRequired = z.object({
  approvalId: z.string(),
  level: z.enum(['required', 'high']),
  calls: z.array(
    z.object({
      callId: z.string(),
      tool: z.string(),
      arguments: z.string(),
      level: z.enum(['none', 'required', 'high']),
      reason: z.string(),
    }),
  ),
});

/** The last event of a run. After it the stream closes. */
const runFinished = z.object({
  status: z.enum(['completed', 'failed', 'cancelled']),
  answer: z.string().optional(),
  stopReason: z.string().optional(),
  error: z.string().optional(),
});

/** The data of each event type. */
export const runEventData = {
  text_delta: textDelta,
  tool_call_started: toolCallStarted,
  tool_call_finished: toolCallFinished,
  approval_required: approvalRequired,
  run_finished: runFinished,
} as const;

export type RunEventType = keyof typeof runEventData;
export const RUN_EVENT_TYPES = Object.keys(runEventData) as RunEventType[];

/** `{ type, data }` for one event type, before the log numbers it. */
export type RunEventBody = {
  [T in RunEventType]: { type: T; data: z.infer<(typeof runEventData)[T]> };
}[RunEventType];

const envelope = <T extends RunEventType>(type: T) =>
  z.object({
    v: z.literal(RUN_EVENTS_VERSION),
    runId: z.string(),
    /** 1, 2, 3, … per run, with no gaps: the cursor a reconnecting client sends back. */
    seq: z.number().int().min(1),
    /** ISO 8601 time the event was recorded. */
    at: z.string(),
    type: z.literal(type),
    data: runEventData[type],
  });

/** One event as it goes over the wire. */
export const runEventSchema = z.discriminatedUnion('type', [
  envelope('text_delta'),
  envelope('tool_call_started'),
  envelope('tool_call_finished'),
  envelope('approval_required'),
  envelope('run_finished'),
]);

export type RunEvent = z.infer<typeof runEventSchema>;

/** Parses an event; throws with a readable message on anything that is not a v1 event. */
export function parseRunEvent(raw: unknown): RunEvent {
  return runEventSchema.parse(raw);
}
