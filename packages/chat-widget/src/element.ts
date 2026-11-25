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
 * A run in progress is remembered in localStorage, so reopening the tab picks it up again. So is the
 * conversation's id (never its text): the next message continues it until "New chat" is pressed.
 *
 * A normal write can be approved right here (ADR 0053). A high-risk one cannot: someone else must
 * approve it, so there is no button. ToolBridge checks both again.
 */
import type { RunEvent } from '@toolbridge/run-events';

import { type GetToken, RunApiError, RunClient } from './client.js';

const STYLE = `
  :host { display: block; font: 14px/1.5 system-ui, sans-serif; color: var(--tb-text, #1d1d1f); }
  * { box-sizing: border-box; }
  .box { display: flex; flex-direction: column; height: var(--tb-height, 480px); border: 1px solid var(--tb-border, #e2e4e6); border-radius: var(--tb-radius, 12px); background: var(--tb-bg, #fff); overflow: hidden; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--tb-border, #e2e4e6); }
  .title { font-weight: 600; }
  .sub { font-size: 12px; color: #6e6e73; }
  .sub:empty { display: none; }
  .log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
  .msg { padding: 9px 12px; border-radius: 10px; max-width: 88%; white-space: pre-wrap; overflow-wrap: anywhere; }
  .user { align-self: flex-end; background: var(--tb-accent, #0f766e); color: #fff; border-bottom-right-radius: 3px; }
  .assistant { align-self: flex-start; background: var(--tb-muted, #f4f5f6); border-bottom-left-radius: 3px; }
  .card { align-self: stretch; border: 1px solid var(--tb-border, #e2e4e6); border-radius: 10px; padding: 8px 12px; font-size: 13px; background: var(--tb-muted, #f4f5f6); }
  .card summary { cursor: pointer; }
  .card pre { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.5 ui-monospace, monospace; }
  .approval { border-color: #f0dcae; background: #fffaef; }
  .approval .label { font-size: 11px; font-weight: 700; letter-spacing: .04em; color: #8a5a00; }
  .approval .tool { font-weight: 600; margin-top: 6px; }
  .approval .why { font-size: 12px; color: #6e6e73; margin-top: 4px; }
  .approval .actions { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
  .approval .warn { margin-top: 8px; color: #b3261e; }
  .note { align-self: center; text-align: center; font-size: 12px; color: #6e6e73; }
  .error { color: #b3261e; }
  form { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--tb-border, #e2e4e6); }
  input { flex: 1; min-width: 0; padding: 9px 12px; font: inherit; border: 1px solid var(--tb-border, #d8d8dc); border-radius: 8px; }
  button { padding: 9px 16px; font: inherit; font-weight: 600; border: 1px solid transparent; border-radius: 8px; background: var(--tb-accent, #0f766e); color: #fff; cursor: pointer; }
  button:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--tb-accent, #0f766e); outline-offset: 2px; }
  .plain { background: #fff; color: inherit; border-color: var(--tb-border, #d8d8dc); }
  .new { padding: 4px 10px; font-size: 12px; font-weight: 400; background: transparent; color: inherit; border-color: var(--tb-border, #d8d8dc); }
  button:disabled { opacity: .5; cursor: default; }
`;

/** What is remembered while a run is in progress (per API base, in localStorage). */
interface SavedRun {
  runId: string;
  lastSeq: number;
}

/** The event that carries an approval card. */
type ApprovalRequired = Extract<RunEvent, { type: 'approval_required' }>;

/** Why a request was dropped, as its abort reason. */
const NEW_CHAT = 'new-chat';

export class ToolbridgeChat extends HTMLElement {
  static readonly observedAttributes = ['api-base', 'heading', 'subheading'];

  /** Set by the host page: fetches a session token from the host's own server. */
  getToken: GetToken | undefined;

  private readonly root: ShadowRoot;
  private readonly log: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly button: HTMLButtonElement;
  private readonly headingEl: HTMLElement;
  private readonly subheadingEl: HTMLElement;
  private answer: HTMLElement | undefined;
  private readonly cards = new Map<string, HTMLElement>();
  /** The buttons of the approval that is open right now, if it can be decided here. */
  private openActions: HTMLElement | undefined;
  private stop: AbortController | undefined;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    const box = el('div', 'box');
    const header = el('header');
    const titles = el('div');
    this.headingEl = el('div', 'title');
    this.subheadingEl = el('div', 'sub');
    titles.append(this.headingEl, this.subheadingEl);
    const newChat = document.createElement('button');
    newChat.className = 'new';
    newChat.type = 'button';
    newChat.textContent = 'New chat';
    newChat.addEventListener('click', () => {
      this.newChat();
    });
    header.append(titles, newChat);
    this.log = el('div', 'log');
    const form = document.createElement('form');
    this.input = document.createElement('input');
    this.input.placeholder = 'Ask about orders, refunds, shipments...';
    this.input.setAttribute('aria-label', 'Message');
    this.button = document.createElement('button');
    this.button.textContent = 'Send';
    form.append(this.input, this.button);
    box.append(header, this.log, form);
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
    if (name === 'subheading') this.subheadingEl.textContent = value ?? '';
  }

  /** Sends a message as a new run and follows it. */
  private async send(message: string): Promise<void> {
    if (!message) return;
    const client = this.client();
    if (!client) return;
    this.input.value = '';
    const stop = this.begin();
    this.add('msg user', message);
    try {
      const { runId, conversationId } = await client.startRun(message, this.conversationId());
      // Pressed meanwhile. A page that closed is different: its run is remembered, to pick up later.
      if (stop.reason === NEW_CHAT) return;
      this.store(this.conversationKey(), conversationId);
      this.saveRun({ runId, lastSeq: 0 });
      await this.followRun(client, runId, 0, stop);
    } catch (error) {
      if (!stop.aborted) this.fail(error);
    }
  }

  /**
   * Starts over: the next message begins a new conversation. A run in progress goes on on the
   * server (also one waiting for approval); this page just stops following it.
   */
  private newChat(): void {
    this.stop?.abort(NEW_CHAT);
    this.clearRun();
    this.store(this.conversationKey(), undefined);
    this.cards.clear();
    this.openActions = undefined;
    this.answer = undefined;
    this.log.replaceChildren();
    this.busy(false);
  }

  /** Picks up a run that was in progress when the page was closed. */
  private async resume(saved: SavedRun): Promise<void> {
    const client = this.client();
    if (!client) return;
    const stop = this.begin();
    this.add('note', 'Picking up your last request...');
    try {
      await this.followRun(client, saved.runId, saved.lastSeq, stop);
    } catch (error) {
      if (stop.aborted) return;
      if (error instanceof RunApiError && error.status === 404) {
        // Not this person's run: someone else signed in on this browser. Nothing to pick up.
        this.newChat();
        return;
      }
      this.fail(error);
    }
  }

  /**
   * Starts one request: locks the input and returns its own stop signal. "New chat" aborts it, so
   * nothing that still arrives for the old request can touch the new conversation.
   */
  private begin(): AbortSignal {
    this.busy(true);
    this.answer = undefined;
    this.stop = new AbortController();
    return this.stop.signal;
  }

  private async followRun(
    client: RunClient,
    runId: string,
    after: number,
    stop: AbortSignal,
  ): Promise<void> {
    await client.follow(
      runId,
      (event) => {
        if (stop.aborted) return;
        this.show(event, client);
        this.saveRun({ runId, lastSeq: event.seq });
      },
      { after, signal: stop },
    );
    this.clearRun();
    this.busy(false);
  }

  /** Renders one event. Text only, never HTML. */
  private show(event: RunEvent, client: RunClient): void {
    // Anything that happens after a card means it was decided, here or by someone else.
    this.openActions?.remove();
    this.openActions = undefined;
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
      case 'approval_required':
        this.showApproval(event.data, client);
        break;
      case 'run_finished':
        if (event.data.status !== 'completed') {
          this.add('note error', event.data.error ?? `The request ${event.data.status}.`);
        } else if (!this.answer && event.data.answer) {
          this.add('msg assistant', event.data.answer);
        } else if (!event.data.answer?.trim()) {
          this.add(
            'note error',
            'The assistant did not write an answer. An approved change may already be done: please ' +
              'check, or ask again.',
          );
        }
        break;
    }
    this.log.scrollTop = this.log.scrollHeight;
  }

  /**
   * The approval card: every call with its exact arguments, never folded away, because this is what
   * the person approves. Buttons only for a normal request.
   */
  private showApproval(data: ApprovalRequired['data'], client: RunClient): void {
    const card = el('div', 'card approval');
    card.append(el('div', 'label', data.level === 'high' ? 'HIGH RISK' : 'NEEDS YOUR OK'));
    for (const call of data.calls) {
      card.append(el('div', 'tool', call.tool));
      card.append(el('pre', undefined, call.arguments), el('div', 'why', call.reason));
    }
    if (data.exposure === 'flagged') {
      const where = (data.flagged ?? []).map((f) => `${f.tool} ${f.arguments}`);
      card.append(
        el(
          'div',
          'warn',
          'Warning: the assistant read text that looks like instructions' +
            `${where.length > 0 ? ` (${where.join('; ')})` : ' earlier in this conversation'}. ` +
            'Check that you really want exactly this.',
        ),
      );
    }
    if (data.level === 'high') {
      card.append(
        el('div', 'why', 'Someone else must approve this before it runs. You can close this page.'),
      );
    } else {
      const actions = el('div', 'actions');
      actions.append(
        this.decisionButton('approve', data.approvalId, client, card, actions),
        this.decisionButton('reject', data.approvalId, client, card, actions),
      );
      card.append(actions);
      this.openActions = actions;
    }
    this.log.append(card);
  }

  /** The Approve or Reject button. Both lock while one is being sent, so a card is decided once. */
  private decisionButton(
    decision: 'approve' | 'reject',
    approvalId: string,
    client: RunClient,
    card: HTMLElement,
    actions: HTMLElement,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = decision === 'approve' ? 'Approve' : 'Reject';
    if (decision === 'reject') button.className = 'plain';
    button.addEventListener('click', () => {
      const buttons = actions.querySelectorAll('button');
      buttons.forEach((b) => (b.disabled = true));
      client.decide(approvalId, decision).then(
        () => {
          actions.remove();
          card.append(
            el('div', 'why', decision === 'approve' ? 'You approved this.' : 'You rejected this.'),
          );
        },
        (error: unknown) => {
          actions.querySelector('.error')?.remove();
          actions.append(el('span', 'error', error instanceof Error ? error.message : 'Failed.'));
          // Already decided (409) or not allowed (403, 404): trying again cannot help.
          const final = error instanceof RunApiError && [403, 404, 409].includes(error.status);
          if (!final) buttons.forEach((b) => (b.disabled = false));
        },
      );
    });
    return button;
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
    const node = el('div', className, text);
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

  private conversationKey(): string {
    return `${this.storageKey()}:conversation`;
  }

  /** The conversation to continue, if one is remembered. */
  private conversationId(): string | undefined {
    try {
      return localStorage.getItem(this.conversationKey()) ?? undefined;
    } catch {
      return undefined; // storage blocked: every message starts a new conversation
    }
  }

  /** Remembers a value, or forgets it when undefined. */
  private store(key: string, value: string | undefined): void {
    try {
      if (value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // storage blocked: it just is not remembered
    }
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
    this.store(this.storageKey(), JSON.stringify(run));
  }

  private clearRun(): void {
    this.store(this.storageKey(), undefined);
  }
}

/** Creates an element, with a class and TEXT (never HTML). */
function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
