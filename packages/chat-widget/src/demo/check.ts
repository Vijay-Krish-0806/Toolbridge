/**
 * `pnpm demo:check` (Step 7.0 a): drives the widget's real RunClient from Node against the live
 * stack, as a browser would (minus the DOM): a session for the support user, a run, a stream that
 * is dropped after two events, and a reconnect that must deliver exactly the rest.
 */
import type { RunEvent } from '@toolbridge/run-events';

import { RunClient } from '../client.js';
import { hostLogin, mintSession } from './host-session.js';

const user = await hostLogin('support');
const client = new RunClient(process.env.TOOLBRIDGE_API_URL ?? '', () => mintSession(user));
const { runId } = await client.startRun('What is the status of order ORD-10007?');
console.log(`run ${runId}`);

const seen: RunEvent[] = [];
const drop = new AbortController();
await client
  .follow(
    runId,
    (event) => {
      seen.push(event);
      if (seen.length === 2) drop.abort(); // the tab closes
    },
    { signal: drop.signal },
  )
  .catch(() => undefined);
console.log(`first connection: ${String(seen.length)} events, then dropped`);

const finished = await client.follow(runId, (event) => seen.push(event), {
  after: seen.at(-1)?.seq ?? 0,
});
const seqs = seen.map((e) => e.seq);
console.log(
  `reconnected: ${String(seen.length)} events in total, numbers 1..${String(seqs.at(-1))}`,
);
console.log(`no gaps or repeats: ${String(seqs.every((s, i) => s === i + 1))}`);
const text = seen.flatMap((e) => (e.type === 'text_delta' ? [e.data.text] : [])).join('');
console.log(`finished: ${finished.type === 'run_finished' ? finished.data.status : '?'}`);
console.log(`answer: ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
