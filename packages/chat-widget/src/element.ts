/**
 * `<toolbridge-chat>`: the drop-in chat for a host app (Step 7.0, U1b), as a WEB COMPONENT.
 *
 * Why a custom element: it works in any page (React, Vue, plain HTML) with one script tag, and
 * its SHADOW DOM keeps the host's CSS out and ours in. The host gives it two things:
 *   <toolbridge-chat api-base="http://127.0.0.1:4000"></toolbridge-chat>
 *   element.getToken = () => fetch('/api/toolbridge/session', { method: 'POST' }).then(r => r.json());
 * `getToken` calls the HOST's own server, which holds the tenant API key and mints a session for
 * the signed-in user. The widget never sees a key, and puts no token in a URL.
 *
 * Safety: everything from the model or the API is shown with `textContent`, never as HTML, so
 * text in an answer or a tool argument cannot inject markup or scripts into the page.
 * A run in progress is remembered in localStorage, so reopening the tab picks it up again.
 */
import type { RunEvent } from '@toolbridge/run-events';

import { type GetToken, RunApiError, RunClient } from './client.js';

const STYLE = `
  :host { display: block; font: 14px/1.45 system-ui, sans-serif; color: var(--tb-text, #1d1d1f); }
  .box { display: flex; flex-direction: column; height: var(--tb-height, 480px); border: 1px solid var(--tb-border, #d8d8dc); border-radius: 10px; background: var(--tb-bg, #fff); overflow: hidden; }
  header { padding: 10px 14px; font-weight: 600; border-bottom: 1px solid var(--tb-border, #d8d8dc); }
  .log { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
  .msg { padding: 8px 11px; border-radius: 10px; max-width: 85%; white-space: pre-wrap; overflow-wrap: anywhere; }
  .user { align-self: flex-end; background: var(--tb-accent, #2457d6); color: #fff; }
  .assistant { align-self: flex-start; background: var(--tb-muted, #f1f2f4); }
  .card { align-self: stretch; border: 1px solid var(--tb-border, #d8d8dc); border-radius: 8px; padding: 6px 10px; font-size: 13px; }
  .card summary { cursor: pointer; }
  .card pre { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
  .approval { border-color: #d39b2a; background: #fff8e8; }
  .note { align-self: center; font-size: 12px; color: #6e6e73; }
  .error { color: #b3261e; }
  form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid var(--tb-border, #d8d8dc); }
  input { flex: 1; padding: 8px 10px; font: inherit; border: 1px solid var(--tb-border, #d8d8dc); border-radius: 8px; }
  button { padding: 8px 14px; font: inherit; border: 0; border-radius: 8px; background: var(--tb-accent, #2457d6); color: #fff; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
`;

/** What is remembered while a run is in progress (per API base, in localStorage). */
interface SavedRun {
  runId: string;
  lastSeq: number;
}

export class ToolbridgeChat extends HTMLElement {
  static readonly observedAttributes = ['api-base', 'heading'];

  /** Set by the host page: fetches a session token from the host's own server. */
  getToken: GetToken | undefined;

  private readonly root: ShadowRoot;
  private readonly log: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly button: HTMLButtonElement;
  private readonly headingEl: HTMLElement;
  private answer: HTMLElement | undefined;
  private readonly cards = new Map<string, HTMLElement>();
  private stop: AbortController | undefined;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    const box = el('div', 'box');
    this.headingEl = el('header');
    this.log = el('div', 'log');
    const form = document.createElement('form');
    this.input = document.createElement('input');
    this.input.placeholder = 'Ask about orders, refunds, shipments...';
    this.input.setAttribute('aria-label', 'Message');
    this.button = document.createElement('button');
    this.button.textContent = 'Send';
    form.append(this.input, this.button);
    box.append(this.headingEl, this.log, form);
    this.root.append(style, box);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.send(this.input.value.trim());
    });
  }

  connectedCallback(): void {
    this.headingEl.textContent = this.getAttribute('heading') ?? 'Assistant';
    // Wait a tick so the host page can set getToken right after creating the element.
    queueMicrotask(() => {
      const saved = this.loadRun();
      if (saved) void this.resume(saved);
    });
  }

  disconnectedCallback(): void {
    this.stop?.abort(); // stops following; the run itself continues on the server
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    if (name === 'heading') this.headingEl.textContent = value ?? 'Assistant';
  }

  /** Sends a message as a new run and follows it. */
  private async send(message: string): Promise<void> {
    if (!message) return;
    const client = this.client();
    if (!client) return;
    this.input.value = '';
    this.busy(true);
    this.add('msg user', message);
    try {
      const runId = await client.startRun(message);
      this.saveRun({ runId, lastSeq: 0 });
      await this.followRun(client, runId, 0);
    } catch (error) {
      this.fail(error);
    }
  }

  /** Picks up a run that was in progress when the page was closed. */
  private async resume(saved: SavedRun): Promise<void> {
    const client = this.client();
    if (!client) return;
    this.busy(true);
    this.add('note', 'Picking up your last request...');
    try {
      await this.followRun(client, saved.runId, saved.lastSeq);
    } catch (error) {
      if (error instanceof RunApiError && error.status === 404) this.clearRun();
      this.fail(error);
    }
  }

  private async followRun(client: RunClient, runId: string, after: number): Promise<void> {
    this.answer = undefined;
    this.stop = new AbortController();
    await client.follow(
      runId,
      (event) => {
        this.show(event);
        this.saveRun({ runId, lastSeq: event.seq });
      },
      { after, signal: this.stop.signal },
    );
    this.clearRun();
    this.busy(false);
  }

  /** Renders one event. Text only, never HTML. */
  private show(event: RunEvent): void {
    switch (event.type) {
      case 'text_delta':
        this.answer ??= this.add('msg assistant', '');
        this.answer.textContent += event.data.text;
        break;
      case 'tool_call_started': {
        const card = this.details('card', `Running ${event.data.tool}...`, event.data.arguments);
        this.cards.set(event.data.callId, card);
        this.answer = undefined; // text after a tool call starts a new bubble
        break;
      }
      case 'tool_call_finished': {
        const summary = this.cards.get(event.data.callId)?.querySelector('summary');
        if (summary) {
          summary.textContent = event.data.ok
            ? `${event.data.tool}: done`
            : `${event.data.tool}: failed (${event.data.errorCode ?? 'error'})`;
        }
        break;
      }
      case 'approval_required': {
        const lines = event.data.calls.map((c) => `${c.tool} ${c.arguments}\n  ${c.reason}`);
        this.details(
          'card approval',
          `Waiting for approval (${event.data.level === 'high' ? 'high risk' : 'required'})`,
          lines.join('\n'),
        );
        this.add('note', 'A person must approve this before it runs. You can close this page.');
        break;
      }
      case 'run_finished':
        if (event.data.status !== 'completed') {
          this.add('note error', event.data.error ?? `The request ${event.data.status}.`);
        } else if (!this.answer && event.data.answer) {
          this.add('msg assistant', event.data.answer);
        }
        break;
    }
    this.log.scrollTop = this.log.scrollHeight;
  }

  private client(): RunClient | undefined {
    const apiBase = this.getAttribute('api-base');
    if (!apiBase || !this.getToken) {
      this.add('note error', 'The chat is not set up (api-base or getToken missing).');
      return undefined;
    }
    return new RunClient(apiBase.replace(/\/$/, ''), this.getToken);
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : 'Something went wrong.';
    this.add('note error', message);
    this.busy(false);
  }

  private busy(on: boolean): void {
    this.button.disabled = on;
    this.input.disabled = on;
  }

  private add(className: string, text: string): HTMLElement {
    const node = el('div', className);
    node.textContent = text;
    this.log.append(node);
    return node;
  }

  private details(className: string, summary: string, body: string): HTMLElement {
    const node = document.createElement('details');
    node.className = className;
    const s = document.createElement('summary');
    s.textContent = summary;
    const pre = document.createElement('pre');
    pre.textContent = body;
    node.append(s, pre);
    this.log.append(node);
    return node;
  }

  private storageKey(): string {
    return `toolbridge-chat:${this.getAttribute('api-base') ?? ''}`;
  }

  private loadRun(): SavedRun | undefined {
    try {
      const raw = localStorage.getItem(this.storageKey());
      return raw ? (JSON.parse(raw) as SavedRun) : undefined;
    } catch {
      return undefined; // storage blocked (private mode): just no resume
    }
  }

  private saveRun(run: SavedRun): void {
    try {
      localStorage.setItem(this.storageKey(), JSON.stringify(run));
    } catch {
      // storage blocked: the run still works, it just cannot be resumed after a reload
    }
  }

  private clearRun(): void {
    try {
      localStorage.removeItem(this.storageKey());
    } catch {
      // nothing to do
    }
  }
}

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}
