/**
 * Step 3.3: checks the citations in an answer. Asking a model to cite is not enough: it can cite
 * an id it never retrieved (a made-up source looks just as convincing). A citation is grounded
 * only when knowledge_search returned that id during the same run.
 */
import type { ChatMessage, ToolCall } from '../llm/types.js';
import { KNOWLEDGE_TOOL_NAME } from '../tools/knowledge-tool.js';
import type { ToolResult } from '../tools/executor.js';

/** `doc-id#section-slug`, the shape of every chunk id. */
const CITATION = /\b[a-z0-9]+(?:-[a-z0-9]+)*#[a-z0-9]+(?:-[a-z0-9]+)*\b/g;
/**
 * Phrases that mean "the policies do not say". A heuristic, so callers keep the answer text.
 * Widened after the first saved eval: "I cannot find any information" and "do not include any
 * information" were correct answers the first list missed.
 */
const NOT_COVERED =
  /(not cover|n't cover|not covered|no (specific |documented |established )?(policy|information|mention|rule)|not mention|(couldn't|could not|cannot|can't) find|not include|not specified|don't have (a|any) (policy|information))/i;

/**
 * True when the answer says the policies do not answer the question.
 * Before -> after: `'Our policies do not cover gift cards.'` -> `true`; `'Yes, within 30 days.'` -> `false`.
 */
export function saysNotCovered(answer: string): boolean {
  return NOT_COVERED.test(answer);
}

/**
 * A warning for the reader, or undefined when the answer looks fine. Catches the failure seen in
 * the Step 3.3 eval: the model searched, answered from the passages, but cited nothing, so the
 * reader cannot check the source. Also flags cited ids that were never retrieved.
 * Before -> after: searched, answer 'Refunds within 30 days.' with no citation ->
 * `'the answer cites no policy passage, although knowledge_search returned some; check it against the policies'`.
 */
export function citationWarning(
  check: CitationCheck,
  retrievedCount: number,
  answer: string,
): string | undefined {
  if (check.ungrounded.length > 0) {
    return `cites passages that were never retrieved: ${check.ungrounded.join(', ')}`;
  }
  if (retrievedCount > 0 && check.cited.length === 0 && !saysNotCovered(answer)) {
    return 'the answer cites no policy passage, although knowledge_search returned some; check it against the policies';
  }
  return undefined;
}

export interface CitationCheck {
  /** Ids cited in the answer, in order of first appearance. */
  cited: string[];
  /** Cited ids that knowledge_search returned in this run. */
  grounded: string[];
  /** Cited ids it never returned: invented or remembered from elsewhere. */
  ungrounded: string[];
}

/**
 * Finds the chunk ids an answer cites, with or without brackets, each once.
 * Before -> after: `'No [refund-policy#who-can-refund], ask the owner [refund-policy#who-can-refund].'`
 * -> `['refund-policy#who-can-refund']`.
 */
export function extractCitations(answer: string): string[] {
  return [...new Set(answer.match(CITATION) ?? [])];
}

/**
 * The passage ids one tool call returned, if it was a successful knowledge_search; else none.
 * Reads the `"id":"..."` fields with a pattern instead of JSON.parse, because the executor may
 * have truncated a long result, and a cut-off result is no longer valid JSON.
 * Before -> after: a knowledge_search result `{"passages":[{"id":"a#b",...}],...}` -> `['a#b']`.
 */
export function passageIds(call: ToolCall, result: ToolResult): string[] {
  if (call.name !== KNOWLEDGE_TOOL_NAME || !result.ok) return [];
  return [...result.content.matchAll(/"id":"([^"]+)"/g)].flatMap((m) => (m[1] ? [m[1]] : []));
}

/**
 * Splits an answer's citations into grounded and ungrounded.
 * Before -> after: answer citing `a#b` and `c#d`, retrieved `{a#b}` ->
 * `{ cited: ['a#b', 'c#d'], grounded: ['a#b'], ungrounded: ['c#d'] }`.
 */
export function checkCitations(answer: string, retrieved: ReadonlySet<string>): CitationCheck {
  const cited = extractCitations(answer);
  return {
    cited,
    grounded: cited.filter((id) => retrieved.has(id)),
    ungrounded: cited.filter((id) => !retrieved.has(id)),
  };
}

/** Where an answer comes from, as far as code can check it. */
export interface AnswerSources {
  /** Cited passages that knowledge_search really returned in this run. */
  sources: { id: string; section: string }[];
  /** Set when the reader should check the answer (an invented source, or none at all). */
  warning?: string;
}

/**
 * The checked sources of a finished run, from its messages: every leg's, because a resumed run's
 * checkpoint holds them all. Undefined when the answer neither searched nor cites anything.
 * Before -> after: knowledge_search returned `refund-policy#intro`, answer 'Yes [refund-policy#intro]'
 * -> `{ sources: [{ id: 'refund-policy#intro', section: 'Refund policy' }] }`.
 */
export function answerSources(messages: ChatMessage[], answer: string): AnswerSources | undefined {
  const searches = new Set(
    messages
      .flatMap((m) => (m.role === 'assistant' ? m.toolCalls : []))
      .filter((call) => call.name === KNOWLEDGE_TOOL_NAME)
      .map((call) => call.id),
  );
  const sectionOf = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'tool' || !searches.has(message.toolCallId)) continue;
    // A pattern, not JSON.parse: a long result may have been cut off.
    const found = message.content.matchAll(/"id":"([^"]+)","section":("(?:[^"\\]|\\.)*")/g);
    for (const [, id, section] of found) {
      if (id && section) sectionOf.set(id, JSON.parse(section) as string);
    }
  }
  const check = checkCitations(answer, new Set(sectionOf.keys()));
  if (searches.size === 0 && check.cited.length === 0) return undefined;
  const warning = answer.trim() === '' ? undefined : citationWarning(check, sectionOf.size, answer);
  return {
    sources: check.grounded.map((id) => ({ id, section: sectionOf.get(id) ?? id })),
    ...(warning !== undefined && { warning }),
  };
}
