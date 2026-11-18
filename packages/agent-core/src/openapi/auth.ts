/**
 * Auth propagation for generated tools. Each operation lists the security it accepts (from the
 * spec); an AuthProvider supplies the secrets; applyAuth puts them where the scheme says.
 * The provider is a port: a fixed token from config, a caller's own token, a login flow, and
 * (Step 2.6) a tenant's stored credential are all just different providers.
 */
import type { SecurityRequirement, SecurityScheme } from '@toolbridge/spec-compiler';

import { ToolExecutionError } from '../tools/errors.js';
import type { SafeHttpClient } from './http-client.js';
import type { HttpRequest } from './request.js';

export interface AuthProvider {
  /**
   * The secret for one security scheme: a token, an API key, or "user:password" for basic auth.
   * Undefined means "I have nothing for this scheme", so another requirement may be tried.
   */
  secretFor(
    schemeName: string,
    scheme: SecurityScheme,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
  /** Forgets cached secrets after a 401. Returns true if fresh ones might work (then the call is retried once). */
  invalidate?(): boolean;
}

/**
 * Adds credentials to a request. `security` is a list of alternatives (OR); each alternative
 * names schemes that must all be satisfied (AND). The first alternative the provider can fully
 * satisfy is used. `[]` means the operation is public.
 * Before -> after: security `[{ bearer: [] }]` + token 'abc' -> header `authorization: Bearer abc`.
 */
export async function applyAuth(
  request: HttpRequest,
  security: SecurityRequirement[],
  schemes: Record<string, SecurityScheme>,
  auth: AuthProvider | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (security.length === 0) return;
  for (const requirement of security) {
    const names = Object.keys(requirement);
    if (names.length === 0) return; // `{}` in the list: anonymous access is allowed
    const secrets: [SecurityScheme, string, string][] = [];
    for (const name of names) {
      const scheme = schemes[name];
      const secret = scheme && auth ? await auth.secretFor(name, scheme, signal) : undefined;
      if (scheme === undefined || secret === undefined || !canApply(scheme)) break;
      secrets.push([scheme, name, secret]);
    }
    if (secrets.length === names.length) {
      for (const [scheme, , secret] of secrets) applyOne(request, scheme, secret);
      return;
    }
  }
  const wanted = security.map((r) => Object.keys(r).join(' + ')).join(' OR ');
  throw new ToolExecutionError(
    'internal',
    `No credentials configured for this API (needs ${wanted}).`,
  );
}

/** True for scheme types this module knows how to apply. */
function canApply(scheme: SecurityScheme): boolean {
  return ['http', 'apiKey', 'oauth2', 'openIdConnect'].includes(scheme.type);
}

/**
 * Puts one secret where its scheme says.
 * http bearer / oauth2 / openIdConnect -> `Authorization: Bearer <token>`; http basic ->
 * `Authorization: Basic base64(user:password)`; apiKey -> the named header, query param or cookie.
 */
function applyOne(request: HttpRequest, scheme: SecurityScheme, secret: string): void {
  if (scheme.type === 'apiKey') {
    const name = scheme.name ?? '';
    if (scheme.in === 'query') request.url.searchParams.set(name, secret);
    else if (scheme.in === 'cookie') {
      const existing = request.headers.cookie;
      request.headers.cookie = `${existing ? `${existing}; ` : ''}${name}=${secret}`;
    } else request.headers[name.toLowerCase()] = secret;
    return;
  }
  if (scheme.type === 'http' && scheme.scheme?.toLowerCase() === 'basic') {
    request.headers.authorization = `Basic ${Buffer.from(secret).toString('base64')}`;
    return;
  }
  request.headers.authorization = `Bearer ${secret}`;
}

/**
 * Fixed secrets by scheme name, for example `{ bearer: process.env.API_TOKEN }`. Also how a
 * caller's own token is passed through: the API then decides with the caller's permissions.
 */
export class StaticCredentials implements AuthProvider {
  /** Keeps the scheme-name -> secret map. */
  constructor(private readonly secrets: Record<string, string>) {}

  /** Returns the secret configured for this scheme name, if any. */
  secretFor(schemeName: string): Promise<string | undefined> {
    return Promise.resolve(this.secrets[schemeName]);
  }
}

export interface TokenLoginOptions {
  client: SafeHttpClient;
  /** Full login URL, for example http://127.0.0.1:3000/auth/login. */
  loginUrl: URL;
  /** JSON body sent to the login URL, for example { email, password }. */
  credentials: Record<string, string>;
  /** Field of the login response that holds the token, for example 'accessToken'. */
  tokenField: string;
  /** Scheme names this token is for. Default: any bearer-style scheme. */
  schemes?: string[];
}

/**
 * Logs in with a username and password, caches the token, and logs in again after a 401.
 * Phase 1's host login, made generic.
 */
export class TokenLogin implements AuthProvider {
  /** A promise, so parallel calls share one login instead of each logging in. */
  private token: Promise<string> | undefined;

  /** Stores the login settings; nothing is sent until a token is first needed. */
  constructor(private readonly options: TokenLoginOptions) {}

  /** Returns the cached token (logging in first) for bearer-style schemes it serves. */
  secretFor(
    schemeName: string,
    scheme: SecurityScheme,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const serves = this.options.schemes
      ? this.options.schemes.includes(schemeName)
      : scheme.type !== 'apiKey' && scheme.scheme?.toLowerCase() !== 'basic';
    if (!serves) return Promise.resolve(undefined);
    this.token ??= this.login(signal).catch((error: unknown) => {
      this.token = undefined; // a failed login is not cached
      throw error;
    });
    return this.token;
  }

  /** Drops the cached token so the next call logs in again. */
  invalidate(): boolean {
    this.token = undefined;
    return true;
  }

  /** POSTs the credentials and reads the token field from the JSON response. */
  private async login(signal?: AbortSignal): Promise<string> {
    const { client, loginUrl, credentials, tokenField } = this.options;
    const response = await client.send(
      {
        method: 'POST',
        url: new URL(loginUrl),
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(credentials),
      },
      signal,
    );
    if (response.status < 200 || response.status >= 300) {
      throw new ToolExecutionError(
        'http_error',
        `Login to ${loginUrl.origin} failed with HTTP ${String(response.status)}; check the configured credentials.`,
        {
          status: response.status,
        },
      );
    }
    const body = JSON.parse(response.text) as Record<string, unknown>;
    const token = body[tokenField];
    if (typeof token !== 'string') {
      throw new ToolExecutionError('internal', `Login response has no "${tokenField}" token.`);
    }
    return token;
  }
}
