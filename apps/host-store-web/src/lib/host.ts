/**
 * The host store's own backend calls (Step 7.0). These run on the SERVER only (Server Components,
 * Server Functions, Route Handlers): the user's host token lives in an httpOnly cookie that page
 * JavaScript cannot read, and every host API call is made as that user, so the host API applies
 * its own roles (owner, support, warehouse) to them.
 */
import { cookies } from 'next/headers';

const HOST_API = process.env.HOST_API_URL ?? 'http://127.0.0.1:3000';
/** The cookie that holds the signed-in user's host token. */
export const SESSION_COOKIE = 'hs_session';

export interface Staff {
  _id: string;
  name: string;
  email: string;
  role: 'owner' | 'support' | 'warehouse';
}

export interface Order {
  _id: string;
  number: string;
  status: string;
  items: { name: string; quantity: number; unitPriceCents: number }[];
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  placedAt: string;
}

/** The statuses the host knows, for the filter. */
export const ORDER_STATUSES = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'] as const;

/** A refusal from the host API, with its status and message (403 for a role, 404, 422...). */
export class HostError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HostError';
  }
}

/** The signed-in user's host token, or undefined. */
export async function hostToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

/** Calls the host API as the signed-in user. */
export async function hostFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await hostToken();
  const response = await fetch(`${HOST_API}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
      ...(token && { authorization: `Bearer ${token}` }),
    },
  });
  const body = (await response.json().catch(() => ({}))) as { message?: unknown };
  if (!response.ok) {
    const message = typeof body.message === 'string' ? body.message : response.statusText;
    throw new HostError(response.status, message);
  }
  return body as T;
}

/** Signs in to the host API; returns the token and how long it lives. */
export async function hostLogin(
  email: string,
  password: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  return hostFetch('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
}

/** The signed-in staff member, or null when nobody is signed in (or the token expired). */
export async function currentStaff(): Promise<Staff | null> {
  if (!(await hostToken())) return null;
  try {
    return await hostFetch<Staff>('/auth/me');
  } catch {
    return null;
  }
}

/** Formats cents as dollars: 32893 -> "$328.93". */
export function money(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}
