'use client';
/**
 * Mounts the ToolBridge chat widget (U1b) on the page (Step 7.0). The widget is a custom element
 * loaded only in the browser; it gets its token from our own server route, never a key.
 * It is created with document.createElement, so no JSX typing is needed for the custom element.
 */
import { useEffect, useRef } from 'react';

type ChatElement = HTMLElement & {
  getToken?: () => Promise<{ token: string; expiresAt: string }>;
};

/** Asks our own server for a ToolBridge session for the signed-in user. */
async function getToken(): Promise<{ token: string; expiresAt: string }> {
  const response = await fetch('/api/toolbridge/session', { method: 'POST' });
  const body = (await response.json()) as { token: string; expiresAt: string; message?: string };
  if (!response.ok) throw new Error(body.message ?? 'No session.');
  return body;
}

/** `person` is shown under the heading, so it is clear whose rights the assistant has. */
export function ChatPanel({ apiBase, person }: { apiBase: string; person: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let chat: ChatElement | undefined;
    let cancelled = false;
    void import('@toolbridge/chat-widget').then(() => {
      if (cancelled) return;
      chat = document.createElement('toolbridge-chat');
      chat.setAttribute('api-base', apiBase);
      chat.setAttribute('heading', 'Assistant');
      chat.setAttribute('subheading', `Acting as ${person}`);
      chat.getToken = getToken;
      container.append(chat);
    });
    return () => {
      cancelled = true;
      chat?.remove();
    };
  }, [apiBase, person]);

  return <div ref={host} className="h-full" />;
}
