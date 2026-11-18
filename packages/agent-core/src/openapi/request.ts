/**
 * Turns a generated tool's flat arguments back into an HTTP request. Pure: no network.
 * The binding (from spec-compiler) says where each argument goes: path, query, header or body.
 */
import type { Binding, ToolDefinition } from '@toolbridge/spec-compiler';

import { ToolExecutionError } from '../tools/errors.js';

export type Args = Record<string, unknown>;

export interface HttpRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Picks which operation to call. A normal tool has one variant. A merged tool (for example
 * orders_get = by id OR by number) runs the first variant whose required arguments are present.
 * Before -> after: `{ number: 'ORD-10042' }` on orders_get -> the `GET /orders/by-number/{number}` binding.
 */
export function selectVariant(tool: ToolDefinition, args: Args): Binding {
  const given = (arg: string): boolean => args[arg] !== undefined && args[arg] !== null;
  const chosen = tool.variants.find((v) => v.requiredArgs.every(given));
  if (chosen !== undefined) return chosen;

  const options = tool.variants.map((v) => v.requiredArgs.join(' + ') || '(nothing)');
  throw new ToolExecutionError(
    'invalid_arguments',
    `${tool.name} needs one of these argument sets: ${options.join(' OR ')}.`,
  );
}

/**
 * Builds the request for one operation.
 * Before -> after: binding `POST /refunds/{id}/approve` + args `{ id: '65f...', note: 'ok' }` ->
 * `{ method: 'POST', url: <base>/refunds/65f.../approve, headers: { content-type: application/json }, body: '{"note":"ok"}' }`.
 *
 * Safety: path values are percent-encoded (a `/` cannot add a segment) and `.`/`..` are refused
 * (they would walk up the path), and the final URL must still be on the base URL's origin.
 */
export function buildRequest(binding: Binding, args: Args, baseUrl: URL): HttpRequest {
  const headers: Record<string, string> = { accept: 'application/json' };
  const query = new URLSearchParams();
  const bodyFields: Args = {};

  let path = binding.path;
  for (const [arg, target] of Object.entries(binding.args)) {
    const value = args[arg];
    if (value === undefined || value === null) continue;
    switch (target.in) {
      case 'path':
        path = path.replaceAll(`{${target.name}}`, pathSegment(arg, value));
        break;
      case 'query':
        for (const item of Array.isArray(value) ? value : [value]) {
          query.append(target.name, scalar(arg, item));
        }
        break;
      case 'header':
        headers[target.name.toLowerCase()] = scalar(arg, value);
        break;
      case 'cookie':
        break; // the compiler never binds cookies (it warns and skips them)
      case 'body':
        if (arg !== binding.wholeBodyArg) bodyFields[target.name] = value;
        break;
    }
  }
  if (/\{[^}]+\}/.test(path)) {
    throw new ToolExecutionError(
      'invalid_arguments',
      `Missing a path argument for ${binding.path}.`,
    );
  }

  // The base URL may carry a prefix such as https://api.example.com/v1.
  const prefix = baseUrl.pathname.replace(/\/+$/, '');
  const url = new URL(`${prefix}${path}`, baseUrl.origin);
  url.search = query.toString();
  if (url.origin !== baseUrl.origin) {
    throw new ToolExecutionError('blocked', `Refused: request would leave ${baseUrl.origin}.`);
  }

  const request: HttpRequest = { method: binding.method.toUpperCase(), url, headers };
  const bodyValue =
    binding.wholeBodyArg !== undefined ? args[binding.wholeBodyArg] : nonEmpty(bodyFields);
  if (bodyValue !== undefined && binding.bodyContentType !== undefined) {
    request.body = encodeBody(binding.bodyContentType, bodyValue);
    headers['content-type'] = binding.bodyContentType;
  }
  return request;
}

/**
 * Encodes one path value. Refuses empty, `.` and `..` values, which would change which resource
 * the URL names. Before -> after: `'a/b c'` -> `'a%2Fb%20c'`.
 */
function pathSegment(arg: string, value: unknown): string {
  const text = scalar(arg, value);
  if (text === '' || text === '.' || text === '..') {
    throw new ToolExecutionError(
      'blocked',
      `Refused path value for "${arg}": ${JSON.stringify(text)}.`,
    );
  }
  return encodeURIComponent(text);
}

/** Only strings, numbers and booleans fit in a path, query string or header. */
function scalar(arg: string, value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new ToolExecutionError(
    'invalid_arguments',
    `"${arg}" must be a string, number or boolean.`,
  );
}

/** Returns undefined for an empty object, so operations with no body fields send no body. */
function nonEmpty(fields: Args): Args | undefined {
  return Object.keys(fields).length === 0 ? undefined : fields;
}

/**
 * Serializes the body for its content type.
 * Before -> after: JSON `{ note: 'ok' }` -> `'{"note":"ok"}'`; form `{ a: 1, b: ['x', 'y'] }` -> `'a=1&b=x&b=y'`.
 */
function encodeBody(contentType: string, value: unknown): string {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base === 'application/json' || base.endsWith('+json')) return JSON.stringify(value);
  if (base === 'application/x-www-form-urlencoded' && isRecord(value)) {
    const form = new URLSearchParams();
    for (const [key, item] of Object.entries(value)) {
      for (const one of Array.isArray(item) ? item : [item]) form.append(key, scalar(key, one));
    }
    return form.toString();
  }
  throw new ToolExecutionError(
    'internal',
    `Request bodies of type ${contentType} are not supported yet.`,
  );
}

/** True for plain objects (not arrays or null). */
function isRecord(value: unknown): value is Args {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
