/**
 * Turns HTTP responses into what the model sees: parsed data on success, or an error carrying
 * the API's own message (which is exactly what the model needs to correct itself).
 */
import { ToolExecutionError } from '../tools/errors.js';
import type { HttpResponse } from './http-client.js';

/** Parses a JSON body; falls back to the raw text for non-JSON responses, and null for an empty one. */
export function parseBody(response: HttpResponse): unknown {
  if (response.text === '') return null;
  try {
    return JSON.parse(response.text) as unknown;
  } catch {
    return response.text;
  }
}

/**
 * Builds the error for a 4xx/5xx response. 429 and 5xx may pass on a later try, so they are
 * retryable; other 4xx will not, EXCEPT a 409 that carries `Retry-After`: the API's way of
 * saying "the same request is still being processed, ask again" (an idempotency key in use,
 * Step 4.5), unlike a business conflict such as "only 100 cents left to refund".
 * Before -> after: 409 `{ message: 'Order is not shipped' }` ->
 * `http_error 409: "POST /refunds failed with HTTP 409: Order is not shipped"`.
 */
export function responseError(response: HttpResponse, label: string): ToolExecutionError {
  const { status } = response;
  return new ToolExecutionError(
    'http_error',
    `${label} failed with HTTP ${String(status)}: ${apiMessage(parseBody(response))}`,
    {
      status,
      retryable:
        status === 429 ||
        status >= 500 ||
        (status === 409 && response.headers['retry-after'] !== undefined),
    },
  );
}

/**
 * Finds the human-readable message in common error shapes:
 * NestJS `{ message: string | string[] }`, `{ error: string | { message } }`, and RFC 7807
 * problem details `{ title, detail }`. Falls back to the start of the raw text.
 */
function apiMessage(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, 300) || 'no error message';
  if (typeof body !== 'object' || body === null) return 'no error message';
  const record = body as Record<string, unknown>;
  const { message, error, detail, title } = record;
  if (Array.isArray(message)) return message.map(String).join('; ');
  if (typeof message === 'string') return message;
  if (typeof detail === 'string') return typeof title === 'string' ? `${title}: ${detail}` : detail;
  if (typeof error === 'string') return error;
  if (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as Record<string, unknown>).message === 'string'
  ) {
    return (error as Record<string, string>).message ?? 'no error message';
  }
  if (typeof title === 'string') return title;
  return JSON.stringify(body).slice(0, 300);
}
