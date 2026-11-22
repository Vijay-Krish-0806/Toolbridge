import './globals.css';

import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { ChatPanel } from '../components/chat-panel';
import { signOut } from '../lib/actions';
import { currentStaff } from '../lib/host';

export const metadata: Metadata = { title: 'Host Store' };

/**
 * Every page: a header with the signed-in staff member and, when signed in, the assistant in a
 * side column. The ToolBridge API address is public; the API key never leaves the server.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const staff = await currentStaff();
  const apiBase = process.env.TOOLBRIDGE_API_URL ?? '';
  return (
    <html lang="en">
      <body className="bg-slate-50 text-slate-900 antialiased">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
            <Link href="/orders" className="font-semibold">
              Host Store
            </Link>
            {staff && (
              <form action={signOut} className="flex items-center gap-3 text-sm">
                <span>
                  {staff.name} <span className="text-slate-500">({staff.role})</span>
                </span>
                <button className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100">
                  Sign out
                </button>
              </form>
            )}
          </div>
        </header>
        <div className="mx-auto grid max-w-6xl gap-6 px-4 py-6 lg:grid-cols-[1fr_380px]">
          <main>{children}</main>
          {staff && apiBase && (
            <aside>
              <ChatPanel apiBase={apiBase} />
            </aside>
          )}
        </div>
      </body>
    </html>
  );
}
