/**
 * The store's server calling ToolBridge (Step 7.0 and U3). SERVER ONLY: the tenant API key is read
 * here and never sent to the browser.
 */
import { currentStaff, hostToken } from './host';

/** One call of a paused turn, with the exact arguments the model wrote. */
export interface ApprovalCall {
  id: string;
  name: string;
  arguments: string;
  level: 'none' | 'required' | 'high';
  reason: string;
}

/** An approval card, as ToolBridge's GET /approvals returns it. */
export interface ApprovalCard {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  level: 'required' | 'high';
  requesterId: string;
  approverId: string | null;
  reason: string | null;
  decidedAt: string | null;
  calls: ApprovalCall[];
  exposure: 'none' | 'seen' | 'flagged' | null;
  createdAt: string;
}

/** A refusal (from us or from ToolBridge) with its status and a message safe to show. */
export class ToolBridgeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ToolBridgeError';
  }
}

/**
 * THE token exchange (ADRs 0027, 0036): a short-lived ToolBridge session for the signed-in staff
 * member. The role comes from the host's own `/auth/me`, never from the page, and the user's own
 * host token goes along, so what ToolBridge does for them runs with their rights (delegated mode).
 */
export async function mintSession(): Promise<{ token: string; expiresAt: string }> {
  const userToken = await hostToken();
  const staff = await currentStaff();
  if (!userToken || !staff) throw new ToolBridgeError(401, 'Sign in first.');

  const { TOOLBRIDGE_API_URL, TOOLBRIDGE_API_KEY, TOOLBRIDGE_SPEC_ID } = process.env;
  if (!TOOLBRIDGE_API_URL || !TOOLBRIDGE_API_KEY || !TOOLBRIDGE_SPEC_ID) {
    throw new ToolBridgeError(503, 'The assistant is not set up (run pnpm demo:setup).');
  }
  const { token, expiresAt } = await send<{ token: string; expiresAt: string }>(
    `${TOOLBRIDGE_API_URL}/sessions`,
    TOOLBRIDGE_API_KEY,
    { specId: TOOLBRIDGE_SPEC_ID, userId: staff.email, role: staff.role, userToken },
  );
  return { token, expiresAt };
}

/** The approval cards of one status that the signed-in staff member may see, oldest first. */
export async function listApprovals(
  status: 'pending' | 'approved' | 'rejected',
): Promise<ApprovalCard[]> {
  const { token } = await mintSession();
  return send(`${process.env.TOOLBRIDGE_API_URL ?? ''}/approvals?status=${status}`, token);
}

/**
 * Decides one card as the signed-in staff member. In delegated mode an approved write then runs
 * with THEIR host token, taken from the session minted here.
 */
export async function decide(
  approvalId: string,
  decision: 'approve' | 'reject',
  reason: string,
): Promise<void> {
  const { token } = await mintSession();
  await send(
    `${process.env.TOOLBRIDGE_API_URL ?? ''}/approvals/${approvalId}/${decision}`,
    token,
    reason === '' ? {} : { reason },
  );
}

/** GET (no body) or POST (with a body) with a bearer credential; throws ToolBridgeError. */
async function send<T>(url: string, bearer: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ToolBridgeError(502, 'The assistant is unavailable.');
  }
  if (!response.ok) throw new ToolBridgeError(response.status, 'ToolBridge refused the request.');
  return (await response.json()) as T;
}
