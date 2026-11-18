/**
 * Tool generator: ApiModel (IR) + overrides -> agent-ready tool definitions. Pure, no I/O.
 */
import type { ApiModel, HttpMethod, JsonSchema, Operation } from '../model.js';
import { linkMentions } from './mentions.js';
import { defaultToolName, fitName, uniqueName } from './naming.js';
import { type MergeRule, type Overrides, parseOverrides } from './overrides.js';
import { unknownResultFields } from './result.js';
import { capText, simplifySchema } from './schema.js';
import type {
  ArgBinding,
  Binding,
  CompileToolsResult,
  RiskLevel,
  SafetyClass,
  ToolDefinition,
  ToolWarning,
} from './types.js';

export const MAX_TOOL_DESCRIPTION = 1000;

const READ_METHODS: ReadonlySet<HttpMethod> = new Set(['get', 'head', 'options']);
/** Methods whose request body we ignore: HTTP gives a body on GET/HEAD no defined meaning. */
const NO_BODY_METHODS: ReadonlySet<HttpMethod> = new Set(['get', 'head']);
const RISK_ORDER: readonly RiskLevel[] = ['low', 'medium', 'high'];

/** One operation's binding plus the argument schemas it contributes to the tool's input. */
interface BoundOperation {
  binding: Binding;
  properties: Record<string, JsonSchema>;
}

/**
 * Compiles every visible operation into a tool. Merged operations become one tool, placed where
 * the first of them appears in the spec, so the output order is stable.
 *
 * Before -> after: `GET /orders/{id}` (OrdersController_getById) ->
 * `{ name: 'orders_get_by_id', inputSchema: { type: 'object', properties: { id }, required: ['id'] },
 *    safety: 'read', risk: 'low', variants: [{ method: 'get', path: '/orders/{id}', args: { id: { in: 'path', name: 'id' } } }] }`.
 */
export function compileTools(
  model: ApiModel,
  overrides: Overrides = parseOverrides({}),
): CompileToolsResult {
  const warnings: ToolWarning[] = [];
  const warn = (message: string, subject?: string): void => {
    warnings.push(subject === undefined ? { message } : { subject, message });
  };

  const byId = new Map(model.operations.map((op) => [op.id, op]));
  for (const id of Object.keys(overrides.operations)) {
    if (!byId.has(id)) warn(`Override for unknown operation "${id}" was ignored.`, id);
  }
  const mergeOf = indexMerges(overrides.merge, byId, warn);

  const taken = new Set<string>();
  const tools: ToolDefinition[] = [];
  const emittedMerges = new Set<MergeRule>();

  for (const op of model.operations) {
    const rule = mergeOf.get(op.id);
    if (rule !== undefined) {
      if (emittedMerges.has(rule)) continue;
      emittedMerges.add(rule);
      // Only operations this rule actually owns (indexMerges dropped unknown and twice-merged ones).
      const members = rule.operations.flatMap((id) =>
        mergeOf.get(id) === rule ? (byId.get(id) ?? []) : [],
      );
      tools.push(buildMergedTool(rule, members, model, taken, warn));
      continue;
    }

    const override = overrides.operations[op.id] ?? {};
    if (override.hidden === true) continue;

    const bound = bindOperation(op, model, warn);
    const name = claimName(override.name ?? defaultToolName(op), op.id, taken, warn);
    if (override.result !== undefined) {
      for (const field of unknownResultFields(op, override.result.fields, model.schemas)) {
        warn(`Result field "${field}" is not in the response schema.`, op.id);
      }
    }
    tools.push({
      name,
      description: composeDescription(op, override.description),
      inputSchema: inputSchemaFor(bound.properties, bound.binding.requiredArgs),
      safety: override.safety ?? defaultSafety(op.method),
      risk: override.risk ?? defaultRisk(op.method),
      variants: [bound.binding],
      ...(override.result !== undefined && { result: override.result }),
    });
  }
  linkMentions(tools);
  return { tools, warnings };
}

/**
 * Maps each merged operation id to its merge rule, and reports rules that name unknown
 * operations or reuse an operation already merged elsewhere (those entries are dropped).
 */
function indexMerges(
  rules: MergeRule[],
  byId: Map<string, Operation>,
  warn: (message: string, subject?: string) => void,
): Map<string, MergeRule> {
  const mergeOf = new Map<string, MergeRule>();
  for (const rule of rules) {
    for (const id of rule.operations) {
      if (!byId.has(id))
        warn(`Merge "${rule.name}" names unknown operation "${id}"; skipped.`, rule.name);
      else if (mergeOf.has(id))
        warn(`Operation "${id}" is in two merges; kept the first.`, rule.name);
      else mergeOf.set(id, rule);
    }
  }
  return mergeOf;
}

/**
 * Builds one tool out of several operations (for example get order by id / by number).
 * Its input is the union of all arguments; only arguments every variant needs are required.
 * It is a write tool if any variant writes, and takes the highest risk unless the rule sets one.
 */
function buildMergedTool(
  rule: MergeRule,
  members: Operation[],
  model: ApiModel,
  taken: Set<string>,
  warn: (message: string, subject?: string) => void,
): ToolDefinition {
  const bound = members.map((op) => bindOperation(op, model, warn));
  const properties: Record<string, JsonSchema> = {};
  for (const b of bound) {
    for (const [arg, schema] of Object.entries(b.properties)) properties[arg] ??= schema;
  }
  const required = Object.keys(properties).filter((arg) =>
    bound.every((b) => b.binding.requiredArgs.includes(arg)),
  );
  const risks = members.map((op) => defaultRisk(op.method));
  return {
    name: claimName(rule.name, rule.name, taken, warn),
    description: capText(rule.description, MAX_TOOL_DESCRIPTION),
    inputSchema: inputSchemaFor(properties, required),
    safety: members.some((op) => defaultSafety(op.method) === 'write') ? 'write' : 'read',
    risk:
      rule.risk ?? risks.reduce((a, b) => (RISK_ORDER.indexOf(b) > RISK_ORDER.indexOf(a) ? b : a)),
    variants: bound.map((b) => b.binding),
  };
}

/**
 * Flattens an operation's parameters and body fields into one argument list, remembering where
 * each one goes. A name clash gets a location prefix (a body field `id` next to a path `id`
 * becomes `body_id`).
 * Before -> after: path `id` + body `{ reason, amountCents }` ->
 * args `{ id: path.id, reason: body.reason, amountCents: body.amountCents }`.
 */
function bindOperation(
  op: Operation,
  model: ApiModel,
  warn: (message: string, subject?: string) => void,
): BoundOperation {
  const args: Record<string, ArgBinding> = {};
  const properties: Record<string, JsonSchema> = {};
  const requiredArgs: string[] = [];

  /** Adds one argument under a free name and returns the name used. */
  const add = (
    preferred: string,
    prefix: string,
    binding: ArgBinding,
    schema: JsonSchema,
    required: boolean,
  ): string => {
    const arg = preferred in args ? `${prefix}_${preferred}` : preferred;
    args[arg] = binding;
    properties[arg] = schema;
    if (required) requiredArgs.push(arg);
    return arg;
  };

  for (const param of op.parameters) {
    if (param.in === 'cookie') {
      warn(`Cookie parameter "${param.name}" is not supported; skipped.`, op.id);
      continue;
    }
    const schema = simplifySchema(param.schema, model.schemas);
    if (param.description !== undefined && schema.description === undefined) {
      schema.description = capText(param.description, 300);
    }
    add(param.name, param.in, { in: param.in, name: param.name }, schema, param.required);
  }

  const binding: Binding = {
    operationId: op.id,
    method: op.method,
    path: op.path,
    security: op.security,
    args,
    requiredArgs,
  };

  const body = op.requestBody;
  if (body !== undefined && NO_BODY_METHODS.has(op.method)) {
    warn(`${op.method.toUpperCase()} has a request body; ignored.`, op.id);
  } else if (body !== undefined) {
    binding.bodyContentType = body.contentType;
    // depth 0: the body's own fields become top-level arguments (depth 1).
    const schema = simplifySchema(body.schema, model.schemas, 0);
    const fields = schema.properties as Record<string, JsonSchema> | undefined;
    if (fields !== undefined && Object.keys(fields).length > 0) {
      const requiredFields = new Set(
        Array.isArray(schema.required) ? (schema.required as string[]) : [],
      );
      for (const [field, fieldSchema] of Object.entries(fields)) {
        add(
          field,
          'body',
          { in: 'body', name: field },
          fieldSchema,
          body.required && requiredFields.has(field),
        );
      }
    } else if (fields === undefined) {
      // Not an object (an array, a string, a oneOf...): pass it as one argument.
      if (body.description !== undefined) schema.description ??= capText(body.description, 300);
      binding.wholeBodyArg = add(
        'body',
        'request',
        { in: 'body', name: '' },
        schema,
        body.required,
      );
    }
    // An object body with no fields contributes no arguments.
  }

  return { binding, properties };
}

/** Wraps argument schemas into the tool's top-level input schema. */
function inputSchemaFor(properties: Record<string, JsonSchema>, required: string[]): JsonSchema {
  return {
    type: 'object',
    properties,
    ...(required.length > 0 && { required }),
    additionalProperties: false,
  };
}

/**
 * The tool description: summary and description from the spec (or the override), whitespace
 * collapsed and capped. Falls back to "METHOD /path" so it is never empty.
 * Before -> after: summary 'List orders' + description 'Newest first. ...' -> 'List orders. Newest first. ...'
 */
function composeDescription(op: Operation, override: string | undefined): string {
  const parts = override !== undefined ? [override] : [op.summary, op.description];
  const text = parts
    .filter((p): p is string => p !== undefined && p.trim() !== '')
    .map((p) => (/[.!?]$/.test(p.trim()) ? p.trim() : `${p.trim()}.`))
    .join(' ');
  const base = text === '' ? `${op.method.toUpperCase()} ${op.path}.` : text;
  return capText(op.deprecated ? `Deprecated. ${base}` : base, MAX_TOOL_DESCRIPTION);
}

/** Fits and de-duplicates a tool name, warning when either changed it. */
function claimName(
  wanted: string,
  subject: string,
  taken: Set<string>,
  warn: (message: string, subject?: string) => void,
): string {
  const fitted = fitName(wanted);
  if (fitted !== wanted)
    warn(`Name "${wanted}" is not a valid tool name; using "${fitted}".`, subject);
  const unique = uniqueName(fitted, taken);
  if (unique !== fitted) warn(`Name "${fitted}" is already used; using "${unique}".`, subject);
  return unique;
}

/** GET/HEAD/OPTIONS only read; every other method may change data. */
function defaultSafety(method: HttpMethod): SafetyClass {
  return READ_METHODS.has(method) ? 'read' : 'write';
}

/** Reads are low risk, deletes high, other writes medium. Overrides raise money-moving actions. */
function defaultRisk(method: HttpMethod): RiskLevel {
  if (READ_METHODS.has(method)) return 'low';
  return method === 'delete' ? 'high' : 'medium';
}
