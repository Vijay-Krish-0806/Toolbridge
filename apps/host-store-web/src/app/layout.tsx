import './globals.css';

import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { ChatPanel } from '../components/chat-panel';
import { NavLinks } from '../components/nav-links';
import { signOut } from '../lib/actions';
import { currentStaff } from '../lib/host';

export const metadata: Metadata = { title: 'Host Store' };

/**
 * Every page: a sidebar with the signed-in staff member, the page, and the assistant. Signed out,
 * only the page. The ToolBridge API address is public; the API key never leaves the server.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const staff = await currentStaff();
  const apiBase = process.env.TOOLBRIDGE_API_URL ?? '';
  return (
    <html lang="en">
      <body className="bg-slate-100 text-slate-900 antialiased">
        {staff ? (
          <div className="lg:grid lg:h-screen lg:grid-cols-[190px_1fr_360px]">
            <aside className="flex flex-wrap items-center justify-between gap-3 border-slate-200 bg-white p-4 lg:flex-col lg:flex-nowrap lg:items-stretch lg:border-r">
              <div className="flex flex-wrap items-center gap-4 lg:flex-col lg:items-stretch">
                <Link href="/orders" className="flex items-center gap-2 px-1 font-semibold">
                  <span className="size-5 rounded-md bg-teal-700" aria-hidden />
                  Host Store
                </Link>
                <NavLinks />
              </div>
              <form
                action={signOut}
                className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 text-sm lg:block lg:space-y-2"
              >
                <div>
                  <p className="font-medium">{staff.name}</p>
                  <p className="text-xs text-slate-500 capitalize">{staff.role}</p>
                </div>
                <button className="text-xs text-teal-800 hover:underline">Sign out</button>
              </form>
            </aside>
            <main className="p-4 lg:overflow-y-auto lg:p-6">{children}</main>
            {apiBase && (
              <aside className="h-[520px] border-slate-200 bg-white lg:h-screen lg:border-l">
                <ChatPanel apiBase={apiBase} person={`${staff.name}, ${staff.role}`} />
              </aside>
            )}
          </div>
        ) : (
          <main className="p-4">{children}</main>
        )}
      </body>
    </html>
  );
}
