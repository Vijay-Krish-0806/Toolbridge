/**
 * Step 4.6: the PRICE TABLE and the cost of a model call.
 *
 * Prices are per model, in US dollars per million tokens (how providers publish them), with
 * separate input and output prices. A local model costs 0, so the same accounting code runs
 * whether the model is free or paid.
 *
 * Money is never a float here: cost is a whole number of MICRO-DOLLARS (1 USD = 1,000,000).
 * Handy fact: "X USD per million tokens" is exactly "X micro-dollars per token".
 */
import { z } from 'zod';

const price = z.strictObject({
  /** USD per million prompt tokens. */
  inputUsdPerMTok: z.number().min(0),
  /** USD per million generated tokens (thinking included). */
  outputUsdPerMTok: z.number().min(0),
});

export type ModelPrice = z.infer<typeof price>;

const priceTableSchema = z.strictObject({
  models: z.record(z.string().min(1), price),
});

export type PriceTable = z.infer<typeof priceTableSchema>;

/**
 * Checks a price table (parsed JSON) and returns it, or throws with every problem listed.
 * Strict: an unknown field is a typo (for example `inputUsdPerMtok`) and would silently price at 0.
 */
export function parsePriceTable(value: unknown): PriceTable {
  const result = priceTableSchema.safeParse(value);
  if (!result.success) throw new Error(`Invalid price table:\n${z.prettifyError(result.error)}`);
  return result.data;
}

/**
 * The price of one model. Throws when the model is not listed: an unpriced model must fail at
 * startup, not be counted as free.
 */
export function priceOf(table: PriceTable, model: string): ModelPrice {
  const found = table.models[model];
  if (!found) throw new Error(`No price for model "${model}" in the price table`);
  return found;
}

/**
 * The cost of one call, in whole micro-dollars (rounded once, at the end).
 * Before -> after: 1,000 input + 200 output at 3 / 15 USD per MTok -> 3,000 + 3,000 = 6,000
 * micro-dollars (0.006 USD); any tokens at 0 / 0 -> 0.
 */
export function costMicroUsd(
  priceOfModel: ModelPrice,
  tokens: { inputTokens: number; outputTokens: number },
): number {
  return Math.round(
    tokens.inputTokens * priceOfModel.inputUsdPerMTok +
      tokens.outputTokens * priceOfModel.outputUsdPerMTok,
  );
}
