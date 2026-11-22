/**
 * POST /api/toolbridge/session: THE token exchange (Step 7.0, ADRs 0027, 0036). The chat widget
 * calls this on the host's own server; the server, holding the tenant API key in its environment,
 * asks ToolBridge for a short-lived session for the signed-in user, passing the user's own host
 * token (delegated mode). Only `{ token, expiresAt }` goes back: the API key and the host token
 * never reach the browser, and the role comes from the host's own `/auth/me`, never from the page.
 */
import { currentStaff, hostToken } from '../../../../lib/host';

export async function POST(request: Request): Promise<Response> {
  // Same-origin calls only: another site cannot make a signed-in user's browser mint a token.
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== new URL(request.url).origin) {
    return Response.json({ message: 'Cross-site request refused.' }, { status: 403 });
  }
  const userToken = await hostToken();
  const staff = await currentStaff();
  if (!userToken || !staff) return Response.json({ message: 'Sign in first.' }, { status: 401 });

  const { TOOLBRIDGE_API_URL, TOOLBRIDGE_API_KEY, TOOLBRIDGE_SPEC_ID } = process.env;
  if (!TOOLBRIDGE_API_URL || !TOOLBRIDGE_API_KEY || !TOOLBRIDGE_SPEC_ID) {
    return Response.json(
      { message: 'The assistant is not set up (run pnpm demo:setup).' },
      { status: 503 },
    );
  }
  const response = await fetch(`${TOOLBRIDGE_API_URL}/sessions`, {
    method: 'POST',
    cache: 'no-store',
    headers: { authorization: `Bearer ${TOOLBRIDGE_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      specId: TOOLBRIDGE_SPEC_ID,
      userId: staff.email,
      role: staff.role,
      userToken,
    }),
  });
  if (!response.ok) {
    return Response.json({ message: 'The assistant is unavailable.' }, { status: 502 });
  }
  const { token, expiresAt } = (await response.json()) as { token: string; expiresAt: string };
  return Response.json({ token, expiresAt }, { headers: { 'cache-control': 'no-store' } });
}
