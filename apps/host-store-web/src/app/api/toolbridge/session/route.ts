/**
 * POST /api/toolbridge/session: the chat widget asks the host's own server for a ToolBridge session
 * (Step 7.0). Only `{ token, expiresAt }` goes back: the API key and the host token never reach the
 * browser. The exchange itself is in lib/toolbridge.ts.
 */
import { mintSession, ToolBridgeError } from '../../../../lib/toolbridge';

export async function POST(request: Request): Promise<Response> {
  // Same-origin calls only: another site cannot make a signed-in user's browser mint a token.
  if (!isSameOrigin(request)) {
    return Response.json({ message: 'Cross-site request refused.' }, { status: 403 });
  }
  try {
    return Response.json(await mintSession(), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (!(error instanceof ToolBridgeError)) throw error;
    // 401 and 503 are ours. What ToolBridge itself answered is not passed on.
    if (error.status === 401 || error.status === 503) {
      return Response.json({ message: error.message }, { status: error.status });
    }
    return Response.json({ message: 'The assistant is unavailable.' }, { status: 502 });
  }
}

/**
 * True when the request comes from one of our own pages, or not from a page at all. The browser
 * sets both headers itself, so another site cannot fake them. Compared with `Host` (as Next.js does
 * for Server Actions), not with `request.url`: Next may fill in another host name there, which
 * refused our own pages opened at 127.0.0.1.
 * Before -> after: Origin http://127.0.0.1:3001 and Host 127.0.0.1:3001 -> true.
 */
function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  return URL.canParse(origin) && new URL(origin).host === request.headers.get('host');
}
