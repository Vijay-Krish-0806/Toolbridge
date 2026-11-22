/**
 * Browser origins (Step 4.4b). An origin is scheme + host + port, for example
 * `https://shop.example` or `http://localhost:5173`: what a browser puts in the `Origin` header.
 */

/** The longest list one tenant may configure. */
export const MAX_ORIGINS = 20;

/**
 * The canonical form of an origin, or null when `value` is not a bare http(s) origin.
 * Before -> after: 'https://Shop.Example' -> 'https://shop.example';
 * 'https://shop.example/app' -> null (a path); '*' -> null; 'ftp://x' -> null.
 */
export function normalizeOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // Only the origin itself: no path (not even a trailing "/"), query, fragment or credentials.
  // (The URL parser reports "/" as the path of a bare origin, so the typed text is checked too.)
  const extra = url.pathname !== '/' || url.search || url.hash || url.username || url.password;
  if (extra || value.endsWith('/')) return null;
  return url.origin;
}

/** Methods and request headers a browser may use on the run API. */
const ALLOWED_METHODS = 'GET, POST, DELETE';
const ALLOWED_HEADERS = 'authorization, content-type, last-event-id';

/**
 * The CORS response headers for an allowed origin. The origin is echoed (never `*`), `Vary:
 * Origin` tells caches the answer depends on it, and there is no Allow-Credentials: we use a
 * bearer header, not cookies.
 */
export function corsHeaders(origin: string): Record<string, string> {
  return { 'access-control-allow-origin': origin, vary: 'Origin' };
}

/** The extra headers of a successful preflight answer. */
export function preflightHeaders(origin: string): Record<string, string> {
  return {
    ...corsHeaders(origin),
    'access-control-allow-methods': ALLOWED_METHODS,
    'access-control-allow-headers': ALLOWED_HEADERS,
    'access-control-max-age': '600',
  };
}
