/**
 * One OS process of this host on a shared database, for witnesses that need two
 * real instances (ADR 0987 P0). Two `createApp` calls in one process share module
 * state (the run-admission maps in `middleware/rateLimit.ts` among them), so they
 * are one instance, not two.
 *
 * The parent spawns this file (`node --import tsx`) with `APP_PG_DSN` set. It boots
 * the real app, listens on an ephemeral port, sends `{ ready, port }`, and takes
 * commands over IPC:
 *
 *   { cmd: 'registerWorkflow', def }  → `registerWorkflowDurable` (shared via the DB)
 *   { cmd: 'exit' }                   → exits at once, no graceful drain
 *
 * Replies are `{ id, ok, error? }`.
 */
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/index.js';
import { registerWorkflowDurable } from '../../src/host/workflowsRegistry.js';
import type { WorkflowDefinition } from '../../src/executor/types.js';

const dsn = process.env.APP_PG_DSN;
if (!dsn || !process.send) {
  console.error('appProcess: needs APP_PG_DSN and an IPC channel');
  process.exit(2);
}

const app = await createApp({ port: 0, storageDsn: dsn, serviceName: 'two-process-witness', serviceVersion: '0.0.1', enableConsoleTracer: false });
const server = app.listen(0, '127.0.0.1', () => {
  process.send!({ ready: true, port: (server.address() as AddressInfo).port });
});

interface Command { id: number; cmd: 'registerWorkflow' | 'exit'; def?: WorkflowDefinition }
process.on('message', (m: Command) => {
  if (m.cmd === 'exit') process.exit(0);
  if (m.cmd === 'registerWorkflow') {
    registerWorkflowDurable(m.def!)
      .then(() => process.send!({ id: m.id, ok: true }))
      .catch((err: unknown) => process.send!({ id: m.id, ok: false, error: String(err) }));
  }
});
