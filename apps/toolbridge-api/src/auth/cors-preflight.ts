import type { IncomingMessage, ServerResponse } from 'node:http';

import type { TenantsService } from '../tenants/tenants.service.js';
import { normalizeOrigin, preflightHeaders } from './origins.js';

/**
 * Answers CORS PREFLIGHT requests (Step 4.4b). Before a cross-origin request with an
 * `Authorization` header, a browser first sends `OPTIONS` with `Access-Control-Request-Method`
 * and asks "may this page send that?". The preflight carries no token, so the tenant is not
 * known yet: it is allowed when ANY tenant lists the origin. That is only the first gate; the
 * real request is then checked against the token's own tenant (PlatformAuthGuard).
 * An unknown origin gets 403 with no CORS headers, so the browser stops there.
 */
export function corsPreflight(tenants: TenantsService) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const origin = req.headers.origin;
    const isPreflight =
      req.method === 'OPTIONS' &&
      origin !== undefined &&
      'access-control-request-method' in req.headers;
    if (!isPreflight) {
      next();
      return;
    }
    const allowed = normalizeOrigin(origin);
    void (allowed ? tenants.anyTenantAllows(allowed) : Promise.resolve(false))
      .then((ok) => {
        if (ok && allowed) res.writeHead(204, preflightHeaders(allowed)).end();
        else res.writeHead(403).end();
      })
      .catch(() => res.writeHead(500).end());
  };
}
