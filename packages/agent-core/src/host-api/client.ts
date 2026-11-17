import { ToolExecutionError } from '../tools/errors.js';

export interface HostApiOptions {
  baseUrl: string;
  email: string;
  password: string;
}

type QueryValue = string | number | boolean | undefined;

interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * A small HTTP client for the host store API, built on Node's built-in fetch.
 * It logs in as one staff member, keeps the JWT, and turns every failure into a
 * ToolExecutionError that says whether a retry could help.
 */
export class HostApiClient {
  /** A promise, not a string, so parallel calls share one login instead of each logging in. */
  private token: Promise<string> | undefined;

  /** Stores the connection details; nothing is sent until the first request. */
  constructor(private readonly options: HostApiOptions) {}

  /** GET `path` with optional query parameters (undefined values are left out). */
  get(path: string, query?: Record<string, QueryValue>, signal?: AbortSignal): Promise<unknown> {
    return this.request('GET', path, { ...(query && { query }), ...(signal && { signal }) });
  }

  /** POST `body` as JSON to `path`. */
  post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.request('POST', path, { body, ...(signal && { signal }) });
  }

  /**
   * Sends an authenticated request. If the token has expired (401), it logs in again once and
   * repeats the request. A 401 from a fresh token is a real error, so it is not retried again.
   */
  private async request(
    method: string,
    path: string,
    options: RequestOptions,
    isRetry = false,
  ): Promise<unknown> {
    const token = await this.getToken(options.signal);
    const response = await this.send(method, path, options, token);
    if (response.status === 401 && !isRetry) {
      this.token = undefined;
      return this.request(method, path, options, true);
    }
    return readJson(response, `${method} ${path}`);
  }

  /** Returns the cached token, logging in first if there is none. A failed login is not cached. */
  private getToken(signal?: AbortSignal): Promise<string> {
    this.token ??= this.login(signal).catch((error: unknown) => {
      this.token = undefined;
      throw error;
    });
    return this.token;
  }

  /** Exchanges email and password for a JWT via POST /auth/login. */
  private async login(signal?: AbortSignal): Promise<string> {
    const { email, password } = this.options;
    const response = await this.send('POST', '/auth/login', {
      body: { email, password },
      ...(signal && { signal }),
    });
    if (response.status === 401) {
      throw new ToolExecutionError(
        'http_error',
        'Host API login failed: check HOST_API_EMAIL and HOST_API_PASSWORD',
        {
          status: 401,
        },
      );
    }
    const body = (await readJson(response, 'POST /auth/login')) as { accessToken?: unknown };
    if (typeof body.accessToken !== 'string') {
      throw new ToolExecutionError('internal', 'Host API login returned no access token');
    }
    return body.accessToken;
  }

  /**
   * Makes the actual fetch call. A fetch that fails before any response (server down, DNS) is a
   * retryable network error. An abort from the executor's timeout is re-thrown unchanged.
   */
  private async send(
    method: string,
    path: string,
    options: RequestOptions,
    token?: string,
  ): Promise<Response> {
    const url = new URL(path, this.options.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    try {
      return await fetch(url, {
        method,
        headers: {
          ...(options.body !== undefined && { 'Content-Type': 'application/json' }),
          ...(token && { Authorization: `Bearer ${token}` }),
        },
        ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
        ...(options.signal && { signal: options.signal }),
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const cause =
        error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
      throw new ToolExecutionError(
        'network',
        `Could not reach the host API at ${url.origin}${cause}`,
        {
          retryable: true,
        },
      );
    }
  }
}

/**
 * Returns the parsed JSON body of a successful response. For an error status it throws a
 * ToolExecutionError carrying the API's own message, because that message (for example
 * "amount exceeds what is left to refund") is exactly what the model needs to correct itself.
 */
async function readJson(response: Response, label: string): Promise<unknown> {
  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : null;
  if (response.ok) return body;

  const status = response.status;
  throw new ToolExecutionError(
    'http_error',
    `${label} failed with HTTP ${String(status)}: ${apiMessage(body)}`,
    {
      status,
      // 429 (rate limited) and 5xx (server trouble) may pass on a later try. Other 4xx will not.
      retryable: status === 429 || status >= 500,
    },
  );
}

/** Pulls the human-readable message out of a NestJS error body: { statusCode, message, error }. */
function apiMessage(body: unknown): string {
  if (body && typeof body === 'object' && 'message' in body) {
    const { message } = body;
    if (Array.isArray(message)) return message.join('; ');
    if (typeof message === 'string') return message;
  }
  return 'no error message';
}
