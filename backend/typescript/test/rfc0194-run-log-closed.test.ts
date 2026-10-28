/**
 * RFC 0194 §A — a run's log is closed by its terminal event (eventLog.ts).
 * Suite 2.35.0 `v2-terminal-event-once` measured a cancelled run logging
 * `run.cancelled` then `node.failed`; this pins the rule at the one append
 * every event passes.
 *
 * DOUBLE GUARD, by design: the closed-log rule is enforced twice, by the
 * per-process fast path (`executor/eventLog.ts` `closedRuns`, checked before the
 * store is called) and by the store itself (`storage/sqlite/index.ts`
 * appendEvent's terminal check). Both read ONE predicate,
 * `isForwardExecutionEvent` (`storage/runLogClosure.ts`), which the terminal
 * cases witness (probe 8fw2g1-rl-node-not-forward). Each guard also has a case
 * of its own: "the STORE refuses too" (a terminal this process never saw) and
 * "the FAST PATH refuses without calling the store" (a recording backend).
 *
 * The stale-cancel case is a double guard as well: without the cancel's re-read,
 * the store refuses the late `run.cancelled` and the fallback restores the
 * status. So it asserts the WHOLE row is unchanged; the fallback rewrites
 * `updatedAt`/`completedAt`/`error`, which only the re-read avoids.
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

  it('the FAST PATH refuses without calling the store once this process has seen the terminal event', async () => {
    const runId = 'r194-fastpath';
    const calls: string[] = [];
    // A recording backend: every append still reaches the real store, so the
    // store's own guard is intact; what is counted is whether it was REACHED.
    const recording = new Proxy(storage, {
      get(target, key, receiver) {
        if (key === 'appendEvent') {
          return (input: Parameters<Storage['appendEvent']>[0]) => {
            if (input.runId === runId) calls.push(input.type);
            return target.appendEvent(input);
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    setEventLogBackend(recording);
    try {
      const log = getEventLog();
      await log.append({ runId, type: 'run.failed' });
      await expect(log.append({ runId, type: 'node.failed', nodeId: 'n1' })).rejects.toBeInstanceOf(RunLogClosedError);
      expect(calls, 'the refused append reached the store: the fast path did not refuse it').toEqual(['run.failed']);
    } finally {
      setEventLogBackend(storage);
    }
  });

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
    // Fixed past timestamps, so any write by the cancel path shows in the row.
    const run: RunRecord = {
      runId: 'r194-cancel-stale', tenantId: 't', workflowId: 'wf', status: 'completed',
      inputs: {}, metadata: {}, configurable: {},
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z', completedAt: '2026-01-01T00:00:01.000Z',
    };
    await storage.insertRun(run);
    // Written to the STORE, as another instance would: this process's closed-log
    // guard has not seen it. The cancel's own re-read refuses first; without it
    // the store would refuse the append and the fallback would rewrite the row.
    await storage.appendEvent({ eventId: 'r194-stale-done', runId: run.runId, type: 'run.completed', payload: null, timestamp: run.completedAt! });
    const before = await storage.getRun(run.runId);
    expect(before?.status).toBe('completed');

    expect(await cancelRunAndCascade(storage, { ...run, status: 'running' }, 'late')).toBe('already-terminal');
    // The ROW is untouched (every field, not only status) and so is the log.
    expect(await storage.getRun(run.runId)).toEqual(before);
    expect(await types(run.runId)).toEqual(['run.completed']);
  });
});
