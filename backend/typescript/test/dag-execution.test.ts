/**
 * End-to-end DAG executor tests (TST-CUA-3). Drives executeRun() directly against
 * the in-memory storage + node registry — no HTTP harness. The trigger-rule and
 * condition ARITHMETIC is unit-tested in `scheduler.test.ts`; this file owns the
 * executor WIRING: events emitted, run status mapped, nodes skipped or run.
 *
 * Covers (each red under the named sabotage):
 *   - Fan-out: 1 → {2, 3} parallel branches both run + emit completed events
 *   - Fan-in (all_success): the converging node waits for a SLOW upstream
 *     (red when all_success fires on the first completion)
 *   - Error routing (any_failed): downstream fires when an upstream fails and is
 *     skipped when none does (red when any_failed stops firing, or always fires)
 *   - Suspend-on-branch: the run reaches `waiting-approval` and pausedNodeIds
 *     contains the suspended id (red when approval maps to another waiting kind)
 *   - Edge condition: the truthy branch runs and the falsy branch is skipped
 *     (red when the condition is ignored)
 *   - Concurrency cap: with OPENWOP_MAX_CONCURRENT_NODES=1 at most one node is
 *     in flight and the fan-out still drains (red when the knob is ignored)
 *   - Cycle rejection: fails with cycle_detected before any node.* event
 *   - Linear back-compat: no edges ⇒ an implicit chain in array order
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { executeRun } from '../src/executor/executor.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
// eventLog backend is set via setEventLogBackend below; the executor reads
// it through getEventLog() so no direct import here.
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
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-dag-')) });

/** Concurrency witness for `test.delayed-passthrough` (reset by the case that reads it). */
let inFlight = 0;
let maxInFlight = 0;

beforeAll(() => {
  const registry = getNodeRegistry();
  // Pass-through node that echoes input on the output port.
  registry.register({
    typeId: 'test.passthrough',
    version: '1.0.0',
    async execute(ctx) {
      const inputs = ctx.inputs as Record<string, unknown> | undefined;
      return { status: 'success', outputs: { output: inputs?.input ?? inputs ?? null } };
    },
  });
  // Always-fails node.
  registry.register({
    typeId: 'test.always-fails',
    version: '1.0.0',
    async execute() {
      return { status: 'failure', error: { code: 'test_error', message: 'always fails' } };
    },
  });
  // Suspends with approval kind.
  registry.register({
    typeId: 'test.always-suspends',
    version: '1.0.0',
    async execute() {
      return {
        status: 'suspended',
        interrupt: { kind: 'approval', data: { prompt: 'test' } },
      };
    },
  });
  // Records its id for ordering checks, and how many run at once.
  registry.register({
    typeId: 'test.delayed-passthrough',
    version: '1.0.0',
    async execute(ctx) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      const inputs = ctx.inputs as Record<string, unknown> | undefined;
      return {
        status: 'success',
        outputs: { output: inputs?.input ?? null, nodeId: ctx.nodeId },
      };
    },
  });
});

async function newRun(workflowId: string): Promise<RunRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-${Math.random().toString(36).slice(2)}`,
    workflowId,
    tenantId: 'demo',
    status: 'pending',
    inputs: { hello: 'world' },
    metadata: {},
    configurable: {},
    createdAt: now,
    updatedAt: now,
  };
  await storage.insertRun(run);
  return run;
}

describe('DAG: fan-out', () => {
  it('1 → {2, 3} runs both downstreams', async () => {
    const run = await newRun('wf.fan-out');
    const def: WorkflowDefinition = {
      workflowId: 'wf.fan-out',
      nodes: [
        { nodeId: 'a', typeId: 'test.passthrough' },
        { nodeId: 'b', typeId: 'test.passthrough' },
        { nodeId: 'c', typeId: 'test.passthrough' },
      ],
      edges: [
        { edgeId: 'e1', sourceNodeId: 'a', targetNodeId: 'b' },
        { edgeId: 'e2', sourceNodeId: 'a', targetNodeId: 'c' },
      ],
    };
    const result = await executeRun(storage, run, def);
    expect(result.status).toBe('completed');
    const events = (await storage.listEvents(run.runId)).map((e) => e.type);
    expect(events.filter((t) => t === 'node.completed')).toHaveLength(3);
    expect(events).toContain('run.completed');
  });
});

describe('DAG: fan-in', () => {
  it('all_success waits for every upstream', async () => {
    const run = await newRun('wf.fan-in-all');
    // `b` is SLOW, so `a` completes first: only all_success holds `c` back for `b`.
    const def: WorkflowDefinition = {
      workflowId: 'wf.fan-in-all',
      nodes: [
        { nodeId: 'a', typeId: 'test.passthrough' },
        { nodeId: 'b', typeId: 'test.delayed-passthrough' },
        { nodeId: 'c', typeId: 'test.passthrough' },
      ],
      edges: [
        { edgeId: 'e1', sourceNodeId: 'a', targetNodeId: 'c', triggerRule: 'all_success' },
        { edgeId: 'e2', sourceNodeId: 'b', targetNodeId: 'c', triggerRule: 'all_success' },
      ],
    };
    const result = await executeRun(storage, run, def);
    expect(result.status).toBe('completed');
    const events = await storage.listEvents(run.runId);
    const completedIds = events.filter((e) => e.type === 'node.completed').map((e) => e.nodeId);
    expect(new Set(completedIds)).toEqual(new Set(['a', 'b', 'c']));
    // c MUST appear after both a and b.
    const aIdx = events.findIndex((e) => e.type === 'node.completed' && e.nodeId === 'a');
    const bIdx = events.findIndex((e) => e.type === 'node.completed' && e.nodeId === 'b');
    const cIdx = events.findIndex((e) => e.type === 'node.completed' && e.nodeId === 'c');
    expect(cIdx).toBeGreaterThan(aIdx);
    expect(cIdx).toBeGreaterThan(bIdx);
  });
});

describe('DAG: error routing with any_failed', () => {
  it('downstream fires only when an upstream fails', async () => {
    const run = await newRun('wf.error-route');
    const def: WorkflowDefinition = {
      workflowId: 'wf.error-route',
      nodes: [
        { nodeId: 'a', typeId: 'test.always-fails' },
        { nodeId: 'b', typeId: 'test.passthrough' },
        { nodeId: 'recover', typeId: 'test.passthrough' },
      ],
      edges: [
        // a fails → routes to recover via any_failed.
        { edgeId: 'e1', sourceNodeId: 'a', targetNodeId: 'recover', triggerRule: 'any_failed' },
        { edgeId: 'e2', sourceNodeId: 'b', targetNodeId: 'recover', triggerRule: 'any_failed' },
      ],
    };
    const result = await executeRun(storage, run, def);
    // any_failed branch ran: recover ran. b is a sibling that completed.
    // The run completed because recover (a terminal node) succeeded.
    expect(result.status).toBe('completed');
    const events = await storage.listEvents(run.runId);
    expect(events.some((e) => e.type === 'node.failed' && e.nodeId === 'a')).toBe(true);
    expect(events.some((e) => e.type === 'node.completed' && e.nodeId === 'recover')).toBe(true);

    // …and ONLY then: with every upstream succeeding, the error branch is skipped.
    const ok = await newRun('wf.error-route-ok');
    const okDef: WorkflowDefinition = {
      workflowId: 'wf.error-route-ok',
      nodes: [
        { nodeId: 'a', typeId: 'test.passthrough' },
        { nodeId: 'b', typeId: 'test.passthrough' },
        { nodeId: 'recover', typeId: 'test.passthrough' },
      ],
      edges: [
        { edgeId: 'e1', sourceNodeId: 'a', targetNodeId: 'recover', triggerRule: 'any_failed' },
        { edgeId: 'e2', sourceNodeId: 'b', targetNodeId: 'recover', triggerRule: 'any_failed' },
      ],
    };
    await executeRun(storage, ok, okDef);
    const okEvents = await storage.listEvents(ok.runId);
    expect(okEvents.filter((e) => e.type === 'node.completed').map((e) => e.nodeId).sort()).toEqual(['a', 'b']);
    expect(okEvents.some((e) => e.nodeId === 'recover' && e.type === 'node.started')).toBe(false);
  });
});

describe('DAG: suspend on one branch', () => {
  it('one branch suspends, other completes; run reaches waiting-approval', async () => {
    // test.always-suspends emits kind=approval; finalize maps that to
    // 'waiting-approval' (regression guard from code-review #1).
    const run = await newRun('wf.suspend-branch');
    const def: WorkflowDefinition = {
      workflowId: 'wf.suspend-branch',
      nodes: [
        { nodeId: 'a', typeId: 'test.passthrough' },
        { nodeId: 'fast', typeId: 'test.passthrough' },
        { nodeId: 'slow', typeId: 'test.always-suspends' },
      ],
      edges: [
        { edgeId: 'e1', sourceNodeId: 'a', targetNodeId: 'fast' },
        { edgeId: 'e2', sourceNodeId: 'a', targetNodeId: 'slow' },
      ],
    };
    const result = await executeRun(storage, run, def);
    expect(result.status).toBe('waiting-approval');
    expect(result.pausedNodeIds).toContain('slow');
    const events = await storage.listEvents(run.runId);
    expect(events.some((e) => e.type === 'node.completed' && e.nodeId === 'fast')).toBe(true);
    expect(events.some((e) => e.type === 'node.suspended' && e.nodeId === 'slow')).toBe(true);
  });
});

describe('DAG: edge condition predicate (end-to-end)', () => {
  it('condition path/op/value filters edge contribution', async () => {
    // a emits { output: 5 }; edge a→pass fires only if output > 0 — not
    // expressible with our predicate vocabulary (`gt` isn't in the set), so
    // test the documented set: `truthy` op against the output value.
    const run = await newRun('wf.edge-condition');
    const def: WorkflowDefinition = {
      workflowId: 'wf.edge-condition',
      nodes: [
        { nodeId: 'a', typeId: 'test.passthrough' },
        { nodeId: 'pass', typeId: 'test.passthrough' },
        { nodeId: 'blocked', typeId: 'test.passthrough' },
      ],
      edges: [
        {
          edgeId: 'e1',
          sourceNodeId: 'a',
          targetNodeId: 'pass',
          condition: { path: 'output', op: 'truthy' },
        },
        {
          edgeId: 'e2',
          sourceNodeId: 'a',
          targetNodeId: 'blocked',
          condition: { path: 'output', op: 'falsy' },
        },
      ],
    };
    const result = await executeRun(storage, run, def);
    expect(result.status).toBe('completed');
    const events = await storage.listEvents(run.runId);
    expect(events.some((e) => e.type === 'node.completed' && e.nodeId === 'pass')).toBe(true);
    // a's output ({ hello: 'world' }) is truthy, so the falsy edge contributes nothing.
    expect(events.some((e) => e.nodeId === 'blocked' && e.type === 'node.started')).toBe(false);
  });
});

describe('DAG: concurrency cap', () => {
  it('OPENWOP_MAX_CONCURRENT_NODES=1 still drains a fan-out of 5', async () => {
    process.env.OPENWOP_MAX_CONCURRENT_NODES = '1';
    inFlight = 0;
    maxInFlight = 0;
    try {
      const run = await newRun('wf.concurrency-cap');
      const def: WorkflowDefinition = {
        workflowId: 'wf.concurrency-cap',
        nodes: [
          { nodeId: 'a', typeId: 'test.passthrough' },
          { nodeId: 'b1', typeId: 'test.delayed-passthrough' },
          { nodeId: 'b2', typeId: 'test.delayed-passthrough' },
          { nodeId: 'b3', typeId: 'test.delayed-passthrough' },
          { nodeId: 'b4', typeId: 'test.delayed-passthrough' },
          { nodeId: 'b5', typeId: 'test.delayed-passthrough' },
        ],
        edges: [
          { edgeId: 'e1', sourceNodeId: 'a', targetNodeId: 'b1' },
          { edgeId: 'e2', sourceNodeId: 'a', targetNodeId: 'b2' },
          { edgeId: 'e3', sourceNodeId: 'a', targetNodeId: 'b3' },
          { edgeId: 'e4', sourceNodeId: 'a', targetNodeId: 'b4' },
          { edgeId: 'e5', sourceNodeId: 'a', targetNodeId: 'b5' },
        ],
      };
      const result = await executeRun(storage, run, def);
      expect(result.status).toBe('completed');
      const completed = (await storage.listEvents(run.runId))
        .filter((e) => e.type === 'node.completed')
        .map((e) => e.nodeId);
      expect(new Set(completed)).toEqual(new Set(['a', 'b1', 'b2', 'b3', 'b4', 'b5']));
      // …serialized: the cap held every delayed sibling to one at a time.
      expect(maxInFlight).toBe(1);
    } finally {
      delete process.env.OPENWOP_MAX_CONCURRENT_NODES;
    }
  });
});

describe('DAG: cycle rejection', () => {
  it('fails with cycle_detected before any node.* events', async () => {
    const run = await newRun('wf.cycle');
    const def: WorkflowDefinition = {
      workflowId: 'wf.cycle',
      nodes: [
        { nodeId: 'a', typeId: 'test.passthrough' },
        { nodeId: 'b', typeId: 'test.passthrough' },
        { nodeId: 'c', typeId: 'test.passthrough' },
      ],
      edges: [
        { edgeId: 'e1', sourceNodeId: 'a', targetNodeId: 'b' },
        { edgeId: 'e2', sourceNodeId: 'b', targetNodeId: 'c' },
        { edgeId: 'e3', sourceNodeId: 'c', targetNodeId: 'a' },
      ],
    };
    const result = await executeRun(storage, run, def);
    expect(result.status).toBe('failed');
    const events = await storage.listEvents(run.runId);
    expect(events.some((e) => e.type === 'node.started')).toBe(false);
    const failure = events.find((e) => e.type === 'run.failed');
    expect(failure).toBeDefined();
    expect(((failure!.payload as { error: { code: string } }).error.code)).toBe('cycle_detected');
  });
});

describe('DAG: linear back-compat', () => {
  it('legacy linear definition (no edges) still works', async () => {
    const run = await newRun('wf.legacy-linear');
    const def: WorkflowDefinition = {
      workflowId: 'wf.legacy-linear',
      nodes: [
        { nodeId: 'a', typeId: 'test.passthrough' },
        { nodeId: 'b', typeId: 'test.passthrough' },
        { nodeId: 'c', typeId: 'test.passthrough' },
      ],
      // No edges — executor builds implicit linear chain.
    };
    const result = await executeRun(storage, run, def);
    expect(result.status).toBe('completed');
    const completed = (await storage.listEvents(run.runId))
      .filter((e) => e.type === 'node.completed')
      .map((e) => e.nodeId);
    expect(completed).toEqual(['a', 'b', 'c']);
  });
});
