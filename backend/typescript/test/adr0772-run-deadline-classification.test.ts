/**
 * ADR 0772 D1 (`RRWF-1`, `RRWF-2`) — a run-duration breach always surfaces as
 * `run_timeout`, and a resumed segment never inherits an earlier segment's
 * aborted signal.
 *
 * WHY FAKE TIMERS. The defect is an ORDERING: the run's abort signal (armed at
 * the run deadline) and the drain loop's own deadline timer expire on the same
 * millisecond. `core.delay` rejects on the abort; if that node failure settles
 * before the loop's timer, the loop re-checks `isRunDurationBreached` (strictly
 * `>`) while the clock still reads EXACTLY the deadline, finds no breach, and
 * finalizes the run as the node's `internal_error`. Under real timers this is a
 * load-dependent flake (the `run-execution-bounds-shape` red). Fake timers fire
 * the abort timer first (it was created first) and flush the node failure's
 * microtasks before the loop's timer, which is the losing order, every time.
 *
 * Runs through the REAL `core.delay` module (`ensureNodesRegistered`), so the
 * rejection is the production node's own, not a stand-in.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { executeRun } from '../src/executor/executor.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { armRunAbort, runAbortSignal } from '../src/executor/runLifecycle.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const storage: Storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-0772-deadline-')) });
ensureNodesRegistered();

async function newRun(configurable: Record<string, unknown>, inputs: Record<string, unknown> = {}): Promise<RunRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-0772-${Math.random().toString(36).slice(2)}`,
    workflowId: 'wf.0772.deadline',
    tenantId: 'demo',
    status: 'pending',
    inputs,
    metadata: {},
    configurable,
    createdAt: now,
    updatedAt: now,
  };
  await storage.insertRun(run);
  return run;
}

// One `core.delay` that sleeps far past the run deadline — the
// `conformance-run-duration-breach` fixture's shape.
const delayWorkflow: WorkflowDefinition = {
  workflowId: 'wf.0772.deadline',
  nodes: [{ nodeId: 'wait', typeId: 'core.delay', config: { durationMs: 30_000 } }],
  edges: [],
};

afterEach(() => { vi.useRealTimers(); });

describe('ADR 0772 D1 — a deadline breach is run_timeout, whichever timer settles first', () => {
  it('the node rejecting on the deadline abort BEFORE the loop timer still fails the run with run_timeout', async () => {
    vi.useFakeTimers();
    const run = await newRun({ runTimeoutMs: 50 });
    const pending = executeRun(storage, run, delayWorkflow);
    // Exactly the deadline: both the abort timer and the loop timer expire here.
    await vi.advanceTimersByTimeAsync(50);
    // Room for `breachRunDuration`'s strict-boundary wait.
    await vi.advanceTimersByTimeAsync(10);
    const result = await pending;
    expect(result.status).toBe('failed');

    const events = await storage.listEvents(run.runId);
    const failed = events.find((e) => e.type === 'run.failed');
    expect((failed?.payload as { error?: { code?: string } } | undefined)?.error?.code).toBe('run_timeout');
    const breach = events.find((e) => e.type === 'cap.breached');
    expect((breach?.payload as { kind?: string } | undefined)?.kind).toBe('run-duration');
    // The cut node is the breach's fact, not a node failure of its own (ADR 0632's
    // pause-cut precedent): no `node.failed` naming the abort.
    expect(events.filter((e) => e.type === 'node.failed')).toEqual([]);
    const row = await storage.getRun(run.runId);
    expect(row?.error?.code).toBe('run_timeout');
  });

  it('a genuine node failure BEFORE the deadline is still the node failure', async () => {
    const run = await newRun({ runTimeoutMs: 60_000 });
    const result = await executeRun(storage, run, {
      workflowId: 'wf.0772.deadline',
      nodes: [{ nodeId: 'boom', typeId: 'core.fail', config: {} }],
      edges: [],
    });
    expect(result.status).toBe('failed');
    const events = await storage.listEvents(run.runId);
    expect(events.some((e) => e.type === 'node.failed')).toBe(true);
    const failed = events.find((e) => e.type === 'run.failed');
    expect((failed?.payload as { error?: { code?: string } } | undefined)?.error?.code).not.toBe('run_timeout');
  });
});

describe('ADR 0772 D1.4 — each segment arms its own deadline (RRWF-2)', () => {
  it('a signal aborted by an earlier segment deadline is replaced when the run re-enters', async () => {
    const run = await newRun({ runTimeoutMs: 60_000 });
    // Simulate the first segment: armed with a deadline that has since passed
    // (an approval wait longer than the budget). The old code returned THIS
    // controller to every later segment.
    const stale = armRunAbort(run.runId, Date.now() - 1);
    expect(stale.aborted).toBe(true);

    // The resumed segment runs a signal-aware node well inside its OWN budget.
    const result = await executeRun(storage, run, {
      workflowId: 'wf.0772.deadline',
      nodes: [{ nodeId: 'wait', typeId: 'core.delay', config: { durationMs: 5 } }],
      edges: [],
    });
    expect(result.status).toBe('completed');
    const events = await storage.listEvents(run.runId);
    expect(events.some((e) => e.type === 'node.completed' && e.nodeId === 'wait')).toBe(true);
    // Terminal drops the entry; nothing aborted lingers for the next reader.
    expect(runAbortSignal(run.runId)).toBeUndefined();
  });
});
