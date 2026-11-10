/**
 * RFC 0257 §B and §A.4 (ADR 1027), through the real app.
 *
 * §B — a `core.subWorkflow` whose child completed with no terminal reached:
 *  - the child run ends `completed` with `skippedTerminals`;
 *  - the parent node COMPLETES (the default `onChildFailure: fail-parent` does not
 *    apply: the child did not fail) with `childStatus: "completed"` and
 *    `childSkippedTerminals` equal to the child's list;
 *  - so the parent run completes too.
 *
 * §A.4 — replay:
 *  - a replay fork of such a run ends with the same terminal event and the same
 *    `skippedTerminals`;
 *  - a run RECORDED before this change (its log ends `run.failed`
 *    `all_terminals_skipped`) keeps that record, and a replay fork whose `fromSeq`
 *    precedes the terminal event re-derives `completed` under current code and
 *    records `replay.diverged` (`replay.md` §Divergence). That is what replay under
 *    current code means; the source run is not rewritten.
 *
 * P2 — the vendored RFC 0257 fixture `conformance-all-terminals-skipped` runs as
 * the suite drives it: its edge condition is in the WIRE shape, and the fixture
 * loader must map it (`normalizeEdgeCondition`) or the edge never fires and the
 * `ok: true` positive control wrongly reports no terminal.
 *
 * Red when (sabotage-witnessed, ADR 1027 §Witnesses; re-probed grade-tests w84
 * TST-FNA-3): the dispatcher stops reading the child's marker, or the
 * `core.subWorkflow` node stops recording it (no `childSkippedTerminals`); the
 * all-skipped state fails again (the parent fails `subworkflow_child_failed`, the
 * legacy replay does not diverge); `finalizeRun` drops the marker; divergence
 * detection stops emitting `replay.diverged`, or emits it for a faithful replay;
 * or the fixture loader stops mapping wire conditions (the positive control
 * carries a marker).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootPlanningApp, makeClient, uniqEmail, type Client, type Res } from './planningHarness.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { tryDurableStorage } from '../src/host/durable/durableStore.js';
import { bareRunId } from './support/bareRunId.js';
import type { EventRecord } from '../src/types.js';

let BASE = '';
let close: () => Promise<void>;
beforeAll(async () => { const h = await bootPlanningApp(); BASE = h.base; close = h.close; });
afterAll(async () => { await close(); });

const TERMINAL = ['completed', 'failed', 'cancelled'];
async function settle(c: Client, runId: string): Promise<string> {
  let s = '';
  // A run has no settle hook to await: poll its status until terminal.
  await vi.waitFor(async () => {
    const r: Res<{ status?: string } | null> = await c.get(`/runs/${runId}`);
    s = r.body?.status ?? '';
    expect(TERMINAL).toContain(s);
  }, { timeout: 5000, interval: 25 });
  return s;
}
const storage = () => { const s = tryDurableStorage(); if (!s) throw new Error('planning storage missing'); return s; };
const v1Events = (runId: string) => storage().listEvents(bareRunId(runId), { contract: 1 });
const completedMarker = (events: readonly EventRecord[]) =>
  (events.find((e) => e.type === 'run.completed')?.payload as { skippedTerminals?: unknown } | undefined)?.skippedTerminals;

async function login(c: Client, tag: string): Promise<void> {
  const r: Res<unknown> = await c.post('/host/openwop-app/test/login', { email: uniqEmail(tag), tenantId: `org:${tag}-${Date.now()}` });
  expect(r.status).toBe(201);
}

/** `conformance-error-route-only`: start → on-fail over `any_failed`. */
function registerErrorRouteOnly(id: string): void {
  registerWorkflow({ workflowId: id, nodes: [
    { nodeId: 'start', typeId: 'core.noop', config: {} },
    { nodeId: 'on-fail', typeId: 'core.noop', config: {} },
  ], edges: [{ edgeId: 'e1', sourceNodeId: 'start', targetNodeId: 'on-fail', triggerRule: 'any_failed' }] });
}

describe('RFC 0257 §B — a sub-workflow child that reached no terminal', () => {
  it('the child completes with the marker; the parent node completes with childStatus + childSkippedTerminals', async () => {
    const c = makeClient(() => BASE);
    await login(c, 'adr1027-sub');
    const k = Date.now();
    const child = `test.adr1027.child.${k}`;
    const parent = `test.adr1027.parent.${k}`;
    registerErrorRouteOnly(child);
    // Default onChildFailure (fail-parent): it must not fire, the child did not fail.
    registerWorkflow({ workflowId: parent, nodes: [{ nodeId: 'sub', typeId: 'core.subWorkflow', config: { workflowId: child } }], edges: [] });

    const started: Res<{ runId: string }> = await c.post('/runs', { workflowId: parent, inputs: {} });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const runId = started.body.runId;
    expect(await settle(c, runId)).toBe('completed');

    const children = await storage().listRunsByParent(bareRunId(runId));
    expect(children).toHaveLength(1);
    expect(children[0]!.status).toBe('completed');
    expect(completedMarker(await storage().listEvents(children[0]!.runId, { contract: 1 }))).toEqual(['on-fail']);

    const parentEvents = await v1Events(runId);
    const subDone = parentEvents.find((e) => e.type === 'node.completed' && e.nodeId === 'sub')?.payload as { outputs?: Record<string, unknown> } | undefined;
    expect(subDone?.outputs?.childStatus).toBe('completed');
    expect(subDone?.outputs?.childSkippedTerminals).toEqual(['on-fail']);
    // The parent's own terminal completed, so the PARENT carries no marker (§A.3).
    expect(completedMarker(parentEvents)).toBeUndefined();
  }, 30_000);
});

describe('RFC 0257 §A.4 — replay', () => {
  it('a replay fork of a no-terminal run ends with the same terminal event and the same skippedTerminals', async () => {
    const c = makeClient(() => BASE);
    await login(c, 'adr1027-replay');
    const wf = `test.adr1027.replay.${Date.now()}`;
    registerErrorRouteOnly(wf);
    const started: Res<{ runId: string }> = await c.post('/runs', { workflowId: wf, inputs: {} });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const runId = started.body.runId;
    expect(await settle(c, runId)).toBe('completed');

    const fork: Res<{ runId: string }> = await c.post(`/runs/${runId}:fork`, { mode: 'replay' });
    expect(fork.status, JSON.stringify(fork.body)).toBe(201);
    const forkId = fork.body.runId;
    expect(await settle(c, forkId)).toBe('completed');
    const forkEvents = await v1Events(forkId);
    expect(completedMarker(forkEvents)).toEqual(['on-fail']);
    expect(forkEvents.some((e) => e.type === 'run.failed')).toBe(false);
    expect(forkEvents.some((e) => e.type === 'replay.diverged'), 'a faithful replay does not diverge').toBe(false);
  }, 30_000);

  it('a run RECORDED as run.failed all_terminals_skipped keeps it; a replay from before the end completes and records replay.diverged', async () => {
    const c = makeClient(() => BASE);
    await login(c, 'adr1027-legacy');
    const wf = `test.adr1027.legacy.${Date.now()}`;
    registerErrorRouteOnly(wf);
    // A live run supplies a real, current-shape log up to the terminal event...
    const live: Res<{ runId: string }> = await c.post('/runs', { workflowId: wf, inputs: {} });
    expect(live.status, JSON.stringify(live.body)).toBe(201);
    const liveId = live.body.runId;
    expect(await settle(c, liveId)).toBe('completed');
    const liveRecord = (await storage().getRun(bareRunId(liveId)))!;
    const liveEvents = await storage().listEvents(liveRecord.runId);

    // ...and the legacy source is that log with the terminal event the host
    // recorded BEFORE RFC 0257 (#5443): run.failed all_terminals_skipped.
    const legacyBare = `${liveRecord.runId}-legacy`;
    const legacyId = `${liveId.slice(0, liveId.lastIndexOf('/'))}/${legacyBare}`;
    await storage().insertRun({ ...liveRecord, runId: legacyBare, status: 'failed' });
    const prefix = liveEvents.filter((e) => e.type !== 'run.completed' && e.type !== 'memory.written');
    await storage().appendEventsBatch(prefix.map(({ sequence: _s, eventId: _id, ...rest }) => ({ ...rest, runId: legacyBare, eventId: `${legacyBare}-${_s}` })));
    const legacyFailed: Omit<EventRecord, 'sequence'> = {
      eventId: `${legacyBare}-failed`, runId: legacyBare, type: 'run.failed', timestamp: new Date().toISOString(),
      payload: { error: { code: 'all_terminals_skipped', message: 'Every final step of this workflow was skipped by its conditions, so none of them ran (on-fail).', details: { skippedTerminals: ['on-fail'] } } },
    };
    const failed = await storage().appendEvent(legacyFailed);

    // The recorded run is not rewritten.
    expect((await storage().getRun(legacyBare))?.status).toBe('failed');
    expect((await storage().listEvents(legacyBare)).at(-1)?.type).toBe('run.failed');

    const fork: Res<{ runId: string }> = await c.post(`/runs/${legacyId}:fork`, { mode: 'replay', fromSeq: failed.sequence });
    expect(fork.status, JSON.stringify(fork.body)).toBe(201);
    const forkId = fork.body.runId;
    expect(await settle(c, forkId)).toBe('completed');
    const forkEvents = await v1Events(forkId);
    expect(completedMarker(forkEvents)).toEqual(['on-fail']);
    expect(forkEvents.some((e) => e.type === 'replay.diverged'), 'replay under current code diverges from the recorded failure').toBe(true);
    // ...and the source still says what it said.
    expect((await storage().getRun(legacyBare))?.status).toBe('failed');
  }, 30_000);
});

describe('RFC 0257 P2 — the vendored fixture, as the suite runs it', () => {
  it('conformance-all-terminals-skipped: ok:false → ["act"]; ok:true → act runs and no marker (the wire condition is mapped)', async () => {
    const c = makeClient(() => BASE);
    await login(c, 'adr1027-fixture');
    const runFixture = async (ok: boolean) => {
      const r: Res<{ runId: string }> = await c.post('/runs', { workflowId: 'conformance-all-terminals-skipped', inputs: { payload: { ok } } });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const id = r.body.runId;
      expect(await settle(c, id)).toBe('completed');
      return v1Events(id);
    };
    const declined = await runFixture(false);
    expect(completedMarker(declined)).toEqual(['act']);
    const control = await runFixture(true);
    expect(control.some((e) => e.type === 'node.completed' && e.nodeId === 'act'), 'the truthy edge must fire on ok:true').toBe(true);
    expect(completedMarker(control)).toBeUndefined();
  }, 30_000);
});
