'use server';
/**
 * Server Functions for the forms (Step 7.0). They run on the server; the browser only posts the
 * form. Sign-in stores the host token in an httpOnly cookie (never readable by page scripts).
 */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { HostError, hostFetch, hostLogin, SESSION_COOKIE } from './host';

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
