/**
 * RFC 0194 §A — a run's log is closed by its terminal event (eventLog.ts).
 * Suite 2.35.0 `v2-terminal-event-once` measured a cancelled run logging
 * `run.cancelled` then `node.failed`; this pins the rule at the one append
 * every event passes.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import { cancelRunAndCascade } from '../src/host/runCancel.js';
import { getEventLog, RunLogClosedError, setEventLogBackend } from '../src/executor/eventLog.js';

let storage: Storage;
beforeAll(async () => {
  storage = await openSqliteStorage(':memory:');
  setEventLogBackend(storage);
});

const types = async (runId: string) => (await getEventLog().list(runId, { fromSeq: -1, limit: 100 })).map((e) => e.type);

describe('RFC 0194 — nothing but compensation.* / the dead-letter record follows a terminal event', () => {
  for (const terminal of ['run.completed', 'run.failed', 'run.cancelled']) {
    it(`${terminal}: a later forward-execution append is refused and never written`, async () => {
      const runId = `r194-${terminal}`;
      const log = getEventLog();
      await log.append({ runId, type: 'run.started' });
      await log.append({ runId, type: 'node.started', nodeId: 'n1' });
      await log.append({ runId, type: terminal });
      await expect(log.append({ runId, type: 'node.failed', nodeId: 'n1' })).rejects.toBeInstanceOf(RunLogClosedError);
      await expect(log.append({ runId, type: 'run.completed' })).rejects.toBeInstanceOf(RunLogClosedError);
      expect(await types(runId)).toEqual(['run.started', 'node.started', terminal]);
    });
  }

  it('non-forward records may still follow: compensation, dead-letter, the RFC 0151 §E audit trail', async () => {
    const runId = 'r194-allowed';
    const log = getEventLog();
    await log.append({ runId, type: 'run.failed' });
    await log.append({ runId, type: 'compensation.started' });
    await log.append({ runId, type: 'run.dead_lettered' });
    await log.append({ runId, type: 'authorization.decided' });
    expect(await types(runId)).toEqual(['run.failed', 'compensation.started', 'run.dead_lettered', 'authorization.decided']);
  });

  it('every forward-execution kind the corpus names is refused (terminal-shape.ts, in this host\u2019s spellings)', async () => {
    const log = getEventLog();
    const runId = 'r194-forward';
    await log.append({ runId, type: 'run.cancelled' });
    for (const type of ['run.started', 'run.resumed', 'run.resuming', 'run.paused', 'workflow.restored', 'run.failed', 'node.started', 'node.completed', 'interrupt.requested']) {
      await expect(log.append({ runId, type }), type).rejects.toBeInstanceOf(RunLogClosedError);
    }
    expect(await types(runId)).toEqual(['run.cancelled']);
  });

  it('the STORE refuses too: a terminal written by another process (straight to the store) still closes the log', async () => {
    // What production measured (rev 00733): a cancel on one instance, the
    // executor on another. This process never saw the terminal event, so only
    // the store's check can refuse.
    const runId = 'r194-store';
    await storage.appendEvent({ eventId: 'r194-store-t', runId, type: 'run.cancelled', payload: null, timestamp: new Date().toISOString() });
    await expect(getEventLog().append({ runId, type: 'node.started', nodeId: 'n1' })).rejects.toBeInstanceOf(RunLogClosedError);
    await expect(storage.appendEvent({ eventId: 'r194-store-n', runId, type: 'node.started', payload: null, timestamp: new Date().toISOString() })).rejects.toBeInstanceOf(RunLogClosedError);
    await storage.appendEvent({ eventId: 'r194-store-a', runId, type: 'authorization.decided', payload: null, timestamp: new Date().toISOString() });
    expect(await types(runId)).toEqual(['run.cancelled', 'authorization.decided']);
  });

  it('other runs are unaffected', async () => {
    const log = getEventLog();
    await log.append({ runId: 'r194-a', type: 'run.completed' });
    await log.append({ runId: 'r194-b', type: 'node.started', nodeId: 'n1' });
    expect(await types('r194-b')).toEqual(['node.started']);
  });
});

describe('RFC 0194 — cancel never lands a second terminal event', () => {
  it('a STALE snapshot of a completed run is refused as already-terminal; row and log untouched', async () => {
    const now = new Date().toISOString();
    const run = { runId: 'r194-cancel-stale', tenantId: 't', workflowId: 'wf', status: 'completed', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now } as RunRecord;
    await storage.insertRun(run);
    // Written to the STORE, as another instance would: this process's closed-log
    // guard has not seen it, so only the cancel's own re-read can refuse.
    await storage.appendEvent({ eventId: 'r194-stale-done', runId: run.runId, type: 'run.completed', payload: null, timestamp: now });

    expect(await cancelRunAndCascade(storage, { ...run, status: 'running' }, 'late')).toBe('already-terminal');
    expect((await storage.getRun(run.runId))?.status).toBe('completed');
    expect(await types(run.runId)).toEqual(['run.completed']);
  });
});
