/**
 * What a HOST's backend does to give its signed-in user a chat (Step 7.0): it already holds the
 * user's own host token (from its login), and asks ToolBridge for a session with its tenant API
 * key. Only `{ token, expiresAt }` goes back to the browser; the key and the host token never do.
 * Shared by the demo server and the live check.
 */
import type { SessionToken } from '../client.js';

/** Logs a seeded staff user into the host API and returns their host token and role. */
export async function hostLogin(user: 'owner' | 'support' | 'warehouse'): Promise<{
  email: string;
  role: string;
  hostToken: string;
}> {
  const email = `${user}@store.example`;
  const response = await fetch(
    `${process.env.HOST_API_URL ?? 'http://127.0.0.1:3000'}/auth/login`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: process.env.SEED_STAFF_PASSWORD }),
    },
  );
  if (!response.ok) throw new Error(`host login failed: ${String(response.status)}`);
  const body = (await response.json()) as { accessToken: string };
  return { email, role: user, hostToken: body.accessToken };
}

/** Mints a ToolBridge session for the user, passing their host token (delegated mode). */
export async function mintSession(user: {
  email: string;
  role: string;
  hostToken: string;
}): Promise<SessionToken> {
  const response = await fetch(`${process.env.TOOLBRIDGE_API_URL ?? ''}/sessions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.TOOLBRIDGE_API_KEY ?? ''}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      specId: process.env.TOOLBRIDGE_SPEC_ID,
      userId: user.email,
      role: user.role,
      userToken: user.hostToken,
    }),
  });
  if (!response.ok)
    throw new Error(`session refused: ${String(response.status)} ${await response.text()}`);
  return (await response.json()) as SessionToken;
}
