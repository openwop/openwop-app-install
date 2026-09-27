/**
 * ADR 0473 Phase 1 — the propose→review→approve-to-run lane. Pins:
 *  - propose registers a transient draft + a `composed-workflow` hold and
 *    starts NO run (structural: the tool has no run-starter deps);
 *  - claim approves → the run starts via the shared recipe, runId attached,
 *    the approve response echoes it;
 *  - approve-what-you-see: a builder edit after propose ⇒ 409 `proposal_stale`
 *    and the approval REOPENS (pending again) — including an edit landing in
 *    the pre-check→CAS window; a mismatched client `expectedDefinitionHash`
 *    refuses the same way;
 *  - expired proposals refuse the claim (`proposal_expired`), nothing runs;
 *  - concurrent claims: exactly one winner (the CAS lock);
 *  - reject archives the draft (resolvable, catalog-hidden) + keeps the note;
 *  - the transient cap and the shared validation/refusal pipeline apply.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import type { Storage } from '../src/storage/storage.js';
import {
  registerWorkflowProposeTool,
  registerComposedWorkflowDecisionHandler,
  sweepExpiredWorkflowProposals,
  definitionHashOf,
  PROPOSE_TOOL_ID,
} from '../src/host/workflowComposeTool.js';
import { __runTransientDefGcOnce } from '../src/host/runRetentionSweeper.js';
import { __setNodeRolesForTests } from '../src/host/nodeCatalogBuilder.js';
import { setProposalAutoApprovePolicy, clearProposalAutoApprovePolicy } from '../src/host/workflowProposalPolicy.js';
import { withLifecycle } from '../src/host/workflowLifecycle.js';
import { claimApproval, rejectApproval } from '../src/host/approvalDecision.js';
import { getApproval, eraseApprovalSubject } from '../src/host/approvalService.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import {
  getRegisteredWorkflow,
  registerWorkflow,
  deleteRegisteredWorkflow,
  listRegisteredWorkflows,
} from '../src/host/workflowsRegistry.js';
import { lifecycleOf } from '../src/host/workflowLifecycle.js';
import { listOwned, removeOwnership } from '../src/host/workflowOwnership.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { ensureSuspendManagerInstalled } from '../src/bootstrap/suspend.js';
import { ensureEventLogInstalled } from '../src/bootstrap/eventLog.js';
import { ensureInvocationLogInstalled } from '../src/bootstrap/invocationLog.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { OpenwopError } from '../src/types.js';
import { approvalToReview, withComposedLiveView } from '../src/host/reviewProjection.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TENANT = 'org:propose-test';
let storage: Storage;
let deps: { storage: Storage; hostSuite: ReturnType<typeof createHostAdapterSuite> };
let runTool: (input: Record<string, unknown>) => Promise<{ content: string; isError?: boolean }>;
const registered: string[] = [];

beforeAll(async () => {
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-propose-')) });
  ensureNodesRegistered();
  ensureSuspendManagerInstalled(storage);
  ensureEventLogInstalled(storage);
  ensureInvocationLogInstalled(storage);
  const hostSuite = createHostAdapterSuite({ storage });
  deps = { storage, hostSuite };
  registerWorkflowProposeTool({ workflowCatalog: hostSuite.workflowCatalog });
  registerComposedWorkflowDecisionHandler(deps);
  const provider = createAgentToolProvider({ tenantId: TENANT, agentProfileId: 'architect-under-test' });
  runTool = async (input) => provider.executeTool({ name: PROPOSE_TOOL_ID, input });
});
afterEach(async () => {
  for (const id of registered.splice(0)) {
    deleteRegisteredWorkflow(id);
    await removeOwnership(TENANT, id); // the cap counts ownership rows
  }
});

const NODES = [{ nodeId: 'a', typeId: 'core.noop' }];
const parse = (r: { content: string }) => JSON.parse(r.content) as Record<string, unknown>;

/** Propose a trivial workflow; return {workflowId, approvalId}. */
async function propose(extra: Record<string, unknown> = {}): Promise<{ workflowId: string; approvalId: string }> {
  const r = await runTool({ definition: { nodes: NODES }, summary: 'test proposal', ...extra });
  expect(r.isError).toBeUndefined();
  const body = parse(r);
  const workflowId = body.workflowId as string;
  registered.push(workflowId);
  return { workflowId, approvalId: body.approvalId as string };
}

const ctx = { tenantId: TENANT, decidedBy: 'user:reviewer' };

/** Wait until the dispatched run reaches a terminal state (bounded). */
async function waitForRun(runId: string): Promise<string> {
  for (let i = 0; i < 100; i += 1) {
    const run = await storage.getRun(runId);
    if (run && run.status !== 'pending' && run.status !== 'running') return run.status;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error('run did not settle');
}

describe('workflows.propose (ADR 0473 Phase 1)', () => {
  it('propose registers a catalog-hidden transient draft + a pending hold and starts NO run', async () => {
    const { workflowId, approvalId } = await propose({ inputs: { greeting: 'hi' } });

    // Nothing ran: the tool result says so and no run references the workflow.
    expect(await storage.hasRunForWorkflow(workflowId)).toBe(false);

    // The draft: registered, transient, catalog-hidden, tenant-owned.
    const def = getRegisteredWorkflow(workflowId);
    expect(def).toBeDefined();
    expect(lifecycleOf(def!).transient).toBe(true);
    expect(listRegisteredWorkflows().some((d) => d.workflowId === workflowId)).toBe(false);
    expect((await listOwned(TENANT)).some((o) => o.workflowId === workflowId)).toBe(true);

    // The hold: pending, kind-tagged, hash-pinned, inputs frozen, TTL stamped.
    const approval = await getApproval(approvalId);
    expect(approval?.status).toBe('pending');
    expect(approval?.kind).toBe('composed-workflow');
    expect(approval?.workflowId).toBe(workflowId);
    expect(approval?.composedWorkflow?.definitionHash).toBe(definitionHashOf(def!));
    expect(approval?.composedWorkflow?.runInputs).toEqual({ greeting: 'hi' });
    expect(approval?.composedWorkflow?.agentProfileId).toBe('architect-under-test');
    expect(Date.parse(approval?.composedWorkflow?.expiresAt ?? '')).toBeGreaterThan(Date.now());
  });

  it('dryRun validates without registering, owning, or proposing', async () => {
    const r = await runTool({ definition: { nodes: NODES }, dryRun: true });
    const body = parse(r);
    expect(body.valid).toBe(true);
    expect(getRegisteredWorkflow(body.workflowId as string)).toBeUndefined();
    expect((await listOwned(TENANT)).some((o) => o.workflowId === body.workflowId)).toBe(false);
  });

  it('an INVALID definition stores nothing (shared pipeline)', async () => {
    const r = await runTool({ definition: { workflowId: 'agent-bad-p1', nodes: 'nope' } });
    expect(r.isError).toBe(true);
    expect(getRegisteredWorkflow('agent-bad-p1')).toBeUndefined();
  });

  it('claim approves → the run starts, runId attaches, and the response echoes it', async () => {
    const { workflowId, approvalId } = await propose();
    const result = await claimApproval(deps, ctx, approvalId);
    expect(result.status).toBe('approved');
    expect(result.runId).toBeTruthy();
    const approval = await getApproval(approvalId);
    expect(approval?.status).toBe('approved');
    expect(approval?.runId).toBe(result.runId);
    // Decide attribution rides the audit chain (resolveApproval threads
    // `decidedBy` into the GOVERNANCE_DECISION entry, not onto the row).
    const run = await storage.getRun(result.runId!);
    expect(run?.workflowId).toBe(workflowId);
    expect((run?.metadata as { approval?: { approvalId?: string } })?.approval?.approvalId).toBe(approvalId);
    await waitForRun(result.runId!);
  });

  it('approve-what-you-see: a builder edit after propose ⇒ 409 proposal_stale and the hold REOPENS', async () => {
    const { workflowId, approvalId } = await propose();
    // Simulate a builder edit: re-register the draft with an extra node.
    const def = getRegisteredWorkflow(workflowId)!;
    const edited: WorkflowDefinition = { ...def, nodes: [...def.nodes, { nodeId: 'b', typeId: 'core.noop' }] } as WorkflowDefinition;
    registerWorkflow(edited);

    await expect(claimApproval(deps, ctx, approvalId)).rejects.toMatchObject({ details: { reason: 'proposal_stale' } });
    // The definitive check runs AFTER the CAS — the compensation must reopen.
    expect((await getApproval(approvalId))?.status).toBe('pending');
    expect(await storage.hasRunForWorkflow(workflowId)).toBe(false);
  });

  it('a mismatched client expectedDefinitionHash refuses the same way', async () => {
    const { workflowId, approvalId } = await propose();
    await expect(
      claimApproval(deps, { ...ctx, expectedDefinitionHash: 'not-what-the-card-showed' }, approvalId),
    ).rejects.toMatchObject({ details: { reason: 'proposal_stale' } });
    expect((await getApproval(approvalId))?.status).toBe('pending');
    expect(await storage.hasRunForWorkflow(workflowId)).toBe(false);
  });

  it('a matching client expectedDefinitionHash approves', async () => {
    const { workflowId, approvalId } = await propose();
    const hash = definitionHashOf(getRegisteredWorkflow(workflowId)!);
    const result = await claimApproval(deps, { ...ctx, expectedDefinitionHash: hash }, approvalId);
    expect(result.status).toBe('approved');
    await waitForRun(result.runId!);
  });

  it('an expired proposal refuses the claim and nothing runs', async () => {
    // A sub-millisecond TTL (the env knob accepts fractional days) stamps an
    // already-past `expiresAt` at propose time — no store poking needed.
    process.env.OPENWOP_WORKFLOW_PROPOSAL_TTL_DAYS = '0.000000001';
    let held: { workflowId: string; approvalId: string };
    try {
      held = await propose();
    } finally {
      delete process.env.OPENWOP_WORKFLOW_PROPOSAL_TTL_DAYS;
    }
    // `expiresAt` is millisecond-precision; make "past" strict.
    await new Promise((res) => setTimeout(res, 10));
    await expect(claimApproval(deps, ctx, held.approvalId)).rejects.toMatchObject({ details: { reason: 'proposal_expired' } });
    expect((await getApproval(held.approvalId))?.status).toBe('pending');
    expect(await storage.hasRunForWorkflow(held.workflowId)).toBe(false);
  });

  it('concurrent claims: exactly one winner', async () => {
    const { approvalId } = await propose();
    const results = await Promise.allSettled([
      claimApproval(deps, ctx, approvalId),
      claimApproval(deps, { ...ctx, decidedBy: 'user:other' }, approvalId),
    ]);
    const wins = results.filter((r) => r.status === 'fulfilled' && (r.value as { status: string }).status === 'approved');
    const losses = results.filter((r) => r.status === 'rejected');
    expect(wins.length).toBe(1);
    expect(losses.length).toBe(1);
    expect((losses[0] as PromiseRejectedResult).reason).toBeInstanceOf(OpenwopError);
  });

  it('reject archives the draft (still resolvable) and keeps the note', async () => {
    const { workflowId, approvalId } = await propose();
    const result = await rejectApproval(deps, { ...ctx, note: 'wrong tool for this — use the CRM chain' }, approvalId);
    expect(result.status).toBe('rejected');
    const approval = await getApproval(approvalId);
    expect(approval?.status).toBe('rejected');
    expect(approval?.note).toBe('wrong tool for this — use the CRM chain');
    // Archived, not deleted: resolvable forever (the ADR 0369 replay law).
    const def = getRegisteredWorkflow(workflowId);
    expect(def).toBeDefined();
    expect(lifecycleOf(def!).archivedAt).toBeTruthy();
    const owned = (await listOwned(TENANT)).find((o) => o.workflowId === workflowId);
    expect(owned?.archivedAt).toBeTruthy();
    expect(await storage.hasRunForWorkflow(workflowId)).toBe(false);
  });

  it('a decided proposal cannot be re-decided (CAS finality)', async () => {
    const { approvalId } = await propose();
    await claimApproval(deps, ctx, approvalId);
    await expect(claimApproval(deps, ctx, approvalId)).rejects.toMatchObject({ code: 'conflict' });
    await expect(rejectApproval(deps, ctx, approvalId)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('approve-what-you-see (F1): an edited draft APPROVES when the client hash matches the LIVE definition', async () => {
    const { workflowId, approvalId } = await propose();
    const def = getRegisteredWorkflow(workflowId)!;
    const edited: WorkflowDefinition = { ...def, nodes: [...def.nodes, { nodeId: 'b', typeId: 'core.noop' }] } as WorkflowDefinition;
    registerWorkflow(edited);
    // The card re-rendered the edited draft; the reviewer approved WHAT THEY SAW.
    const result = await claimApproval(deps, { ...ctx, expectedDefinitionHash: definitionHashOf(edited) }, approvalId);
    expect(result.status).toBe('approved');
    expect(result.runId).toBeTruthy();
    await waitForRun(result.runId!);
  });

  it('a catalog-shadowed id is refused at propose (F3 — dispatch would run something else)', async () => {
    const r = await runTool({ definition: { workflowId: 'openwop-app.uppercase', nodes: NODES } });
    expect(r.isError).toBe(true);
    expect(parse(r).message).toContain('already exists');
  });

  it('approve without an attributed decider is refused (F4)', async () => {
    const { workflowId, approvalId } = await propose();
    await expect(claimApproval(deps, { tenantId: TENANT }, approvalId)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await getApproval(approvalId))?.status).toBe('pending');
    expect(await storage.hasRunForWorkflow(workflowId)).toBe(false);
  });

  it('the retention sweep rejects an expired proposal and archives its draft (F5)', async () => {
    process.env.OPENWOP_WORKFLOW_PROPOSAL_TTL_DAYS = '0.000000001';
    let held: { workflowId: string; approvalId: string };
    try {
      held = await propose();
    } finally {
      delete process.env.OPENWOP_WORKFLOW_PROPOSAL_TTL_DAYS;
    }
    await new Promise((res) => setTimeout(res, 10));
    const { swept } = await sweepExpiredWorkflowProposals();
    expect(swept).toBeGreaterThanOrEqual(1);
    const approval = await getApproval(held.approvalId);
    expect(approval?.status).toBe('rejected');
    expect(approval?.note).toBe('expired');
    expect(lifecycleOf(getRegisteredWorkflow(held.workflowId)!).archivedAt).toBeTruthy();
  });

  it('the transient GC skips a draft referenced by a PENDING proposal (F7)', async () => {
    const { workflowId } = await propose();
    // The user archives the draft in the builder while the review is open —
    // zero runs, archived + transient: exactly what the GC would collect.
    const def = getRegisteredWorkflow(workflowId)!;
    registerWorkflow(withLifecycle(def, { archivedAt: new Date().toISOString() }));
    await __runTransientDefGcOnce(storage);
    expect(getRegisteredWorkflow(workflowId)).toBeDefined(); // survived: pending review references it
  });

  it('oversized run inputs are refused at propose (F8)', async () => {
    const r = await runTool({ definition: { nodes: NODES }, inputs: { blob: 'x'.repeat(20_000) } });
    expect(r.isError).toBe(true);
    expect(parse(r).message).toContain('too large');
  });

  it('erasing the acting user redacts proposal + reasoning (grade-data H1 regression)', async () => {
    // The original redactor registered EMPTY idFields with textFields —
    // structurally dead (textFields only apply on an idField match), so no
    // erasure ever touched composed-workflow prose. The acting user is now
    // stamped as composedWorkflow.proposedByUserId and matched.
    const userProvider = createAgentToolProvider({
      tenantId: TENANT, agentProfileId: 'architect-under-test', actingUserId: 'user:erase-me',
    });
    const r = await userProvider.executeTool({
      name: PROPOSE_TOOL_ID,
      input: { definition: { nodes: NODES }, summary: 'quotes user:erase-me verbatim', reasoning: 'because user:erase-me asked for it' },
    });
    expect(r.isError).toBeUndefined();
    const body = parse(r);
    registered.push(body.workflowId as string);
    const approvalId = body.approvalId as string;

    const touched = await eraseApprovalSubject(TENANT, 'user:erase-me');
    expect(touched).toBeGreaterThan(0);
    const after = await getApproval(approvalId);
    expect(after?.proposal).toBe('[erased]');
    expect(after?.reasoning).toBe('[erased]');
    expect(after?.composedWorkflow?.proposedByUserId).toBe('[erased]');
  });

  it('the transient cap refuses further proposals', async () => {
    process.env.OPENWOP_AGENT_TRANSIENT_WORKFLOWS_MAX = '1';
    try {
      await propose();
      const r = await runTool({ definition: { nodes: NODES } });
      expect(r.isError).toBe(true);
      // ADR 0595 §Correction 7 — one shared refusal message across both doors.
      expect(parse(r).message).toMatch(/unsaved AI-generated drafts/i);
      expect(parse(r).message).toMatch(/archive/i);
    } finally {
      delete process.env.OPENWOP_AGENT_TRANSIENT_WORKFLOWS_MAX;
    }
  });

  it('the review projection carries the LIVE view: hash, edited flag, steps with roles (Phase 2)', async () => {
    const { workflowId, approvalId } = await propose();
    const approval = (await getApproval(approvalId))!;
    let review = await withComposedLiveView(approvalToReview(approval), approval);
    expect(review.kind).toBe('composed-workflow');
    expect(review.composedWorkflow?.liveDefinitionHash).toBe(review.composedWorkflow?.definitionHash);
    expect(review.composedWorkflow?.editedSinceProposed).toBeUndefined();
    expect(review.composedWorkflow?.steps?.length).toBe(1);
    expect(review.composedWorkflow?.steps?.[0]).toMatchObject({ nodeId: 'a', typeId: 'core.noop' });
    expect(review.actions.map((a) => a.action).sort()).toEqual(['approve', 'reject']);

    // Builder edit → the projection flags it and the live hash moves.
    const def = getRegisteredWorkflow(workflowId)!;
    const edited: WorkflowDefinition = { ...def, nodes: [...def.nodes, { nodeId: 'b', typeId: 'core.noop' }] } as WorkflowDefinition;
    registerWorkflow(edited);
    const after = (await getApproval(approvalId))!;
    review = await withComposedLiveView(approvalToReview(after), after);
    expect(review.composedWorkflow?.editedSinceProposed).toBe(true);
    expect(review.composedWorkflow?.liveDefinitionHash).toBe(definitionHashOf(edited));
  });

  it('an expired proposal projects as expired with NO actions (Phase 2)', async () => {
    process.env.OPENWOP_WORKFLOW_PROPOSAL_TTL_DAYS = '0.000000001';
    let held: { workflowId: string; approvalId: string };
    try {
      held = await propose();
    } finally {
      delete process.env.OPENWOP_WORKFLOW_PROPOSAL_TTL_DAYS;
    }
    await new Promise((res) => setTimeout(res, 10));
    const expiredRow = (await getApproval(held.approvalId))!;
    const review = await withComposedLiveView(approvalToReview(expiredRow), expiredRow);
    expect(review.status).toBe('expired');
    expect(review.actions).toEqual([]);
    expect(review.composedWorkflow?.expired).toBe(true);
  });
});

describe('proposal auto-approval policy (ADR 0473 Phase 5)', () => {
  afterEach(async () => {
    __setNodeRolesForTests(null);
    await clearProposalAutoApprovePolicy(TENANT, 'architect-under-test');
  });

  it('a policy-named agent with ALL read-only nodes auto-approves through the decision core', async () => {
    __setNodeRolesForTests({ 'core.noop': 'read' });
    await setProposalAutoApprovePolicy({ tenantId: TENANT, agentProfileId: 'architect-under-test', createdBy: 'user:super' });
    const r = await runTool({ definition: { nodes: NODES }, summary: 'read-only digest' });
    const body = parse(r);
    registered.push(body.workflowId as string);
    expect(body.status).toBe('auto_approved');
    expect(body.runId).toBeTruthy();
    const approval = await getApproval(body.approvalId as string);
    expect(approval?.status).toBe('approved');
    expect(approval?.runId).toBe(body.runId);
    await waitForRun(body.runId as string);
  });

  it('ANY non-read-only node blocks auto-approval (fail-closed on unclassified)', async () => {
    __setNodeRolesForTests({ 'core.noop': 'side-effect' });
    await setProposalAutoApprovePolicy({ tenantId: TENANT, agentProfileId: 'architect-under-test', createdBy: 'user:super' });
    const r = await runTool({ definition: { nodes: NODES } });
    const body = parse(r);
    registered.push(body.workflowId as string);
    expect(body.status).toBe('pending_approval');
    expect((await getApproval(body.approvalId as string))?.status).toBe('pending');

    // Undeclared role (empty map) is equally blocking — unknown is not read.
    __setNodeRolesForTests({});
    const r2 = await runTool({ definition: { nodes: NODES } });
    const body2 = parse(r2);
    registered.push(body2.workflowId as string);
    expect(body2.status).toBe('pending_approval');
  });

  it('no policy ⇒ pending, even for all-read-only nodes', async () => {
    __setNodeRolesForTests({ 'core.noop': 'read' });
    const r = await runTool({ definition: { nodes: NODES } });
    const body = parse(r);
    registered.push(body.workflowId as string);
    expect(body.status).toBe('pending_approval');
  });
});
