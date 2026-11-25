/**
 * POST /api/toolbridge/session: the chat widget asks the host's own server for a ToolBridge session
 * (Step 7.0). Only `{ token, expiresAt }` goes back: the API key and the host token never reach the
 * browser. The exchange itself is in lib/toolbridge.ts.
 */
import { mintSession, ToolBridgeError } from '../../../../lib/toolbridge';

export async function POST(request: Request): Promise<Response> {
  // Same-origin calls only: another site cannot make a signed-in user's browser mint a token.
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== new URL(request.url).origin) {
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
