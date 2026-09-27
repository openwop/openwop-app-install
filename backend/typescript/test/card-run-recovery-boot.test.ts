/**
 * ADR 0535 P3 — the BOOT WIRING, not the handler.
 *
 * `card-run-recovery.test.ts` calls the handler directly, so it would stay
 * green even if nothing registered it at boot — the failure mode where every
 * unit test passes and the feature is inert in the real app. This boots the
 * REAL app (`createApp`, which calls `registerCardRunRecovery`) and then only
 * ever announces a terminal run the way the executor does. Nothing here calls
 * the recovery code by hand.
 *
 * It uses the app's OWN storage (`__hostExtStorage()`), because a second
 * `openStorage('memory://')` is a different sqlite instance — seeding into it
 * would test nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import { notifyRunTerminal } from '../src/executor/runLifecycle.js';
import {
  createBoard,
  createCard,
  getCard,
  moveCard,
  setCardLastRun,
  type KanbanBoard,
} from '../src/host/kanbanService.js';
import type { Storage } from '../src/storage/storage.js';

const T = 'card-recovery-boot-t1';

let server: Server;
let storage: Storage;
let board: KanbanBoard;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });

  const s = __hostExtStorage();
  if (!s) throw new Error('app boot did not initialise host-ext storage');
  storage = s;

  board = await createBoard({
    tenantId: T,
    name: 'Agent board',
    ownerSubject: { kind: 'agent', id: 'roster-boot-1' },
    columns: [
      { id: 'todo', name: 'To Do' },
      { id: 'working', name: 'Working' },
      { id: 'done', name: 'Done', terminal: true },
    ],
  });
});

afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function pickedCardWithRun(
  runId: string,
  metadataKey: 'heartbeat' | 'approval',
): Promise<string> {
  const card = await createCard({ boardId: board.id, columnId: 'todo', title: `work ${runId}` });
  await setCardLastRun(card.id, runId);
  await moveCard(card.id, 'working');
  const now = new Date().toISOString();
  await storage.insertRun({
    runId,
    tenantId: T,
    workflowId: 'wf-1',
    status: 'failed',
    inputs: {},
    metadata: { [metadataKey]: { boardId: board.id, cardId: card.id, source: metadataKey } },
    configurable: {},
    createdAt: now,
    updatedAt: now,
  });
  return card.id;
}

/** The global fan-out is fire-and-forget; let its microtasks drain. */
const drain = () => new Promise((r) => setImmediate(r));

describe('ADR 0535 P3 — recovery is wired at boot', () => {
  it('a terminal run announced the way the executor announces it restores a heartbeat-picked card', async () => {
    const cardId = await pickedCardWithRun('boot-run-1', 'heartbeat');

    // Exactly what `emitTerminalFailure` does — no test-only registration.
    notifyRunTerminal('boot-run-1', 'failed');
    await drain();

    expect(
      (await getCard(cardId))?.columnId,
      'if this is "working", registerCardRunRecovery never ran at boot and the feature is inert',
    ).toBe('todo');
  });

  it('and an approval-picked card, through the same boot registration', async () => {
    const cardId = await pickedCardWithRun('boot-run-2', 'approval');

    notifyRunTerminal('boot-run-2', 'failed');
    await drain();

    expect((await getCard(cardId))?.columnId).toBe('todo');
  });

  it('a completed run leaves its card in Working', async () => {
    const card = await createCard({ boardId: board.id, columnId: 'todo', title: 'finished work' });
    await setCardLastRun(card.id, 'boot-run-3');
    await moveCard(card.id, 'working');
    const now = new Date().toISOString();
    await storage.insertRun({
      runId: 'boot-run-3',
      tenantId: T,
      workflowId: 'wf-1',
      status: 'completed',
      inputs: {},
      metadata: { heartbeat: { boardId: board.id, cardId: card.id, source: 'heartbeat' } },
      configurable: {},
      createdAt: now,
      updatedAt: now,
    });

    notifyRunTerminal('boot-run-3', 'completed');
    await drain();

    expect(
      (await getCard(card.id))?.columnId,
      'a run finishing is not the task being done — auto-advancing would close work no human accepted',
    ).toBe('working');
  });
});
