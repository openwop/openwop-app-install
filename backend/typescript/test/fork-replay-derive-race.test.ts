/**
 * The replay-fork gate derivation (forkReplayResolutions.ts) must never leave
 * one gate with two outcomes. The first cut created the fork's row OPEN — which
 * fired the inbox notification — then resolved it a step later and DISCARDED
 * the CAS result, so a person deciding the row in between won the claim while
 * the executor applied the recorded decision anyway.
 *
 * Witnesses: the derived row is inserted already resolved with NO notification;
 * and a decision interleaved on an open fork row makes the derivation REFUSE
 * (`conflict`), never report the recorded decision as applied.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const notified = vi.hoisted(() => [] as Array<{ runId: string; nodeId: string }>);
vi.mock('../src/notifications/notify.js', async (orig) => ({
  ...(await orig<typeof import('../src/notifications/notify.js')>()),
  emitInterruptNotification: async (_s: unknown, rec: { runId: string; nodeId: string }) => { notified.push({ runId: rec.runId, nodeId: rec.nodeId }); },
}));

import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import { getSuspendManager, setSuspendBackend } from '../src/executor/suspendManager.js';
import { deriveRecordedResolutions } from '../src/executor/forkReplayResolutions.js';

let storage: Storage;
const now = () => new Date().toISOString();
const run = (over: Partial<RunRecord>): RunRecord => ({
  runId: randomUUID(), workflowId: 'wf', tenantId: 't1', status: 'running', inputs: {}, metadata: {}, configurable: {},
  createdAt: now(), updatedAt: now(), ...over,
});

/** A source run whose gate was decided `accept`, and a replay fork taken at
 *  that `interrupt.resolved`. */
async function decidedSourceAndFork(): Promise<{ src: RunRecord; fork: RunRecord }> {
  const suspend = getSuspendManager();
  const src = run({ status: 'completed' });
  await storage.insertRun(src);
  const row = await suspend.createInterrupt({ runId: src.runId, nodeId: 'gate', kind: 'approval', data: { prompt: 'Ship?' } });
  expect(await storage.resolveInterrupt(row.interruptId, { action: 'accept' }, now())).toBe(true);
  await storage.appendEvent({ eventId: randomUUID(), runId: src.runId, nodeId: 'gate', type: 'interrupt.requested', payload: { interruptId: row.interruptId, kind: 'approval' }, timestamp: now() });
  const at = await storage.appendEvent({ eventId: randomUUID(), runId: src.runId, nodeId: 'gate', type: 'interrupt.resolved', payload: { interruptId: row.interruptId, kind: 'approval', action: 'accept' }, timestamp: now() });
  const fork = run({ parentRunId: src.runId, parentSeq: at.sequence, forkMode: 'replay' });
  await storage.insertRun(fork);
  notified.length = 0;
  return { src, fork };
}

beforeEach(async () => {
  storage = await openStorage('memory://');
  setSuspendBackend(storage);
});

describe('replay-fork gate derivation — one gate, one outcome', () => {
  it('inserts the fork\'s row ALREADY RESOLVED and fires no notification for it', async () => {
    const { fork } = await decidedSourceAndFork();
    const [d] = await deriveRecordedResolutions({ storage, suspend: getSuspendManager(), run: fork, suspendedNodeIds: ['gate'] });
    expect(d).toMatchObject({ nodeId: 'gate', conflict: false, alreadyRecorded: false, resolvedValue: { action: 'accept' } });
    expect(await storage.listOpenInterrupts(fork.runId), 'an open row for the derived gate').toEqual([]);
    const row = await storage.getInterrupt(d!.interruptId);
    expect(row?.runId).toBe(fork.runId);
    expect(row?.resolvedAt, 'the derived row was left open: a human path could decide it').toBeTruthy();
    expect(notified.filter((n) => n.runId === fork.runId), 'the derived gate surfaced in the inbox').toEqual([]);
    // A redelivery re-applies its own derivation, never reads it as a conflict.
    const [again] = await deriveRecordedResolutions({ storage, suspend: getSuspendManager(), run: fork, suspendedNodeIds: ['gate'] });
    expect(again).toMatchObject({ conflict: false, interruptId: d!.interruptId });
  });

  it('REFUSES when a decision is interleaved on an open fork row: the recorded decision is not applied', async () => {
    const { fork } = await decidedSourceAndFork();
    const open = await getSuspendManager().createInterrupt({ runId: fork.runId, nodeId: 'gate', kind: 'approval', data: {} });
    // Interleave: a person decides the row between the derivation's read and its CAS.
    const racing: Storage = Object.create(storage);
    racing.resolveInterrupt = async (id, value, at) => {
      expect(await storage.resolveInterrupt(open.interruptId, { action: 'reject' }, now())).toBe(true);
      return storage.resolveInterrupt(id, value, at);
    };
    const [d] = await deriveRecordedResolutions({ storage: racing, suspend: getSuspendManager(), run: fork, suspendedNodeIds: ['gate'] });
    expect(d, 'the derivation applied the recorded decision over a person\'s').toMatchObject({ nodeId: 'gate', conflict: true });
    expect((await storage.getInterrupt(open.interruptId))?.resolvedValue).toEqual({ action: 'reject' });
  });
});
