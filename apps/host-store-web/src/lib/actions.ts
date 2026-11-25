'use server';
/**
 * Server Functions for the forms (Step 7.0). They run on the server; the browser only posts the
 * form. Sign-in stores the host token in an httpOnly cookie (never readable by page scripts).
 */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { currentStaff, HostError, hostFetch, hostLogin, SESSION_COOKIE } from './host';
import { decide, ToolBridgeError } from './toolbridge';

const formText = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

/** Signs in with the host's own login, then goes to the orders. */
export async function signIn(form: FormData): Promise<void> {
  let session: { accessToken: string; expiresIn: number };
  try {
    session = await hostLogin(formText(form, 'email'), formText(form, 'password'));
  } catch {
    redirect('/login?error=1');
  }
  (await cookies()).set({
    name: SESSION_COOKIE,
    value: session.accessToken,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: session.expiresIn,
  });
  redirect('/orders');
}

export async function signOut(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/login');
}

/**
 * The refund button: requests a refund AS THE SIGNED-IN USER. The host decides (a warehouse user
 * gets its 403); the message is shown on the order page.
 */
export async function requestRefund(form: FormData): Promise<void> {
  const number = formText(form, 'number');
  let result: string;
  try {
    await hostFetch('/refunds', {
      method: 'POST',
      body: JSON.stringify({
        orderId: formText(form, 'orderId'),
        amountCents: Number(formText(form, 'amountCents')),
        reason: formText(form, 'reason'),
      }),
    });
    result = 'ok';
  } catch (error) {
    result = error instanceof HostError ? `${String(error.status)} ${error.message}` : 'failed';
  }
  redirect(`/orders/${encodeURIComponent(number)}?refund=${encodeURIComponent(result)}`);
}

/** What the approvals page shows for each refusal ToolBridge can give. */
const REFUSALS: Partial<Record<number, string>> = { 403: 'forbidden', 404: 'gone', 409: 'decided' };

/**
 * The approve and reject buttons (U3): decides a card AS THE SIGNED-IN USER. A Server Function can
 * be called directly, not only from our page, so it checks the sign-in and its input itself.
 * ToolBridge makes the real decision: who may approve, and that a card is decided only once.
 * Before -> after: approve on an open card -> /approvals?result=approved; a second click ->
 * /approvals?result=decided.
 */
export async function decideApproval(form: FormData): Promise<void> {
  if (!(await currentStaff())) redirect('/login');
  const approvalId = formText(form, 'approvalId');
  const decision = formText(form, 'decision');
  let result = 'failed';
  // The id becomes part of a URL, so only a real id may pass.
  if (/^[0-9a-f]{24}$/.test(approvalId) && (decision === 'approve' || decision === 'reject')) {
    try {
      await decide(approvalId, decision, formText(form, 'reason').trim().slice(0, 1000));
      result = decision === 'approve' ? 'approved' : 'rejected';
    } catch (error) {
      if (!(error instanceof ToolBridgeError)) throw error;
      result = REFUSALS[error.status] ?? 'failed';
    }
  }
  redirect(`/approvals?result=${result}`);
}
