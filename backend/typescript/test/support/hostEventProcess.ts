/**
 * ADR 0988 D4 — one OS process of this host, for the two-process host-event witness
 * (`test/adr0988-host-event-two-process-postgres-live.test.ts`).
 *
 * Two `createApp` calls in one process are one instance: `hostEventStream.ts` keeps
 * its subscriber set and pub/sub binding in module state. So the test spawns this
 * file per instance (`node --import tsx`), each on the same Postgres
 * (`HOST_EVENT_PG_DSN`). It boots the real app, listens on an ephemeral port and
 * takes commands from the parent over IPC:
 *
 *   { cmd: 'fanout', tenantId, event }  → `fanOutHostEvent`, the production emit path
 *   { cmd: 'failAppends', count }       → the next `count` log appends throw (ADR 0988 D2)
 *   { cmd: 'deadLetters' }              → `hostEventDeadLetterSummary()` (reply `summary`)
 *   { cmd: 'exit' }                     → exits at once, no graceful drain (a crash)
 *
 * Replies are `{ ok: true, ... }` or `{ ok: false, error }`, keyed by `id`.
 */
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/index.js';
import { fanOutHostEvent } from '../../src/routes/webhooks.js';
import type { Storage } from '../../src/storage/storage.js';
import type { HostEventEnvelope } from '../../src/host/hostEventTypes.js';
import { _failHostEventAppendsForTesting, hostEventDeadLetterSummary } from '../../src/host/hostEventLog.js';

const dsn = process.env.HOST_EVENT_PG_DSN;
if (!dsn || !process.send) {
  console.error('hostEventProcess: needs HOST_EVENT_PG_DSN and an IPC channel');
  process.exit(2);
}

const app = await createApp({ port: 0, storageDsn: dsn, serviceName: 'adr0988-witness', serviceVersion: '0.0.1', enableConsoleTracer: false });
const storage = app.locals.storage as Storage;
const server = app.listen(0, '127.0.0.1', () => {
  process.send!({ ready: true, port: (server.address() as AddressInfo).port });
});

interface Command { id: number; cmd: 'fanout' | 'failAppends' | 'deadLetters' | 'exit'; tenantId?: string; event?: HostEventEnvelope; count?: number }
process.on('message', (m: Command) => {
  if (m.cmd === 'exit') process.exit(0);
  if (m.cmd === 'failAppends') {
    _failHostEventAppendsForTesting(m.count ?? 0);
    process.send!({ id: m.id, ok: true });
    return;
  }
  if (m.cmd === 'deadLetters') {
    hostEventDeadLetterSummary()
      .then((summary) => process.send!({ id: m.id, ok: true, summary }))
      .catch((err: unknown) => process.send!({ id: m.id, ok: false, error: String(err) }));
    return;
  }
  if (m.cmd === 'fanout') {
    fanOutHostEvent(storage, m.tenantId!, m.event!)
      .then(() => process.send!({ id: m.id, ok: true }))
      .catch((err: unknown) => process.send!({ id: m.id, ok: false, error: String(err) }));
  }
});
