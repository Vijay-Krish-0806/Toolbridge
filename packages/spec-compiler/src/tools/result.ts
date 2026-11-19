/**
 * Compile-time check of result field allowlists: every field named in the overrides file must
 * exist in the operation's response schema. A typo would otherwise silently empty the result.
 */
import type { JsonSchema, Operation } from '../model.js';

/**
 * Returns the fields that are not in the response schema (empty when all are found).
 * For a page `{ items: [...], total }` or an array, fields are looked up in the item schema.
 * Before -> after: fields `['number', 'nmuber']` on OrdersController_list -> `['nmuber']`.
 */
export function unknownResultFields(
  op: Operation,
  fields: string[],
  refs: Record<string, JsonSchema>,
): string[] {
  const success = op.responses.find((r) => r.status.startsWith('2') && r.schema !== undefined);
  if (success?.schema === undefined) return fields;
  const item = itemSchema(resolveSchema(success.schema, refs), refs);
  return fields.filter((path) => !hasPath(item, path.split('.'), refs));
}

/** The schema of one item: `items` of a page, the element of an array, or the schema itself. */
function itemSchema(schema: JsonSchema, refs: Record<string, JsonSchema>): JsonSchema {
  const props = schema.properties as Record<string, JsonSchema> | undefined;
  const pageItems = props?.items;
  if (pageItems !== undefined && resolveSchema(pageItems, refs).type === 'array') {
    return resolveSchema(resolveSchema(pageItems, refs).items as JsonSchema, refs);
  }
  if (schema.type === 'array') return resolveSchema(schema.items as JsonSchema, refs);
  return schema;
}

/** True if following `path` through `properties` (and one-item allOf wrappers) finds a field. */
function hasPath(schema: JsonSchema, path: string[], refs: Record<string, JsonSchema>): boolean {
  const [head, ...rest] = path;
  if (head === undefined) return true;
  const props = resolveSchema(schema, refs).properties as Record<string, JsonSchema> | undefined;
  const next = props?.[head];
  return next !== undefined && hasPath(next, rest, refs);
}

/**
 * Follows a leftover `$ref` (cyclic schemas) and unwraps a one-item `allOf`, which NestJS uses
 * for nested DTOs. Anything else is returned as-is.
 */
export function resolveSchema(
  schema: JsonSchema | undefined,
  refs: Record<string, JsonSchema>,
): JsonSchema {
  let current = schema ?? {};
  for (let i = 0; i < 5; i++) {
    if (typeof current.$ref === 'string' && refs[current.$ref] !== undefined) {
      current = refs[current.$ref] ?? {};
    } else if (Array.isArray(current.allOf) && current.allOf.length === 1) {
      current = { ...(current.allOf[0] as JsonSchema), ...withoutAllOf(current) };
    } else break;
  }
  return current;
}

/** A copy of the schema without its `allOf` key. */
function withoutAllOf(schema: JsonSchema): JsonSchema {
  const copy = { ...schema };
  delete copy.allOf;
  return copy;
}
