/**
 * RFC 0058 — per-run wall-clock bound (`runTimeoutMs`) in the demo executor.
 *
 * Drives executeRun() directly against in-memory storage. A run whose only
 * node sleeps past its `configurable.runTimeoutMs` must:
 *   - emit `cap.breached { kind: 'run-duration', limit, observed }`
 *   - emit `run.failed` with `error.code: 'run_timeout'` AFTER the breach
 *   - resolve `status: 'failed'`
 * A run that finishes within its budget must not breach.
 *
 * Mirrors the node-executions (`recursionLimit`) breach contract; see
 * RFCS/0058-run-execution-bounds.md §C and spec/v1/run-options.md §runTimeoutMs.
 */

import { describe, expect, it, beforeAll, vi } from 'vitest';
import { executeRun } from '../src/executor/executor.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const storage: Storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-timeout-')) });

beforeAll(() => {
  const registry = getNodeRegistry();
  // Sleeps 200ms — well past the 20ms deadline the breach test sets, so the
  // wall-clock bound trips deterministically rather than on a tight race.
  registry.register({
    typeId: 'test.slow',
    version: '1.0.0',
    async execute() {
      await new Promise((r) => setTimeout(r, 200));
      return { status: 'success', outputs: { output: null } };
    },
  });
  registry.register({
    typeId: 'test.fast',
    version: '1.0.0',
    async execute() {
      return { status: 'success', outputs: { output: null } };
    },
  });
});

async function newRun(workflowId: string, configurable: Record<string, unknown>): Promise<RunRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-${Math.random().toString(36).slice(2)}`,
    workflowId,
    tenantId: 'demo',
    status: 'pending',
    inputs: {},
    metadata: {},
    configurable,
    createdAt: now,
    updatedAt: now,
  };
  await storage.insertRun(run);
  return run;
}

const oneNode = (workflowId: string, typeId: string): WorkflowDefinition => ({
  workflowId,
  nodes: [{ nodeId: 'a', typeId }],
  edges: [],
});

describe('RFC 0058 — runTimeoutMs (run-duration bound)', () => {
  it('breaches with cap.breached{run-duration} then run_timeout when the deadline passes', async () => {
    const run = await newRun('wf.timeout', { runTimeoutMs: 20 });
    const result = await executeRun(storage, run, oneNode('wf.timeout', 'test.slow'));

    expect(result.status).toBe('failed');

    const events = await storage.listEvents(run.runId);
    const types = events.map((e) => e.type);

    const breach = events.find((e) => e.type === 'cap.breached');
    expect(breach).toBeTruthy();
    const payload = breach!.payload as { kind?: string; limit?: number; observed?: number };
    expect(payload.kind).toBe('run-duration');
    expect(payload.limit).toBe(20);
    // RFC 0058 §A "when the deadline PASSES": strictly greater, never equal —
    // `run-execution-bounds-shape` asserts `observed > limit` and reads equality
    // as a `>=` breach. See the boundary test below for the deterministic case.
    expect(payload.observed).toBeGreaterThan(20);

    // §C: cap.breached MUST precede run.failed.
    expect(types.indexOf('cap.breached')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('cap.breached')).toBeLessThan(types.indexOf('run.failed'));

    const failed = events.find((e) => e.type === 'run.failed')!;
    expect((failed.payload as { error: { code: string } }).error.code).toBe('run_timeout');
  });

  it('the deadline TIMER landing exactly ON the boundary still emits observed > limit (RFC 0058 §A "passes")', async () => {
    // Fake timers make the race deterministic: the in-flight `test.slow` node
    // (200ms) never settles before the deadline timer, and advancing the clock
    // by EXACTLY the limit fires that timer with Date.now() === deadline. Before
    // the fix, `breachRunDuration` minted `observed === limit` right there
    // (`isRunDurationBreached` guards only the batch-loop path — #3222). After
    // it, the breach waits until the clock is strictly past the deadline.
    vi.useFakeTimers();
    try {
      const run = await newRun('wf.timeout.boundary', { runTimeoutMs: 20 });
      const pending = executeRun(storage, run, oneNode('wf.timeout.boundary', 'test.slow'));
      await vi.advanceTimersByTimeAsync(20);   // deadline timer fires: now === deadline
      // Give the (post-fix) 1ms boundary wait its tick(s); harmless pre-fix.
      await vi.advanceTimersByTimeAsync(5);
      const result = await pending;
      expect(result.status).toBe('failed');
      const events = await storage.listEvents(run.runId);
      const breach = events.find((e) => e.type === 'cap.breached');
      expect(breach).toBeTruthy();
      const payload = breach!.payload as { kind?: string; limit?: number; observed?: number };
      expect(payload.kind).toBe('run-duration');
      expect(payload.limit).toBe(20);
      expect(payload.observed).toBeGreaterThan(20);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not breach when the run finishes within runTimeoutMs', async () => {
    const run = await newRun('wf.ok', { runTimeoutMs: 60_000 });
    const result = await executeRun(storage, run, oneNode('wf.ok', 'test.fast'));

    expect(result.status).toBe('completed');
    const events = await storage.listEvents(run.runId);
    expect(events.find((e) => e.type === 'cap.breached')).toBeFalsy();
    expect(events.map((e) => e.type)).toContain('run.completed');
  });
});
