/**
 * WF-E2E-1 (WORKFLOWS-ASSESSMENT) — the two ADR 0472 P4 flagship workflows run
 * END TO END through the CHAIN-BACKED registration: the REAL loader loads the packs,
 * the EXACT boot registrar (`registerLegacyDefsChainBacked`) registers the same-id
 * expanded defs, the catalog resolves them, and the REAL executor + scheduler +
 * interrupt/resume machinery drives them — expansion-prefixed node ids, restored
 * launch-contract params, wire-form truthy/falsy conditions, the reject-safe
 * barrier, and the RFC 0133 host-default `subChainRef → workflowId` child dispatch
 * all exercised as they run in production.
 *
 * The legacy e2e suites proved the workflow LOGIC against the RAW defs;
 * `chain-backed-flagships.test.ts` proved the
 * expanded SHAPE structurally. This suite closes the remaining gap: the
 * expanded def actually RUNS. The only stand-ins are canned `ctx.callAI` answers (kernel,
 * channel drafts, consistency score) and a skip for production planning — everything else
 * (scheduler, conditions, interrupts, sub-workflow dispatch, feature surfaces,
 * SoD submit) is the real path.
 *
 *  (A) challenge-factory (KickTodo) lives with its owner, ADR 1031 P2:
 *      test/kicktodo/kicktodo-challenge-factory-chain-e2e.test.ts.
 *  (B) campaign-orchestration: runs to its DESIGNED human gate (kernel-approve)
 *      — the "genuine terminal state, never forced past a designed human gate"
 *      contract. The kernel is staged, not saved, until the gate is approved
 *      (ADR 1020 D8); a rejection saves nothing. Also the standalone kernel chain.
 *  (C) the orchestration past the gate: five children get the brief, only the
 *      enabled channel generates or raises a gate, consistency scores the real
 *      draft, finalize records the campaign (ADR 1020 D6).
 *  (D) the creative_briefs channel creates its briefs only after approval, and
 *      none on a rejection (ADR 1020 D14).
 *
 * Red when (w89, sabotage-witnessed): generate-kernel saves without `stageKernel`
 * (B ×3); the autonomy gate misses a `reject` (B reject); the channel generate node
 * stops skipping a disabled channel, a skipped child counts as drafted, or finalize
 * records nothing (C); the chain's `approve → create_briefs` edge moves before the
 * gate (D ×2).
 *
 * One cast remains, and it is the production seam's own: `executeRun as never` into
 * `setSubWorkflowDispatcher`, exactly as src/index.ts passes it at boot.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, afterAll } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { setChatStorage } from '../src/host/chatSurface.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { executeRun } from '../src/executor/executor.js';
import { seedRunVariables } from '../src/host/variablesRuntime.js';
import { registerFeatureSurface, __clearFeatureSurfaces } from '../src/host/featureSurfaces.js';
import {
  loadWorkflowChainPacks,
  defaultWorkflowChainPackRoots,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';
import { getChainBackedWorkflow, _resetChainBackedWorkflowsForTest } from '../src/host/chainBackedWorkflows.js';
import { registerLegacyDefsChainBacked, BACKEND_FEATURES } from '../src/features/index.js';
import { campaignOrchestrationParallel, ORCHESTRATION_ID } from '../src/features/campaign-orchestration/orchestrationWorkflow.js';
import { CHANNEL_WORKFLOWS, CHANNEL_WORKFLOW_IDS } from '../src/features/campaign-channels/channelWorkflows.js';
import { getCampaignByBrief } from '../src/features/campaign-orchestration/campaignService.js';
import { KERNEL_WORKFLOWS, KERNEL_WORKFLOW_ID } from '../src/features/campaign-brief/intelWorkflows.js';
import { listBriefs as listCreativeBriefs } from '../src/features/creative-briefs/creativeBriefsService.js';
import { __resolveAndResumeForTests, __awaitRunResumeChainForTests } from '../src/routes/interrupts.js';
import { getRunArtifact } from '../src/host/runArtifactStore.js';
import { createBrief, getBrief, setKernel } from '../src/features/campaign-brief/briefService.js';
import { createOrg, getOrg } from '../src/host/accessControlService.js';
import { configureSecretResolver } from '../src/byok/secretResolver.js';
import type { NodeContext, NodeModule, NodeOutcome, WorkflowDefinition } from '../src/executor/types.js';
import type { RunRecord } from '../src/types.js';

// ADR 0734: registerFeatureSurface() mutates a module-level registry this file
// dirtied and never cleaned up. Hygiene — leave the registry as we found it.
// NOT a cross-file fix: vitest forks a fresh process per test file (measured),
// so this residue could never have reached another file. See the ADR's
// correction note before citing this as protection.
afterAll(() => { __clearFeatureSurfaces(); });

const briefPackUrl = new URL('../../../packs/feature.campaign-brief.nodes/index.mjs', import.meta.url).href;
const orchestrationPackUrl = new URL('../../../packs/feature.campaign-orchestration.nodes/index.mjs', import.meta.url).href;
const channelsPackUrl = new URL('../../../packs/feature.campaign-channels.nodes/index.mjs', import.meta.url).href;

/** What a pack node function returns (packs are untyped `.mjs`): `success` with
 *  outputs, or a non-success with an optional `{code, message}`. A pack SUSPENDS by
 *  throwing from `ctx.suspend`, which reaches the executor untouched. */
interface PackResult { status?: string; outputs?: unknown; error?: { code?: unknown; message?: unknown } }
type NodeFn = (ctx: object) => Promise<PackResult>;
interface PackNodes { nodes: Record<string, NodeFn> }

const storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initHostExtPersistence(storage);
const dataDir = mkdtempSync(join(tmpdir(), 'openwop-cb-e2e-'));
initInMemorySurfaces({ dataDir });
// Boot parity: the REAL secret resolver (fail-closed) and chat storage, as
// src/index.ts wires them before any run.
configureSecretResolver({ storage, dataDir });
setChatStorage(storage);

const hostSuite = createHostAdapterSuite({ storage });

beforeAll(async () => {
  // Boot parity (src/index.ts): the build-N `core.subWorkflow` nodes dispatch their
  // child through this seam — without it every child dispatch fails internal_error.
  const { setSubWorkflowDispatcher } = await import('../src/executor/subWorkflowDispatcher.js');
  setSubWorkflowDispatcher({ storage, hostSuite, executeRun: executeRun as never });
  // Boot parity (src/index.ts): a child that finishes completes its parent's
  // RFC 0118 wait-all wave — the campaign fan-out (C) parks on it.
  const { registerDispatchWaitAll } = await import('../src/host/dispatchWaitAll.js');
  registerDispatchWaitAll(storage, hostSuite);
  ensureNodesRegistered();
  // Boot parity: the chain packs load through the REAL loader, then the EXACT boot
  // registrar registers both flagships chain-backed same-id (outputRoles restored).
  _resetChainRegistryForTest();
  _resetChainBackedWorkflowsForTest();
  const { errors } = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  expect(errors).toEqual([]);
  registerLegacyDefsChainBacked([campaignOrchestrationParallel]);
  // ADR 1020 D6 — the five channel children, registered as at boot.
  registerLegacyDefsChainBacked(CHANNEL_WORKFLOWS);
  registerLegacyDefsChainBacked(KERNEL_WORKFLOWS); // ADR 1020 D8 — the standalone kernel chain
  // Boot parity: feature surfaces (ctx.features.*) — no toggle defaults are
  // registered in this harness, so the gate's always-on path applies.
  for (const f of BACKEND_FEATURES) if (f.surface) registerFeatureSurface(f.surface.id, f.surface.build);

  const reg = getNodeRegistry();
  const briefPack: PackNodes = await import(briefPackUrl);
  const orchestrationPack: PackNodes = await import(orchestrationPackUrl);
  const brief = briefPack.nodes;
  const orchestration = orchestrationPack.nodes;

  // Pack fns signal failure by RETURNING {status:'failed', error}. This mirrors the
  // production pack loader's adapter (packs/tarballLoader.ts `execute`): `success`
  // keeps its outputs, anything else is a `failure` that keeps the pack's own code
  // and message. A suspend is a throw from ctx.suspend and passes through.
  const register = (typeId: string, fn: NodeFn, inject?: (ctx: NodeContext) => object) => {
    const module: NodeModule = {
      typeId,
      version: '1.0.0',
      async execute(ctx: NodeContext): Promise<NodeOutcome> {
        const r = await fn(inject ? { ...ctx, ...inject(ctx) } : ctx);
        if (r.status === 'success') return { status: 'success', outputs: r.outputs };
        const code = typeof r.error?.code === 'string' ? r.error.code : 'pack_node_error';
        const message = typeof r.error?.message === 'string' ? r.error.message : 'Pack node returned non-success outcome';
        return { status: 'failure', error: { code, message } };
      },
    };
    reg.register(module);
  };

  // ADR 0942 P2 — kernel-approve is the campaign autonomy gate. The REAL pack node:
  // with no autonomy toggle and an untagged run it is today's open approval gate.
  register('feature.campaign-orchestration.nodes.autonomy-gate', orchestration['feature.campaign-orchestration.nodes.autonomy-gate']!);
  // Campaign-brief pack nodes — validate as-is; generate-kernel with a canned kernel.
  register('feature.campaign-brief.nodes.validate', brief['feature.campaign-brief.nodes.validate']!);
  register('feature.campaign-brief.nodes.generate-kernel', brief['feature.campaign-brief.nodes.generate-kernel']!, () => ({
    callAI: async () => ({ data: { headline: 'Paint boldly', supportingStatement: 'From first wash to finished study.', primaryCta: 'Start today', tone: 'confident', proofPoints: ['Guided daily studies'] } }),
  }));
  // ADR 1020 D6 — past the kernel gate: the REAL channel generate node (canned
  // draft; it records which brief each child was handed), the REAL consistency
  // and finalize nodes, and a skip stand-in for production planning (not under test).
  const channelsPack: PackNodes = await import(channelsPackUrl);
  const channels = channelsPack.nodes;
  register('feature.campaign-channels.nodes.generate', channels['feature.campaign-channels.nodes.generate']!, (ctx) => ({
    callAI: async () => {
      const inputs: { channel?: unknown; briefId?: unknown } = ctx.inputs !== null && typeof ctx.inputs === 'object' ? ctx.inputs : {};
      channelGenerations.push({ channel: String(inputs.channel), briefId: inputs.briefId });
      if (inputs.channel === 'creative_briefs') return { data: { briefs: [{ format: 'hero-image', sceneDescription: 'A painter at an easel at dawn' }] } };
      return { data: { emails: [{ position: 1, subjectLines: ['Paint boldly this week'], body: 'Start today with guided daily studies.' }] } };
    },
  }));
  register('feature.campaign-orchestration.nodes.consistency-check', orchestration['feature.campaign-orchestration.nodes.consistency-check']!, () => ({
    callAI: async () => ({ data: { score: 90, rationale: 'same promise' } }),
  }));
  register('feature.campaign-orchestration.nodes.finalize', orchestration['feature.campaign-orchestration.nodes.finalize']!);
  // ADR 1020 D14 — the creative_briefs chain's post-approval creation step.
  register('feature.campaign-channels.nodes.create-creative-briefs', channels['feature.campaign-channels.nodes.create-creative-briefs']!);
  register('feature.production.nodes.plan-generate', async () => ({ status: 'success', outputs: { skipped: true } }));
  // ADR 1020 D8 — the kernel is saved only by promote-kernel, after the approval.
  register('feature.campaign-brief.nodes.promote-kernel', brief['feature.campaign-brief.nodes.promote-kernel']!);
});

/** ADR 1020 D6 — every channel generation that reached the model: which channel, which brief. */
const channelGenerations: Array<{ channel: string; briefId: unknown }> = [];

async function startRun(workflowId: string, tenantId: string, actingUserId: string, inputs: Record<string, unknown>, configurable: Record<string, unknown> = {}): Promise<{ run: RunRecord; def: WorkflowDefinition }> {
  const def = getChainBackedWorkflow(workflowId);
  expect(def, `${workflowId} must resolve chain-backed`).toBeTruthy();
  // The catalog's source-A resolver returns the SAME chain-backed definition —
  // what resume + sub-workflow dispatch will re-resolve by id.
  const fromCatalog = await hostSuite.workflowCatalog.getWorkflow(workflowId);
  expect(fromCatalog?.definition.workflowId).toBe(workflowId);
  expect(fromCatalog?.definition.nodes.length).toBe(def!.nodes.length);
  const now = new Date().toISOString();
  const run: RunRecord = { runId: `run-cb-e2e-${Math.random().toString(36).slice(2)}`, workflowId, tenantId, status: 'pending', inputs, metadata: { actingUserId }, configurable, createdAt: now, updatedAt: now };
  await storage.insertRun(run);
  seedRunVariables(run.runId, def!.variables, inputs);
  return { run, def: def! };
}

describe('(B) campaign-orchestration: the kernel is saved only when its gate is APPROVED (ADR 1020 D8)', () => {
  // The marketer is a real member of the brief's org: the campaign-brief surface
  // scopes a row named by id to an org the run's person may read (security fix,
  // ADR 0948 P2 review). Before it, this run read the brief by tenant alone.
  const T = 'tenant-cb-e2e-campaign';
  const MARKETER = 'user:cb-e2e-marketer';
  async function briefAndRun(name: string): Promise<{ briefId: string; runId: string }> {
    if (!(await getOrg('org-cb-e2e'))) {
      await createOrg({ tenantId: T, createdBy: MARKETER, name: 'Campaign e2e', orgId: 'org-cb-e2e', ownerSubject: MARKETER });
    }
    const brief = await createBrief(T, 'org-cb-e2e', MARKETER, {
      name,
      productName: 'Watercolor Basics',
      personaIds: ['persona-beginner'],
      messaging: { primaryValueProp: 'Paint your first watercolor in three weeks.' },
      // R2 CB-SP-13's class: 'email' is not a real channel enum — the sanitizer
      // silently DROPPED it, so this brief never had an enabled channel.
      channels: [{ type: 'email_sequence', enabled: true }],
    });
    const { run, def } = await startRun(ORCHESTRATION_ID, T, MARKETER, { briefId: brief.id });
    const result = await executeRun(storage, run, def);
    // Genuine state: the designed human gate — never forced past it.
    expect(result.status).toBe('waiting-approval');
    expect((await storage.getRun(run.runId))!.currentNodeId).toMatch(/_kernel-approve$/);
    return { briefId: brief.id, runId: run.runId };
  }
  const promoted = async (runId: string): Promise<boolean> =>
    (await storage.listEvents(runId)).some((e) => e.type === 'node.completed' && typeof e.nodeId === 'string' && /_promote-kernel$/.test(e.nodeId));

  it('at the gate nothing is saved and the reviewer sees the kernel; approving saves it and promotes the brief', async () => {
    const { briefId, runId } = await briefAndRun('Watercolor course launch');
    const open = await storage.listOpenInterrupts(runId);
    expect(open).toHaveLength(1);
    // ADR 0942 P2 — the autonomy gate in its legacy posture: an open approval.
    const gate = await storage.getInterrupt(open[0]!.interruptId);
    expect(gate?.kind).toBe('approval');
    expect(gate?.data).toBeTypeOf('object');
    expect(gate?.data).not.toHaveProperty('autonomy');
    // CS70WF-12 — before ADR 1020 the kernel was SAVED here, before anyone approved it.
    const before = await getBrief(T, briefId);
    expect(before?.kernel).toBeUndefined();
    expect(before?.status).toBe('draft');
    // …but the brief knows a kernel waits in THIS run (the page links to it).
    expect(before?.kernelReview?.runId).toBe(runId);
    // The reviewer is shown the kernel itself (the ADR 0083 gate preview of the upstream output).
    const preview = await getRunArtifact(`${runId}:${open[0]!.nodeId}`);
    expect(preview?.content ?? '').toContain('Paint boldly');

    await __resolveAndResumeForTests(storage, hostSuite, open[0]!.interruptId, { action: 'accept' });
    await __awaitRunResumeChainForTests(runId);
    expect(await promoted(runId)).toBe(true);
    const after = await getBrief(T, briefId);
    expect(after?.kernel?.headline).toBe('Paint boldly');
    expect(after?.status).toBe('validated');
    expect(after?.kernelReview).toBeUndefined();
  });

  it('the standalone messaging-kernel chain: staged at its gate, saved by promote on approval', async () => {
    if (!(await getOrg('org-cb-e2e'))) {
      await createOrg({ tenantId: T, createdBy: MARKETER, name: 'Campaign e2e', orgId: 'org-cb-e2e', ownerSubject: MARKETER });
    }
    const brief = await createBrief(T, 'org-cb-e2e', MARKETER, {
      name: 'Kernel only', productName: 'Watercolor Basics', personaIds: ['persona-beginner'],
      messaging: { primaryValueProp: 'Paint your first watercolor in three weeks.' },
      channels: [{ type: 'email_sequence', enabled: true }],
    });
    const { run, def } = await startRun(KERNEL_WORKFLOW_ID, T, MARKETER, { briefId: brief.id });
    expect((await executeRun(storage, run, def)).status).toBe('waiting-approval');
    expect((await getBrief(T, brief.id))?.kernel).toBeUndefined();
    const open = await storage.listOpenInterrupts(run.runId);
    await __resolveAndResumeForTests(storage, hostSuite, open[0]!.interruptId, { action: 'accept' });
    await __awaitRunResumeChainForTests(run.runId);
    expect((await storage.getRun(run.runId))!.status).toBe('completed');
    expect((await getBrief(T, brief.id))?.kernel?.headline).toBe('Paint boldly');
  });

  it('rejecting the gate saves nothing: no kernel, no promotion, the brief stays a draft', async () => {
    const { briefId, runId } = await briefAndRun('Watercolor course launch (rejected)');
    const open = await storage.listOpenInterrupts(runId);
    await __resolveAndResumeForTests(storage, hostSuite, open[0]!.interruptId, { action: 'reject', comment: 'Off-brand.' });
    await __awaitRunResumeChainForTests(runId);
    expect((await storage.getRun(runId))!.status).toBe('failed');
    expect(await promoted(runId)).toBe(false);
    const after = await getBrief(T, briefId);
    expect(after?.kernel).toBeUndefined();
    expect(after?.status).toBe('draft');
  });
});

describe('(C) campaign-orchestration runs PAST the kernel gate to a finalized campaign (ADR 1020 D6)', () => {
  it('every child gets the brief; a disabled channel raises no gate; consistency scores the real draft; finalize records the campaign', async () => {
    const T = 'tenant-cb-e2e-campaign-c';
    const ORG = 'org-cb-e2e-c';
    const MARKETER = 'user:cb-e2e-marketer-c';
    if (!(await getOrg(ORG))) await createOrg({ tenantId: T, createdBy: MARKETER, name: 'Campaign e2e C', orgId: ORG, ownerSubject: MARKETER });
    const brief = await createBrief(T, ORG, MARKETER, {
      name: 'Watercolor course launch',
      productName: 'Watercolor Basics',
      personaIds: ['persona-beginner'],
      messaging: { primaryValueProp: 'Paint your first watercolor in three weeks.' },
      channels: [{ type: 'email_sequence', enabled: true }],
    });
    channelGenerations.length = 0;
    const { run, def } = await startRun(ORCHESTRATION_ID, T, MARKETER, { briefId: brief.id });
    expect((await executeRun(storage, run, def)).status).toBe('waiting-approval');

    // Approve every gate the parent or any child raises, until the run settles.
    const childGates: string[] = [];
    let rounds = 0;
    // The parent waits on an approval (the kernel) or on its children (`waiting-external`, RFC 0118 wait-all).
    while (['waiting-approval', 'waiting-external'].includes((await storage.getRun(run.runId))!.status) && rounds++ < 10) {
      const runs = [run.runId, ...(await storage.listRunsByParent(run.runId)).map((c) => c.runId)];
      for (const id of runs) {
        for (const open of await storage.listOpenInterrupts(id)) {
          // The dispatch's wait-all resolves itself when the children finish.
          if ((await storage.getInterrupt(open.interruptId))?.kind !== 'approval') continue;
          if (id !== run.runId) childGates.push((await storage.getRun(id))!.workflowId);
          await __resolveAndResumeForTests(storage, hostSuite, open.interruptId, { decision: 'approved', approved: true });
          await __awaitRunResumeChainForTests(id);
        }
      }
      await __awaitRunResumeChainForTests(run.runId);
    }
    const parent = (await storage.getRun(run.runId))!;
    expect(parent.status, JSON.stringify(parent.error ?? null)).toBe('completed');

    // CS70WF-1 — all five children were dispatched with the real brief id.
    const children = await storage.listRunsByParent(run.runId);
    expect(children.map((c) => c.workflowId).sort()).toEqual([...CHANNEL_WORKFLOW_IDS].sort());
    for (const c of children) {
      expect(c.inputs, c.workflowId).toMatchObject({ briefId: brief.id });
      expect(c.status, `${c.workflowId} ${JSON.stringify(c.error ?? null)}`).toBe('completed');
    }
    // CS70WF-3 — only the enabled channel reached the model or raised a gate.
    expect(channelGenerations).toEqual([{ channel: 'email_sequence', briefId: brief.id }]);
    expect(childGates).toEqual(['campaign-studio.channel.email-sequence']);

    // CS70WF-2 — consistency scored the one real draft (never "no drafts to compare").
    const events = await storage.listEvents(run.runId);
    const consistency = events.find((e) => e.type === 'node.completed' && e.nodeId && /_consistency$/.test(e.nodeId));
    const outputs = ((consistency?.payload as { outputs?: Record<string, unknown> } | undefined)?.outputs ?? {}) as { report?: { note?: string; dimensions?: Array<{ name: string; description: string }> }; channels?: Array<{ channel: string; status: string }> };
    expect(outputs.report?.note).toBeUndefined();
    expect(outputs.report?.dimensions?.[0]?.description).toBe('1/1 drafts echo the kernel.');
    expect(outputs.channels?.filter((c) => c.status === 'drafted').map((c) => c.channel)).toEqual(['email_sequence']);
    expect(outputs.channels?.filter((c) => c.status === 'skipped')).toHaveLength(4);

    // Finalize recorded the campaign for this brief.
    const campaign = await getCampaignByBrief(T, brief.id);
    expect(campaign?.channels).toEqual(['email_sequence']);
  });
});

describe('(D) the creative_briefs channel creates its managed briefs only after its approval (ADR 1020 D14)', () => {
  const T = 'tenant-cb-e2e-creative';
  const ORG = 'org-cb-e2e-d';
  const MARKETER = 'user:cb-e2e-marketer-d';
  async function creativeRun(name: string): Promise<{ briefId: string; runId: string }> {
    if (!(await getOrg(ORG))) await createOrg({ tenantId: T, createdBy: MARKETER, name: 'Creative e2e', orgId: ORG, ownerSubject: MARKETER });
    const brief = await createBrief(T, ORG, MARKETER, {
      name, productName: 'Watercolor Basics', personaIds: ['persona-beginner'],
      messaging: { primaryValueProp: 'Paint your first watercolor in three weeks.' },
      channels: [{ type: 'creative_briefs', enabled: true }],
    });
    await setKernel(T, brief.id, { headline: 'Paint boldly', supportingStatement: 'From first wash to finished study.', proofPoints: ['Guided daily studies'], primaryCta: 'Start today', secondaryCta: '', tone: 'confident', channelTones: {}, sourceDocIds: [], generatedAt: new Date().toISOString() });
    const { run, def } = await startRun('campaign-studio.channel.creative-briefs', T, MARKETER, { briefId: brief.id });
    expect((await executeRun(storage, run, def)).status).toBe('waiting-approval');
    return { briefId: brief.id, runId: run.runId };
  }
  const managedFor = async (briefId: string) => (await listCreativeBriefs(T, ORG)).filter((b) => b.campaignBriefId === briefId);

  it('nothing is created while the draft waits; approving creates the brief', async () => {
    const { briefId, runId } = await creativeRun('Creative approve');
    expect(await managedFor(briefId)).toHaveLength(0); // CS70WF-24: they used to exist before the gate
    const open = await storage.listOpenInterrupts(runId);
    await __resolveAndResumeForTests(storage, hostSuite, open[0]!.interruptId, { action: 'accept' });
    await __awaitRunResumeChainForTests(runId);
    expect((await storage.getRun(runId))!.status).toBe('completed');
    const made = await managedFor(briefId);
    expect(made.map((b) => b.title)).toEqual(['Watercolor Basics — hero-image']);
  });

  it('rejecting the draft creates nothing', async () => {
    const { briefId, runId } = await creativeRun('Creative reject');
    const open = await storage.listOpenInterrupts(runId);
    await __resolveAndResumeForTests(storage, hostSuite, open[0]!.interruptId, { action: 'reject', comment: 'Off-brand.' });
    await __awaitRunResumeChainForTests(runId);
    expect((await storage.getRun(runId))!.status).toBe('failed');
    expect(await managedFor(briefId)).toHaveLength(0);
  });
});
