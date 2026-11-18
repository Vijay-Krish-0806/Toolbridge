/**
 * Schema simplification: turns a spec's request schema into something a small model reads well.
 * Keeps only keys that describe valid input, cuts deep nesting, and never makes a schema stricter
 * than the spec (a valid request must stay valid).
 */
import type { JsonSchema } from '../model.js';

export const MAX_SCHEMA_DEPTH = 4;
export const MAX_ENUM_VALUES = 25;
export const MAX_PROPERTY_DESCRIPTION = 300;

/** Keys that describe what input is valid. Everything else (example, xml, title, x-*, ...) is noise for the model. */
const KEPT_KEYS = new Set([
  'type',
  'description',
  'enum',
  'const',
  'format',
  'default',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'properties',
  'required',
  'items',
  'additionalProperties',
  'anyOf',
  'oneOf',
  'allOf',
]);

/**
 * Simplifies one schema. `depth` counts object/array nesting from the tool's top-level arguments.
 * `refs` is the IR's `schemas` map, used to expand `$ref`s that were left because of cycles.
 *
 * Before -> after (examples):
 * - `{ type: 'string', nullable: true, example: 'x' }` -> `{ type: ['string', 'null'] }`
 * - `{ allOf: [{ type: 'object', properties: {...} }], description: 'd' }` -> `{ type: 'object', properties: {...}, description: 'd' }`
 * - `{ $ref: '#/components/schemas/Node' }` at depth 5 -> `{ type: 'object', description: 'Nested data; details omitted.' }`
 */
export function simplifySchema(
  schema: unknown,
  refs: Record<string, JsonSchema>,
  depth = 1,
): JsonSchema {
  if (typeof schema !== 'object' || schema === null) return {}; // `true` (anything) in 3.1, or junk
  let source = schema as JsonSchema;

  if (typeof source.$ref === 'string') {
    const target = refs[source.$ref];
    if (target === undefined || depth > MAX_SCHEMA_DEPTH) return omitted(source);
    source = target;
  }
  source = flattenSingleAllOf(source);
  if (depth > MAX_SCHEMA_DEPTH && isContainer(source)) return omitted(source);

  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(source)) {
    if (!KEPT_KEYS.has(key)) continue;
    switch (key) {
      case 'properties':
        out.properties = simplifyProperties(value, refs, depth);
        break;
      case 'items':
        out.items = simplifySchema(value, refs, depth + 1);
        break;
      case 'additionalProperties':
        out.additionalProperties =
          typeof value === 'boolean' ? value : simplifySchema(value, refs, depth + 1);
        break;
      case 'anyOf':
      case 'oneOf':
      case 'allOf':
        out[key] = Array.isArray(value) ? value.map((s) => simplifySchema(s, refs, depth)) : value;
        break;
      case 'description':
        if (typeof value === 'string') out.description = capText(value, MAX_PROPERTY_DESCRIPTION);
        break;
      default:
        out[key] = value;
    }
  }

  if (source.nullable === true && typeof out.type === 'string') out.type = [out.type, 'null'];
  if (out.properties !== undefined) out.required = keepKnownRequired(out);
  if (Array.isArray(out.enum) && out.enum.length > MAX_ENUM_VALUES) loosenLongEnum(out);
  return out;
}

/**
 * Simplifies each property and drops `readOnly` ones: those only appear in responses (like
 * `createdAt`), so the model must not be asked for them.
 */
function simplifyProperties(
  value: unknown,
  refs: Record<string, JsonSchema>,
  depth: number,
): Record<string, JsonSchema> {
  const result: Record<string, JsonSchema> = {};
  if (typeof value !== 'object' || value === null) return result;
  for (const [name, prop] of Object.entries(value as Record<string, unknown>)) {
    if (typeof prop === 'object' && prop !== null && (prop as JsonSchema).readOnly === true)
      continue;
    result[name] = simplifySchema(prop, refs, depth + 1);
  }
  return result;
}

/** NestJS wraps nested DTOs in a one-item `allOf`. Merges it into the parent; the parent's own keys win. */
function flattenSingleAllOf(schema: JsonSchema): JsonSchema {
  const allOf = schema.allOf;
  if (!Array.isArray(allOf) || allOf.length !== 1) return schema;
  const [only] = allOf as unknown[];
  if (typeof only !== 'object' || only === null) return schema;
  const rest = { ...schema };
  delete rest.allOf;
  return { ...(only as JsonSchema), ...rest };
}

/** True for schemas that can nest further (objects and arrays). */
function isContainer(schema: JsonSchema): boolean {
  return (
    schema.type === 'object' ||
    schema.type === 'array' ||
    schema.properties !== undefined ||
    schema.items !== undefined
  );
}

/** Placeholder for nesting we cut off: still an object, so the model can pass one, but no details. */
function omitted(schema: JsonSchema): JsonSchema {
  const note = 'Nested data; details omitted.';
  const description =
    typeof schema.description === 'string' ? `${schema.description} ${note}` : note;
  return { type: 'object', description: capText(description, MAX_PROPERTY_DESCRIPTION) };
}

/** Keeps only `required` names whose property survived (readOnly ones were dropped). */
function keepKnownRequired(schema: JsonSchema): string[] {
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
  const props = schema.properties as Record<string, unknown>;
  return required.filter((name): name is string => typeof name === 'string' && name in props);
}

/**
 * A long enum costs many tokens. Cutting it would reject valid values, so instead the `enum`
 * constraint is removed and the first values are listed in the description.
 * Before -> after: `{ enum: [60 values] }` -> `{ description: 'Allowed values include: a, b, ... (60 in total).' }`
 */
function loosenLongEnum(schema: JsonSchema): void {
  const values = schema.enum as unknown[];
  delete schema.enum;
  const listed = values
    .slice(0, MAX_ENUM_VALUES)
    .map((v) => JSON.stringify(v))
    .join(', ');
  const note = `Allowed values include: ${listed}, ... (${String(values.length)} in total).`;
  const description =
    typeof schema.description === 'string' ? `${schema.description} ${note}` : note;
  schema.description = capText(description, MAX_PROPERTY_DESCRIPTION * 2);
}

/** Collapses whitespace and cuts text to `max` characters with an ellipsis. */
export function capText(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}
