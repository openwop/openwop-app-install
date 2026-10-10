/**
 * A fixture whose graph the executor REFUSES is not advertised (`fixtures[]`).
 *
 * `conformance-approval-reject-loopback` (suite 2.43.1, openwop#1697) loops
 * `revise → gate`, bounded by `settings.maxLoopbackIterations`. This scheduler
 * admits a cycle only through a `core.dispatch` / `core.orchestrator.supervisor`
 * endpoint and does not implement `maxLoopbackIterations`, so the run failed
 * with `cycle_detected` 3 ms after creation. The fixture was advertised anyway,
 * so the leg read `blocked` (a host defect) where the honest word is
 * `inapplicable` (the host does not run cycles).
 *
 * The fixture below is the corpus file's graph, inline, so the executor half of
 * this test does not depend on the vendored copy (the loader test reads that).
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { executeRun } from '../src/executor/executor.js';
import { fixtureGraphRefused, listLoadedConformanceFixtures } from '../src/host/index.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { RunRecord } from '../src/types.js';

/** conformance-approval-reject-loopback (2.43.1), normalised the way the loader does. */
const LOOPBACK = {
  workflowId: 'conformance-approval-reject-loopback',
  nodes: [
    { nodeId: 'start', typeId: 'core.noop', config: {} },
    { nodeId: 'gate', typeId: 'core.approvalGate', config: { actions: ['accept', 'reject'] } },
    { nodeId: 'revise', typeId: 'core.noop', config: {} },
  ],
  edges: [
    { id: 'start-gate', sourceNodeId: 'start', targetNodeId: 'gate', triggerRule: 'any_success' },
    { id: 'gate-revise', sourceNodeId: 'gate', targetNodeId: 'revise', triggerRule: 'any_failed' },
    { id: 'revise-gate', sourceNodeId: 'revise', targetNodeId: 'gate', triggerRule: 'any_success' },
  ],
  settings: { timeout: 0, maxLoopbackIterations: 2 },
} as unknown as WorkflowDefinition;

beforeAll(() => {
  ensureNodesRegistered();
});

describe('a fixture the executor refuses is not advertised', () => {
  it('the loopback fixture is refused, and the refusal is TRUE: the real executor fails it at start with cycle_detected', async () => {
    expect(fixtureGraphRefused(LOOPBACK)).toBe(true);
    const storage = await openStorage('memory://');
    setEventLogBackend(storage);
    setSuspendBackend(storage);
    initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-graph-refused-')) });
    const now = new Date().toISOString();
    const run: RunRecord = {
      runId: `run-loopback-${Math.random().toString(36).slice(2)}`, workflowId: LOOPBACK.workflowId, tenantId: 'default',
      status: 'pending', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
    };
    await storage.insertRun(run);
    expect((await executeRun(storage, run, LOOPBACK)).status).toBe('failed');
    expect(((await storage.getRun(run.runId))!.error as { code?: string } | undefined)?.code).toBe('cycle_detected');
    const events = await storage.listEvents(run.runId);
    expect(events.some((e) => e.type === 'node.started'), 'no node runs: the graph is refused before dispatch').toBe(false);
  });

  it('polarity: an RFC 0022 dispatch loop and a plain DAG are NOT refused', () => {
    const dispatchLoop = {
      workflowId: 'x',
      nodes: [{ nodeId: 'sup', typeId: 'core.dispatch', config: {} }, { nodeId: 'w', typeId: 'core.noop', config: {} }],
      edges: [{ id: 'a', sourceNodeId: 'sup', targetNodeId: 'w' }, { id: 'b', sourceNodeId: 'w', targetNodeId: 'sup' }],
    } as unknown as WorkflowDefinition;
    expect(fixtureGraphRefused(dispatchLoop)).toBe(false);
    const dag = { ...LOOPBACK, edges: LOOPBACK.edges!.slice(0, 2) } as WorkflowDefinition;
    expect(fixtureGraphRefused(dag)).toBe(false);
    // No edges ⇒ the implicit linear chain, which cannot cycle.
    expect(fixtureGraphRefused({ ...LOOPBACK, edges: undefined } as unknown as WorkflowDefinition)).toBe(false);
  });

  it('over every vendored fixture, the predicate withholds exactly the graphs the executor refuses', () => {
    const dir = join(import.meta.dirname, '..', '..', '..', 'conformance-fixtures');
    const docs = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { id?: string; workflowId?: string; nodes?: Array<{ id?: string; nodeId?: string }> };
      return { ...raw, workflowId: raw.workflowId ?? raw.id, nodes: (raw.nodes ?? []).map((n) => ({ ...n, nodeId: n.nodeId ?? n.id ?? '' })) } as unknown as WorkflowDefinition;
    });
    expect(docs.length, 'non-vacuity: fixtures are vendored').toBeGreaterThan(20);
    const refused = docs.filter((d) => fixtureGraphRefused(d)).map((d) => d.workflowId);
    const advertised = new Set(listLoadedConformanceFixtures());
    for (const id of refused) expect(advertised.has(id), `${id} is refused by the executor yet advertised`).toBe(false);
    // Anything newly refused NARROWS the advert and must be a decision, not a
    // side effect — this red is the prompt.
    //   2.43.1: the reject-loopback fixture.
    //   2.44.0: + `conformance-replay-ordinal-loop` (openwop#1745), also a cycle.
    //     DECIDED: withheld for the same reason (this host's scheduler is a DAG),
    //     so its rows record inapplicable rather than failing at run start.
    // Bounded loopback (loop row 3, openwop#1745) un-withholds BOTH.
    expect([...refused].sort()).toEqual(['conformance-approval-reject-loopback', 'conformance-replay-ordinal-loop']);
  });
});
