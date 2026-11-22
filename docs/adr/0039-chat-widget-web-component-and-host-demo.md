# ADR-0039: The chat widget as a Web Component, and the host demo app

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

Step 7.0 (with U1b) puts the assistant where ADR 0027 said it belongs: inside the host's own app. It needs a drop-in client of the run API (the widget) and a real host to mount it in (`apps/host-store-web`), whose server mints session tokens with the tenant API key while the key never reaches the browser. The build plan's frontend stack is Next.js and Tailwind; the UI is not the learning focus.

Checked before building (2026-11-22): Next.js 16 upgrade guide and API pages: `cookies()` and `params` are async, middleware is now `proxy`, `next lint` is removed, Turbopack is the default, and workspace packages are transpiled automatically (no `transpilePackages`). Versions pinned at least two weeks old: next 16.4.5, react 19.3.1, tailwindcss 4.3.5.

## Decision

**The widget is a framework-free custom element, `<toolbridge-chat>`, with a DOM-free run client. The demo host is a small Next.js app whose server route performs the token exchange.**

- **Widget (`packages/chat-widget`):** a custom element with Shadow DOM, styled through CSS variables, rendering only with `textContent`. It imports the event schema as types only, so the compiled files have no runtime dependencies and load in a browser without a bundler. The host gives it `api-base` and a `getToken()` callback that calls the HOST's server.
- **Run client (`RunClient`):** fetch-based (Node and browser): session token in `Authorization`, never in a URL; on a dropped stream it reconnects with `Last-Event-ID` (backoff 1, 2, 4, then 10 s), so no event is lost or repeated; it asks for a new token 60 s before expiry and after a 401. The widget remembers a run in progress (localStorage), so reopening the page resumes it.
- **Host app (`apps/host-store-web`):** sign-in through the host API's own login (the host token goes into an httpOnly, SameSite=Lax cookie); orders list, order page and refund button call the host API as that user, so the host applies its own roles. `POST /api/toolbridge/session` reads the cookie, gets the user's email and role from the host's `/auth/me`, and calls ToolBridge `POST /sessions` with the tenant key from server-side environment variables, passing the host token (delegated mode). It returns only `{ token, expiresAt }`, refuses another site's origin (403) and signed-out callers (401). The widget is created with `document.createElement`, so React needs no custom-element typing.
- **Setup:** `pnpm demo:setup` prepares the demo tenant through the platform API (spec, connection, policy, delegated mode, origins `localhost:3001` and `127.0.0.1:3001`) and writes the key to git-ignored `.env.local` files without printing it; reruns reuse the tenant.
- **Key-leak check:** `check:keys` reads the key and searches every browser-facing build file (`.next/static` and prerendered pages); it fails on a find.
- **Not added:** shadcn/ui and SWR from the plan's stack. Every page is a Server Component reading on the server, so there is no client data fetching to cache, and plain Tailwind is enough for four screens.

## Alternatives considered

- **A React component library for the widget.** Natural in a Next.js host. Not chosen: hosts on Vue, Angular or plain HTML could not use it, and the host's CSS would leak in. A custom element works everywhere, and React apps mount it in a few lines.
- **An iframe widget served by ToolBridge.** Strongest isolation. Not chosen: the token would have to cross origins with postMessage, and resizing and theming get harder; Shadow DOM plus the server-side token exchange already keeps keys out of the page.
- **EventSource for the stream.** Not possible: it cannot send an `Authorization` header, and ADR 0027 forbids tokens in URLs.
- **The tenant key as a `NEXT_PUBLIC_` variable.** Would ship the key to every browser; the check exists so this mistake fails loudly.

## Consequences

- **Positive (live, 2026-11-22):** the real client, getting tokens from the app's own route, completed a run in delegated mode; a dropped stream reconnected with no gaps or repeats; signed-out `/` redirects to `/login`; pages show orders read as warehouse and support; the session route returns only token and expiry with the role from the host, refuses another site (403) and signed-out callers (401); the key appears in no page, widget file or response, and `check:keys` finds it in none of 18 browser-facing build files.
- **Negative:** no automated browser test (the rendered widget and the refund button's Server Action are checked by hand); each chat message is a new run (no conversation memory until Step 4.7); approvals still need the API or the console inbox (U3).
- **Follow-ups:** U1a and U3 can reuse `RunClient`; Step 7.3 records the demo on this app.
