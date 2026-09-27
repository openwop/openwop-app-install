/**
 * Edge-condition control-flow — END-TO-END through the real executor (ADR 0208,
 * ECR-1/ECR-3). The scheduler-unit tests prove `evaluateTrigger` folds a false
 * condition to `skipped`; this drives the ACTUAL `executeRun()` against
 * in-memory storage + the node registry to prove a routed workflow really only
 * executes the matching branch (the unmatched branch emits no `node.completed`),
 * and that the routing decision is DETERMINISTIC — the property fork/replay
 * relies on (a fork re-derives scheduler state from the parent run's
 * checkpointed node outputs; if that derivation weren't a pure function of the
 * recorded outputs, replay would diverge).
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeRun } from '../src/executor/executor.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import {
  buildGraph,
  freshSnapshot,
  markCompleted,
  releaseDownstream,
} from '../src/executor/scheduler.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

const storage: Storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-ecr-')) });

beforeAll(() => {
  const registry = getNodeRegistry();
  // A router: emits branches from its run input `key` (source-position node, so
  // ctx.inputs is the raw run payload). Mirrors core.flow.router's output shape.
  registry.register({
    typeId: 'test.route-emit',
    version: '1.0.0',
    async execute(ctx) {
      const key = (ctx.inputs as { key?: string } | undefined)?.key ?? 'default';
      return { status: 'success', outputs: { branches: [key] } };
    },
  });
  // A recording pass-through — its `node.completed` event (carrying nodeId) is
  // how we observe which branch actually executed.
  registry.register({
    typeId: 'test.mark',
    version: '1.0.0',
    async execute() {
      return { status: 'success', outputs: { output: 'ran' } };
    },
  });
});

async function newRun(inputs: unknown): Promise<RunRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-${Math.random().toString(36).slice(2)}`,
    workflowId: 'wf.route',
    tenantId: 'demo',
    status: 'pending',
    inputs,
    metadata: {},
    configurable: {},
    createdAt: now,
    updatedAt: now,
  };
  await storage.insertRun(run);
  return run;
}

// route → {a (branches∋'a'), b (branches∋'b')} → merge
const ROUTED: WorkflowDefinition = {
  workflowId: 'wf.route',
  nodes: [
    { nodeId: 'route', typeId: 'test.route-emit' },
    { nodeId: 'a', typeId: 'test.mark' },
    { nodeId: 'b', typeId: 'test.mark' },
    { nodeId: 'merge', typeId: 'test.mark' },
  ],
  edges: [
    { edgeId: 'e1', sourceNodeId: 'route', targetNodeId: 'a', condition: { path: 'branches', op: 'contains', value: 'a' } },
    { edgeId: 'e2', sourceNodeId: 'route', targetNodeId: 'b', condition: { path: 'branches', op: 'contains', value: 'b' } },
    { edgeId: 'e3', sourceNodeId: 'a', targetNodeId: 'merge' },
    { edgeId: 'e4', sourceNodeId: 'b', targetNodeId: 'merge' },
  ],
};

async function completedNodeIds(inputs: unknown): Promise<string[]> {
  const run = await newRun(inputs);
  const result = await executeRun(storage, run, ROUTED);
  expect(result.status).toBe('completed');
  return (await storage.listEvents(run.runId))
    .filter((e) => e.type === 'node.completed')
    .map((e) => e.nodeId!)
    .sort();
}

describe('edge-condition control-flow — real executor run (ECR-1/ECR-3)', () => {
  it('executes ONLY the matching branch; the unmatched branch never runs', async () => {
    // key='a' → route emits branches:['a'] → only `a` runs, `b` is skipped.
    expect(await completedNodeIds({ key: 'a' })).toEqual(['a', 'merge', 'route']);
    // key='b' routes the other way.
    expect(await completedNodeIds({ key: 'b' })).toEqual(['b', 'merge', 'route']);
  });

  it('routing is DETERMINISTIC — identical inputs reproduce the identical branch set', async () => {
    const first = await completedNodeIds({ key: 'a' });
    const second = await completedNodeIds({ key: 'a' });
    expect(second).toEqual(first);
    expect(second).not.toContain('b'); // the skipped branch never leaks across runs
  });

  it('skip derivation is order-independent — the replay-safety property (ECR-1)', () => {
    // A fork re-derives scheduler state from the parent run's CHECKPOINTED node
    // outputs. Prove that derivation is a pure function of the recorded outputs:
    // seeding the same `route` output and releasing downstream yields the same
    // verdicts regardless of snapshot instance / call repetition.
    const verdicts = () => {
      const g = buildGraph(ROUTED);
      const s = freshSnapshot(ROUTED);
      markCompleted('route', { branches: ['a'] }, s);
      releaseDownstream('route', g, s);
      // Idempotent re-release (a replay may re-invoke) must not change anything.
      releaseDownstream('route', g, s);
      return { a: s.nodeState.get('a'), b: s.nodeState.get('b') };
    };
    expect(verdicts()).toEqual({ a: 'ready', b: 'skipped' });
    expect(verdicts()).toEqual(verdicts()); // stable across independent derivations
  });
});
