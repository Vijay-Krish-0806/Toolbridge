/**
 * The text we embed for a tool. Pure. It decides what a search can match: words that appear only
 * in an argument ("amountCents", "reason: damaged") are lost if we embed the description alone.
 * Anything that changes this text re-embeds the tool, so keep it deterministic.
 */
import type { ToolDefinition } from '@toolbridge/spec-compiler';

/** Enum values beyond this are left out: a long list adds noise, not meaning. */
const MAX_ENUM_VALUES = 10;

/**
 * Builds the embedding text for one tool.
 * Before -> after: `refunds_request` with args `orderId`, `reason` (enum) ->
 * "Tool: refunds request\nRequest a refund. ...\nArguments:\n- orderId: Id of a shipped or
 * delivered order.\n- reason: one of damaged, not_as_described, ..."
 */
export function buildToolText(tool: ToolDefinition): string {
  const lines = [`Tool: ${tool.name.replaceAll('_', ' ')}`, tool.description.trim()];
  const args = argumentLines(tool.inputSchema);
  if (args.length > 0) lines.push('Arguments:', ...args);
  return lines.join('\n');
}

/** One line per top-level property: name, description, and short enum lists. */
function argumentLines(schema: Record<string, unknown>): string[] {
  const properties = schema.properties;
  if (typeof properties !== 'object' || properties === null) return [];
  return Object.entries(properties as Record<string, Record<string, unknown>>).map(
    ([name, prop]) => {
      const parts: string[] = [];
      if (typeof prop.description === 'string') parts.push(prop.description.trim());
      if (Array.isArray(prop.enum) && prop.enum.length <= MAX_ENUM_VALUES) {
        parts.push(`one of ${prop.enum.map(String).join(', ')}`);
      }
      return parts.length > 0 ? `- ${name}: ${parts.join('; ')}` : `- ${name}`;
    },
  );
}
