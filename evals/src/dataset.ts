/**
 * The agent eval dataset (Step 5.1): what one case looks like, and loading it.
 * A case says what a person asks, what a right run does, and what the world must look like
 * afterwards. It says nothing about HOW the run is made (which engine, which model): that is the
 * runner's job (Step 5.2).
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { z } from 'zod';

/** The repository root, from evals/dist/. */
export const root = resolve(import.meta.dirname, '../..');

/** How many cases each category has, and how many of those are held out as `test`. */
export const CATEGORIES = {
  single: { total: 9, test: 3 },
  'multi-step': { total: 14, test: 4 },
  ambiguous: { total: 6, test: 2 },
  forbidden: { total: 8, test: 2 },
  injection: { total: 8, test: 2 },
  'no-data': { total: 5, test: 2 },
} as const;
export type Category = keyof typeof CATEGORIES;

/**
 * What the host must answer when the call is replayed:
 * - `ok`: success; `many`: a page with at least two matches (proof that a name is ambiguous);
 * - `empty`: a page with no matches; `not_found`: HTTP 404 (proof that there is no data);
 * - `forbidden`: HTTP 403, and our policy denies the role too; `conflict`: HTTP 409, the role may
 *   call it but the host's business rules refuse it.
 */
const expectation = z.enum(['ok', 'many', 'empty', 'not_found', 'forbidden', 'conflict']);
export type Expectation = z.infer<typeof expectation>;

const args = z.record(z.string(), z.json());

const call = z.strictObject({
  tool: z.string(),
  /** The arguments that matter: a run's call must contain these values (it may add others). */
  args: args.default({}),
  /** Arguments the tool needs but whose value is free, such as a cancel reason. Only for replay. */
  fill: args.default({}),
  expect: expectation.default('ok'),
});
export type EvalCall = z.infer<typeof call>;

/** One database change that must happen. */
const change = z.strictObject({
  collection: z.string(),
  op: z.enum(['insert', 'update']),
  /** Field values that find the document (after the change). Dotted paths reach into objects. */
  where: args.refine((w) => Object.keys(w).length > 0, 'must not be empty'),
  /** Update only: top-level fields that must change, with their new values. */
  set: args.default({}),
  /** Update only: top-level fields that may change to any value (such as a timestamp). */
  touches: z.array(z.string()).default([]),
});
export type ExpectedChange = z.infer<typeof change>;

const answerFact = z.strictObject({
  /** The answer must contain one of these. The replay proves that a tool result holds the fact. */
  anyOf: z.array(z.string().min(1)).min(1),
});

const evalCase = z.strictObject({
  id: z.string(),
  category: z.enum(Object.keys(CATEGORIES) as [Category, ...Category[]]),
  /** `dev` is for tuning (Step 5.5); `test` is only reported, never tuned on. */
  split: z.enum(['dev', 'test']),
  role: z.enum(['owner', 'support', 'warehouse']),
  question: z.string().min(1),
  tags: z.array(z.string()).default([]),
  /**
   * What the person should get: an answer, a question back, a "cannot or was not done", or
   * "there is no such data". The wording is judged in Step 5.2.
   */
  behavior: z.enum(['answer', 'clarify', 'refuse', 'not_found']),
  /**
   * The calls a right run makes, in this order unless `ordered` is false. Each step is a list of
   * alternatives; the first is the reference that is replayed. Extra reads are allowed.
   */
  steps: z.array(z.array(call).min(1)).default([]),
  ordered: z.boolean().default(true),
  /** What the simulated approver does when a write waits for a person. */
  approval: z.enum(['approve', 'reject']).default('approve'),
  /** Every database change the run may make. CLOSED WORLD: any other change is a failure. */
  changes: z.array(change).default([]),
  /**
   * Writes the model may try besides the ones in `steps` (for example a refund the host will
   * refuse). Any other attempted write is a failure, even if an approver would have stopped it.
   */
  allowedWrites: z.array(z.string()).default([]),
  /** Reads that would mean the model obeyed injected text. */
  forbiddenTools: z.array(z.string()).default([]),
  answer: z
    .strictObject({
      mustInclude: z.array(answerFact).default([]),
      mustNotInclude: z.array(z.string().min(1)).default([]),
    })
    .prefault({}),
  /** Calls that prove the label (the host really refuses, the name really is ambiguous). */
  evidence: z.array(call).default([]),
});
export type EvalCase = z.infer<typeof evalCase>;

const datasetSchema = z.strictObject({
  source: z.string(),
  about: z.string(),
  cases: z.array(evalCase),
});

/**
 * Reads and validates a dataset file. Shape only; checkCase and the replay check the content.
 * Before -> after: `'evals/agent/host-store.json'` -> 50 cases with every default filled in.
 */
export async function loadDataset(file: string): Promise<EvalCase[]> {
  const raw: unknown = JSON.parse(await readFile(resolve(root, file), 'utf8'));
  const result = datasetSchema.safeParse(raw);
  if (!result.success) throw new Error(`${file}:\n${z.prettifyError(result.error)}`);
  return result.data.cases;
}
