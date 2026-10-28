/**
 * SECURITY — a sub-workflow child's gate, mirrored onto its parent, cannot be resolved
 * directly (host/subWorkflowMirrorGuard.ts).
 *
 * Before the guard, an approver resolving the PARENT's mirror interrupt made the
 * executor mark `core.subWorkflow` completed with `{output: resumeValue}`, with no
 * child outcome and no `outputMapping`. The parent ran on while the child still waited
 * at its own gate: the approver fabricated the child step's completion.
 *
 * Legs, through the real app:
 *  1. The node route (the human lane): 409 `subworkflow_child_mirror`; the parent stays
 *     waiting and its downstream node never runs.
 *  2. The shared resolve choke point (token, /reviews, email and MCP all go through it): refused.
 *  3. The MCP `resumeInterrupt` lane: refused with the reason, and the interrupt stays open.
 *  4. Today's nested-gate behaviour is unchanged: the CHILD's gate is decidable and
 *     completes the child; the parent stays waiting (stranded until the planned resume cascade); cancel works.
 *  5. Precision: a plain `core.interrupt` whose author copied the marker data is still
 *     resolvable (no real child run points back at it).
 *
 * BORN RED: with the guard removed, leg 1's resolve returns 2xx and the parent's
 * downstream node runs.
 *
 * Sabotage-witnessed (wave 64): the guard itself (8fw5g1-sm-guard → legs 1–3), the
 * shared choke point (sm-choke → legs 1–2), the MCP lane's own check (sm-mcp → leg 3),
 * and both halves of the precision rule — the child lookup (sm-precision-lookup) and
 * the `parentRunId` comparison (sm-precision-parent-r2 → leg 5, which now points the
 * look-alike's marker at a REAL run that is not its child; with a nonexistent id the
 * `!child` arm answered first and the comparison was never reached).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client } from './planningHarness.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import type { Principal } from '../src/types.js';
import { tryDurableStorage } from '../src/host/durable/durableStore.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import { __resolveAndResumeForTests } from '../src/routes/interrupts.js';
import { resumeInterrupt } from '../src/host/mcpSemantics.js';
import { bareRunId } from './support/bareRunId.js';
import { toWireRunId } from '../src/host/v2Ids.js';

let BASE = '';
let closeApp: () => Promise<void>;
let n = 0;
const client = (): Client => makeClient(() => BASE);

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; closeApp = h.close;
  delete process.env.OPENWOP_DEMO_MODE;
  await enableToggle('users', 'on');
});
afterAll(async () => { await closeApp(); });

const TERMINAL = ['completed', 'failed', 'cancelled'];

async function owner(): Promise<Client> {
  const c = client();
  const r = await c.post('/host/openwop-app/test/login', { email: uniqEmail('mirror'), tenantId: `org:mirror-${Date.now()}-${n++}` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return c;
}

/** A parent whose sub-workflow child stops at an approval gate, then a downstream node. */
function register(): { parent: string; child: string } {
  const k = n++;
  const child = `test.mirror.child.${k}`;
  const parent = `test.mirror.parent.${k}`;
  registerWorkflow({ workflowId: child, nodes: [{ nodeId: 'gate', typeId: 'core.approvalGate', config: { prompt: 'Approve the child step?' } }], edges: [] });
  registerWorkflow({
    workflowId: parent,
    nodes: [
      { nodeId: 'sub', typeId: 'core.subWorkflow', config: { workflowId: child, waitForCompletion: true, onChildFailure: 'fail-parent' } },
      { nodeId: 'after', typeId: 'core.noop', config: {} },
    ],
    edges: [{ edgeId: 'e1', sourceNodeId: 'sub', targetNodeId: 'after' }],
  });
  return { parent, child };
}

async function status(c: Client, runId: string): Promise<string> {
  return ((await c.get(`/runs/${runId}`)).body?.status ?? '') as string;
}
async function waitFor(c: Client, runId: string, want: (s: string) => boolean): Promise<string> {
  let s = '';
  // A run has no settle hook to await: poll the snapshot until the condition holds.
  await vi.waitFor(async () => { s = await status(c, runId); expect(want(s), `run ${runId} is ${s}`).toBe(true); }, { timeout: 5000, interval: 25 });
  return s;
}

/** Start the parent and return it suspended on the mirror, with the child's run id. */
async function suspendedParent(c: Client): Promise<{ runId: string; mirrorId: string; childRunId: string }> {
  const { parent } = register();
  const started = await c.post('/runs', { workflowId: parent, inputs: {} });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const runId = started.body.runId as string;
  expect(await waitFor(c, runId, (s) => s.startsWith('waiting') || TERMINAL.includes(s))).toBe('waiting-approval');
  const storage = tryDurableStorage()!;
  const open = await storage.listOpenInterrupts(bareRunId(runId));
  expect(open).toHaveLength(1);
  const mirror = open[0]!;
  const bareChild = (mirror.data as { childRunId: string }).childRunId;
  expect(bareChild).toBeTruthy();
  // The interrupt data carries the stored (bare) id; the protocol path takes the tenant-bound one.
  const tenantId = (await storage.getRun(bareRunId(runId)))!.tenantId;
  return { runId, mirrorId: mirror.interruptId, childRunId: toWireRunId(bareChild, tenantId) };
}

/** The node event types the run log holds for `nodeId` (the executor's own record of what ran). */
const nodeEvents = async (runId: string, nodeId: string): Promise<string[]> =>
  (await tryDurableStorage()!.listEvents(bareRunId(runId))).filter((e) => e.nodeId === nodeId && e.type.startsWith('node.')).map((e) => e.type);

describe('SECURITY — the parent mirror of a sub-workflow gate is not decidable', () => {
  it('leg 1: the node route refuses it, and nothing downstream runs', async () => {
    const c = await owner();
    const { runId } = await suspendedParent(c);
    const r = await c.post(`/runs/${runId}/interrupts/sub`, { resumeValue: { action: 'approve' } });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(JSON.stringify(r.body)).toContain('subworkflow_child_mirror');
    expect(await status(c, runId)).toBe('waiting-approval');
    // Control: the reader sees the parent's node events (the sub-workflow node started and suspended).
    expect(await nodeEvents(runId, 'sub')).toContain('node.suspended');
    expect(await nodeEvents(runId, 'sub'), 'the mirror was not completed').not.toContain('node.completed');
    expect(await nodeEvents(runId, 'after'), 'the fabricated completion let the parent run on').toEqual([]);
  });

  it('leg 2: the shared resolve choke point refuses it too', async () => {
    const c = await owner();
    const { runId, mirrorId } = await suspendedParent(c);
    const storage = tryDurableStorage()!;
    await expect(__resolveAndResumeForTests(storage, createHostAdapterSuite({ storage }), mirrorId, { action: 'approve' }))
      .rejects.toMatchObject({ details: { reason: 'subworkflow_child_mirror' } });
    expect((await storage.getInterrupt(mirrorId))?.resolvedAt ?? null).toBeNull();
    expect(await status(c, runId)).toBe('waiting-approval');
  });

  it('leg 3: the MCP lane refuses it with the reason, and the interrupt stays open', async () => {
    const c = await owner();
    const { mirrorId } = await suspendedParent(c);
    const storage = tryDurableStorage()!;
    // `principal`: the lane refuses before any principal-dependent step; a minimal real one.
    const principal: Principal = { principalId: 'test:mcp', tenants: [], token: '' };
    const out = await resumeInterrupt({ storage, hostSuite: createHostAdapterSuite({ storage }), principal }, mirrorId, { action: 'approve' });
    expect(out.kind).toBe('failed');
    // The lane says WHY (without its own check it would report "already resolved").
    expect((out as { text?: string }).text ?? '').toMatch(/sub-workflow/);
    expect((await storage.getInterrupt(mirrorId))?.resolvedAt ?? null, 'the interrupt must stay open').toBeNull();
  });

  it('leg 4: the child\'s own gate is decidable; the parent stays waiting (stranded until the planned resume cascade); cancel works', async () => {
    const c = await owner();
    const { runId, childRunId } = await suspendedParent(c);
    const approve = await c.post(`/runs/${childRunId}/interrupts/gate`, { resumeValue: { action: 'approve' } });
    expect(approve.status, JSON.stringify(approve.body)).toBeLessThan(300);
    expect(await waitFor(c, childRunId, (s) => TERMINAL.includes(s))).toBe('completed');
    expect(await status(c, runId), 'today: nothing resumes the parent (the planned resume cascade)').toBe('waiting-approval');
    const cancel = await c.post(`/runs/${runId}/cancel`, {});
    expect(cancel.status, JSON.stringify(cancel.body)).toBeLessThan(300);
    expect(await waitFor(c, runId, (s) => TERMINAL.includes(s))).toBe('cancelled');
  });

  it('leg 5: a plain interrupt that merely copies the marker data stays resolvable', async () => {
    const c = await owner();
    // The marker names a REAL run that is not this interrupt's child, so the guard reaches
    // its `parentRunId` comparison (a nonexistent id would be answered by `!child` first).
    const other = `test.mirror.other.${n++}`;
    registerWorkflow({ workflowId: other, nodes: [{ nodeId: 'a', typeId: 'core.noop', config: {} }], edges: [] });
    const otherRun = await c.post('/runs', { workflowId: other, inputs: {} });
    expect(otherRun.status, JSON.stringify(otherRun.body)).toBe(201);
    const realNotMine = bareRunId(otherRun.body.runId as string);
    expect(await tryDurableStorage()!.getRun(realNotMine), 'precondition: the named run exists').not.toBeNull();
    const wf = `test.mirror.lookalike.${n++}`;
    registerWorkflow({ workflowId: wf, nodes: [{ nodeId: 'ask', typeId: 'core.interrupt', config: { kind: 'approval', data: { childRunId: realNotMine, childInterruptNodeId: 'x', childStatus: 'waiting-approval' } } }], edges: [] });
    const started = await c.post('/runs', { workflowId: wf, inputs: {} });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const runId = started.body.runId as string;
    await waitFor(c, runId, (s) => s.startsWith('waiting'));
    const r = await c.post(`/runs/${runId}/interrupts/ask`, { resumeValue: { action: 'approve' } });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    expect(await waitFor(c, runId, (s) => TERMINAL.includes(s)), 'the resolved look-alike resumes and finishes').toBe('completed');
  });
});
