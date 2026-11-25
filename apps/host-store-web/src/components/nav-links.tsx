'use client';
/** The sidebar links. A Client Component only because the active page is known in the browser. */
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/orders', label: 'Orders' },
  { href: '/approvals', label: 'Approvals' },
];

export function NavLinks() {
  const path = usePathname();
  return (
    <nav className="flex gap-1 lg:flex-col">
      {LINKS.map(({ href, label }) => {
        const active = path.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            prefetch={false}
            aria-current={active ? 'page' : undefined}
            className={`rounded-lg px-3 py-2 text-sm ${active ? 'bg-teal-50 font-medium text-teal-800' : 'hover:bg-slate-100'}`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
