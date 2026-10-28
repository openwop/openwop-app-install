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
 * The legacy e2e suites proved the workflow LOGIC against the RAW defs
 * (`kicktodo-lesson-assembly.test.ts` §D drives the node adapters through a
 * slice of the real factory def); `chain-backed-flagships.test.ts` proved the
 * expanded SHAPE structurally. This suite closes the remaining gap: the
 * expanded def actually RUNS. Surface stand-ins mirror those precedents exactly (stub webResearch, a
 * canned `ctx.callAI` plan/lesson/kernel, canned sim verdicts) — everything else
 * (scheduler, conditions, interrupts, sub-workflow dispatch, feature surfaces,
 * SoD submit) is the real path.
 *
 *  (A) challenge-factory: run to COMPLETION through every approval gate; the
 *      lesson-batch child dispatches BY THE REWRITTEN SAME-ID and completes; the
 *      produced-variable bag carries `plan`/`planBrief`; the SoD publication is
 *      submitted-not-completed.
 *  (B) campaign-orchestration: runs to its DESIGNED human gate (kernel-approve)
 *      — the "genuine terminal state, never forced past a designed human gate"
 *      contract — with the kernel persisted on the brief.
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
import { seedRunVariables, snapshotRunVariables } from '../src/host/variablesRuntime.js';
import { registerFeatureSurface, __clearFeatureSurfaces } from '../src/host/featureSurfaces.js';
import {
  loadWorkflowChainPacks,
  defaultWorkflowChainPackRoots,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';
import { getChainBackedWorkflow, _resetChainBackedWorkflowsForTest } from '../src/host/chainBackedWorkflows.js';
import { registerLegacyDefsChainBacked, BACKEND_FEATURES } from '../src/features/index.js';
import { kicktodoCreatorBuiltinWorkflows, CHALLENGE_FACTORY_WORKFLOW_ID, LESSON_BATCH_WORKFLOW_ID } from '../src/features/kicktodo-creator/builtinWorkflows.js';
import { campaignOrchestrationParallel, ORCHESTRATION_ID } from '../src/features/campaign-orchestration/orchestrationWorkflow.js';
import { __resolveAndResumeForTests, __awaitRunResumeChainForTests } from '../src/routes/interrupts.js';
import { createCandidate, getCandidate } from '../src/features/kicktodo-creator/creatorService.js';
import { getPublication } from '../src/features/kicktodo-creator/publishService.js';
import { getApproval } from '../src/host/approvalService.js';
import { getRunArtifact } from '../src/host/runArtifactStore.js';
import { validateArtifact } from '../src/host/artifactTypes.js';
import { registerKicktodoCreatorArtifactTypes, CHALLENGE_LESSON_BATCH_TYPE } from '../src/features/kicktodo-creator/artifactSchemas.js';
import { createBrief, getBrief } from '../src/features/campaign-brief/briefService.js';
import { createOrg, getOrg } from '../src/host/accessControlService.js';
import { configureSecretResolver, setSecret } from '../src/byok/secretResolver.js';
import type { NodeModule, WorkflowDefinition } from '../src/executor/types.js';
import type { RunRecord } from '../src/types.js';

// ADR 0734: registerFeatureSurface() mutates a module-level registry this file
// dirtied and never cleaned up. Hygiene — leave the registry as we found it.
// NOT a cross-file fix: vitest forks a fresh process per test file (measured),
// so this residue could never have reached another file. See the ADR's
// correction note before citing this as protection.
afterAll(() => { __clearFeatureSurfaces(); });

const kicktodoPackUrl = new URL('../../../packs/feature.kicktodo.nodes/index.mjs', import.meta.url).href;
const chatPackUrl = new URL('../../../packs/vendor.myndhyve.chat/index.mjs', import.meta.url).href;
const briefPackUrl = new URL('../../../packs/feature.campaign-brief.nodes/index.mjs', import.meta.url).href;
const orchestrationPackUrl = new URL('../../../packs/feature.campaign-orchestration.nodes/index.mjs', import.meta.url).href;

type NodeFn = (ctx: Record<string, unknown>) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: unknown }>;

/** An authoritative-validator-passing plan. */
const VALID_PLAN = {
  title: 'Paint your first watercolor in three weeks',
  promise: 'Complete a simple watercolor from a reference photo.',
  audience: 'Absolute beginners',
  durationDays: 3,
  dailyMinutesBudget: 20,
  outcomes: [{ outcomeId: 'o1', measurableOutcome: 'Finish one watercolor study on 3 of 3 days', method: 'Photo of the finished study' }],
  achievements: [{ achievementId: 'a1', observableEvidence: 'Three completed studies', outcomeIds: ['o1'] }],
  days: [1, 2, 3].map((day) => ({
    day,
    stableActivityId: `study-${day}`,
    title: `Watercolor study, day ${day}`,
    actionInstruction: 'Paint a small study from the reference.',
    userFacingWhy: 'Repetition builds brush control.',
    estimatedMinutes: 15,
    achievementIds: ['a1'],
    evidencePolicy: 'photo' as const,
    // ADR 0975 D7 — with a dossier in scope the plan must cite it; c-1 is the extractor's claim below.
    claimRefs: day === 1 ? ['c-1'] : [],
  })),
};

const storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initHostExtPersistence(storage);
const dataDir = mkdtempSync(join(tmpdir(), 'openwop-cb-e2e-'));
initInMemorySurfaces({ dataDir });
// ADR 0706 — the factory run registers its BYOK ref on `configurable.credentialRefs`,
// which `prepareRunSecrets` resolves through the REAL resolver (fail-closed).
configureSecretResolver({ storage, dataDir });
setChatStorage(storage); // the factory's gates are core.chat.approvalGate (chat cards)

/** ADR 0706 — what each LLM node RECEIVED (ctx.inputs) and FORWARDED (the callAI
 *  request), keyed by node type. The frozen binding must reach every one of the
 *  four, including the sub-chain child's node, through the executor — not just
 *  the one node the chain used to wire (`generate`). */
const aiBindings = new Map<string, { inputs: Record<string, unknown>; req: Record<string, unknown> }>();
const recordAi = (typeId: string, ctx: Record<string, unknown>, req: Record<string, unknown>): void => {
  const inputs = (ctx.inputs ?? {}) as Record<string, unknown>;
  aiBindings.set(typeId, {
    inputs: { provider: inputs.provider, model: inputs.model, credentialRef: inputs.credentialRef },
    req: { provider: req.provider, model: req.model, credentialRef: req.credentialRef },
  });
};
const hostSuite = createHostAdapterSuite({ storage });
/** The day whose lesson the stand-in returns INVALID (null = none). Set only by
 *  the build-failure case below, which resets it. */
let lessonStandInBreaksDay: number | null = null;

beforeAll(async () => {
  // Boot parity (src/index.ts): the build-N `core.subWorkflow` nodes dispatch their
  // child through this seam — without it every child dispatch fails internal_error.
  const { setSubWorkflowDispatcher } = await import('../src/executor/subWorkflowDispatcher.js');
  setSubWorkflowDispatcher({ storage, hostSuite, executeRun: executeRun as never });
  ensureNodesRegistered();
  // Boot parity: the chain packs load through the REAL loader, then the EXACT boot
  // registrar registers both flagships chain-backed same-id (outputRoles restored).
  _resetChainRegistryForTest();
  _resetChainBackedWorkflowsForTest();
  const { errors } = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  expect(errors).toEqual([]);
  registerLegacyDefsChainBacked(kicktodoCreatorBuiltinWorkflows);
  registerLegacyDefsChainBacked([campaignOrchestrationParallel]);
  // Boot parity: feature surfaces (ctx.features.*) — no toggle defaults are
  // registered in this harness, so the gate's always-on path applies.
  for (const f of BACKEND_FEATURES) if (f.surface) registerFeatureSurface(f.surface.id, f.surface.build);
  // XCH-GATE-1 — the lesson checkpoint preview is a typed, registered artifact.
  registerKicktodoCreatorArtifactTypes();

  const reg = getNodeRegistry();
  const kt = ((await import(kicktodoPackUrl)) as { nodes: Record<string, NodeFn> }).nodes;
  const chat = (await import(chatPackUrl)) as { approvalGate: NodeFn };
  const brief = ((await import(briefPackUrl)) as { nodes: Record<string, NodeFn> }).nodes;
  const orchestration = ((await import(orchestrationPackUrl)) as { nodes: Record<string, NodeFn> }).nodes;

  // Pack fns signal failure by RETURNING {status:'failed', error} — the production
  // pack loader (packs/tarballLoader.ts) adapts that to the executor's 'failure'
  // outcome (anything non-success, non-suspended). Mirror it, or a 'failed' return
  // falls into the executor's suspended path and crashes on out.interrupt.
  const register = (typeId: string, fn: NodeFn, inject?: (ctx: Record<string, unknown>) => Record<string, unknown>) =>
    reg.register({
      typeId,
      version: '1.0.0',
      async execute(ctx) {
        const r = await fn(inject ? { ...(ctx as unknown as Record<string, unknown>), ...inject(ctx as unknown as Record<string, unknown>) } : (ctx as unknown as Record<string, unknown>));
        if (r.status === 'success' || r.status === 'suspended') return r as never;
        const err = (r as { error?: { code?: string; message?: string } }).error;
        return { status: 'failure', error: { code: err?.code ?? 'pack_node_error', message: err?.message ?? 'Pack node returned non-success outcome' } } as never;
      },
    } as NodeModule);

  // The REAL kicktodo pack nodes, surface-complete as-is.
  for (const t of ['research-frame', 'source-normalize', 'evidence-graph', 'plan-validate', 'checkpoint-plan', 'sim-collect', 'submit-publication', 'decompose', 'lesson-batch-preview']) {
    register(`feature.kicktodo.nodes.${t}`, kt[`feature.kicktodo.nodes.${t}`]!);
  }
  // plan-generate — REAL node fn, canned ctx.callAI returning the valid plan (§A stand-in).
  register('feature.kicktodo.nodes.plan-generate', kt['feature.kicktodo.nodes.plan-generate']!, (ctx) => ({
    callAI: async (req: Record<string, unknown>) => { recordAi('feature.kicktodo.nodes.plan-generate', ctx, req); return { data: VALID_PLAN }; },
  }));
  // lesson-batch-build (the sub-chain CHILD's node) — REAL fn, canned per-day lesson
  // passing the node's closed-world validator; the expected day echoes the prompt.
  register('feature.kicktodo.nodes.lesson-batch-build', kt['feature.kicktodo.nodes.lesson-batch-build']!, (ctx) => ({
    callAI: async (req: { systemPrompt?: string; messages?: Array<{ content?: string }> }) => {
      recordAi('feature.kicktodo.nodes.lesson-batch-build', ctx, req as Record<string, unknown>);
      // Re-grade KTF-LB-4 — read the day from the DAY PAYLOAD the node sends (the
      // schema-branch system prompt carries no `"day": N` literal), so every slot's
      // lesson echoes ITS day and the assertion below can demand every child completed.
      const payload = String(req.messages?.[0]?.content ?? '');
      const day = Number(/DAY PAYLOAD:\s*\{[^}]*?"day":\s*(\d+)/.exec(payload)?.[1] ?? NaN);
      if (!Number.isInteger(day)) throw new Error(`lesson stand-in could not read the day from the payload: ${payload.slice(0, 120)}`);
      // ADR 0458 §2.2 correction — the lesson cites the ONE claim the spine
      // recorded (c-1); the node validates the id against the evidence it received.
      if (day === lessonStandInBreaksDay) return { data: { day, title: '', body: 'too short', steps: [], claimRefs: [] } };
      return { data: { day, title: `Lesson for day ${day}`, body: 'Today you paint one small watercolor study from the reference photo, focusing on brush control.', steps: ['Paint a small study from the reference.'], claimRefs: ['c-1'] } };
    },
  }));
  // core.web.search — REAL registry node with the §A stub webResearch surface
  // (no live egress in a unit test).
  const realSearch = reg.get('core.web.search') as NodeModule;
  reg.register({
    typeId: 'core.web.search',
    version: realSearch.version,
    execute: (ctx) =>
      realSearch.execute({
        ...(ctx as unknown as Record<string, unknown>),
        webResearch: {
          search: async () => ({ results: [{ url: 'https://example.org/watercolor-guide', title: 'A beginner watercolor guide', snippet: 'Start simple.', rank: 1 }], engine: 'brave', totalResults: 1 }),
        },
      } as never),
  } as NodeModule);
  // core.web.fetch — REAL registry node with a stub webResearch surface, mirroring
  // the search stand-in above (no live egress in a unit test). ADR 0494 P2 added
  // this step: the spine now READS its sources, and `claim-extract` fails closed
  // without content, so the e2e must supply a page.
  const realFetch = reg.get('core.web.fetch') as NodeModule;
  reg.register({
    typeId: 'core.web.fetch',
    version: realFetch.version,
    execute: (ctx) =>
      realFetch.execute({
        ...(ctx as unknown as Record<string, unknown>),
        webResearch: {
          fetchBatch: async () => ({
            pages: [{
              url: 'https://example.org/watercolor-guide',
              status: 200,
              title: 'A beginner watercolor guide',
              extractedText: 'Beginners improve fastest with short daily studies of 20 minutes.',
            }],
          }),
        },
      } as never),
  } as NodeModule);
  // claim-extract — REAL node fn with a canned ctx.callAI returning one claim that
  // cites the source hash the normalize step derives (§A stand-in).
  register('feature.kicktodo.nodes.claim-extract', kt['feature.kicktodo.nodes.claim-extract']!, (ctx) => ({
    callAI: async (req: { messages?: Array<{ content?: string }> }) => {
      recordAi('feature.kicktodo.nodes.claim-extract', ctx, req as Record<string, unknown>);
      // Cite whatever hash the prompt actually offered — the node validates that
      // every cited hash was supplied, so a hard-coded one would make this stub
      // pass for the wrong reason.
      const prompt = String(req.messages?.[0]?.content ?? '');
      const hash = /hash=(\S+)/.exec(prompt)?.[1] ?? '';
      return { data: { claims: [{ claimId: 'c-1', text: 'Short daily studies of 20 minutes help beginners improve.', sourceHashes: [hash] }] } };
    },
  }));
  // claim-verify — REAL node fn; both the first and the skeptical second judgement
  // return `supports` with a span, so the entailment gate passes (ADR 0494 P2b).
  register('feature.kicktodo.nodes.claim-verify', kt['feature.kicktodo.nodes.claim-verify']!, (ctx) => ({
    callAI: async (req: Record<string, unknown>) => { recordAi('feature.kicktodo.nodes.claim-verify', ctx, req); return { data: { verdict: 'supports', span: 'short daily studies of 20 minutes' } }; },
  }));
  // The REAL core.chat.approvalGate pack node (suspends via ctx.suspend → interrupt).
  register('core.chat.approvalGate', chat.approvalGate);
  // Sim personas — a stand-in emitting the exact structured verdict shape
  // sim-collect's extractSimVerdict + recordSimulationVerdicts accept (the live
  // agent-runner needs a provider adapter + manifest agent; out of unit scope).
  reg.register({
    typeId: 'local.openwop-app.agent-runner',
    version: '1.0.0',
    execute: async (ctx) => {
      // ADR 0458 §2.2 correction — record what each persona was actually handed,
      // so the test can assert the skeptic sees the evidence (not just the brief).
      const inputs = (ctx as unknown as { inputs?: { agentId?: string; task?: string; provider?: string; model?: string; credentialRef?: string } }).inputs ?? {};
      simTasks.set(String(inputs.agentId ?? ''), String(inputs.task ?? ''));
      simBindings.set(String(inputs.agentId ?? ''), { provider: inputs.provider, model: inputs.model, credentialRef: inputs.credentialRef });
      return { status: 'success', outputs: { result: { verdict: 'pass', findings: [], personaSummary: 'clear' } } } as never;
    },
  } as NodeModule);
  // ADR 0942 P2 — kernel-approve is the campaign autonomy gate. The REAL pack node:
  // with no autonomy toggle and an untagged run it is today's open approval gate.
  register('feature.campaign-orchestration.nodes.autonomy-gate', orchestration['feature.campaign-orchestration.nodes.autonomy-gate']!);
  // Campaign-brief pack nodes — validate as-is; generate-kernel with a canned kernel.
  register('feature.campaign-brief.nodes.validate', brief['feature.campaign-brief.nodes.validate']!);
  register('feature.campaign-brief.nodes.generate-kernel', brief['feature.campaign-brief.nodes.generate-kernel']!, () => ({
    callAI: async () => ({ data: { headline: 'Paint boldly', supportingStatement: 'From first wash to finished study.', primaryCta: 'Start today', tone: 'confident', proofPoints: ['Guided daily studies'] } }),
  }));
});

/** ADR 0458 §2.2 correction — the task text each sim persona received (agentId → task). */
const simTasks = new Map<string, string>();
/** XCH-SIM-4 — the AI binding each sim persona was dispatched with (agentId → binding). */
const simBindings = new Map<string, { provider?: string; model?: string; credentialRef?: string }>();

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

describe('(A) challenge-factory runs to COMPLETION chain-backed (RFC 0133 + 0134 + produced vars)', () => {
  it('research → gates → sub-chain child dispatch → reject-safe barrier → SoD submit', async () => {
    const T = 'tenant-cb-e2e';
    const AUTHOR = 'user:cb-e2e-author';
    const candidate = await createCandidate({
      tenantId: T, createdBy: AUTHOR, topic: 'Watercolor painting basics', audience: 'absolute beginners',
      transformation: '', durationDaysTarget: 3, dailyMinutesTarget: 15,
    });
    // ADR 0706 — the run tool freezes the workspace's AI binding at ignition: the
    // three run inputs PLUS the ref registered on `configurable.credentialRefs`
    // (an input alone never reaches dispatch — host/runCredentials.ts). Two Google
    // keys are provisioned and the SECOND is bound, so a prefix-ladder guess
    // (`google:one` sorts first) would be visibly wrong.
    await setSecret('google:one', 'test-gemini-key-one', { tenantId: T });
    await setSecret('google:two', 'test-gemini-key-two', { tenantId: T });
    const AI = { provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'google:two' };
    const { run, def } = await startRun(CHALLENGE_FACTORY_WORKFLOW_ID, T, AUTHOR, {
      candidateId: candidate.id, topic: 'Watercolor painting basics', audience: 'absolute beginners', authorSubject: AUTHOR,
      ...AI,
    }, { credentialRefs: ['google:two'] });

    const first = await executeRun(storage, run, def);
    expect(first.status).toBe('waiting-approval');
    // The suspend happened on the EXPANSION-PREFIXED outline gate node.
    const firstOpen = await storage.listOpenInterrupts(run.runId);
    expect(firstOpen).toHaveLength(1);
    expect((await storage.getRun(run.runId))!.currentNodeId).toMatch(/_outline-approve$/);

    // Approve every gate the run raises (outline-approve, then each live gate-N).
    // XCH-GATE-1 — what each lesson checkpoint shows its approver. It used to be
    // the sub-workflow's `{childRunId, childStatus}`: the batch was approved blind.
    // Sabotage: dropping gate-N's `artifact` input (or build-N's outputMapping)
    // leaves an untyped preview and reds every assertion in the loop below.
    const lessonGatePreviews: Array<{ artifactTypeId?: string; content: string }> = [];
    let outlinePreviewed = false;
    let rounds = 0;
    while ((await storage.getRun(run.runId))!.status === 'waiting-approval' && rounds++ < 8) {
      for (const open of await storage.listOpenInterrupts(run.runId)) {
        // XCH-GATE-1 (outline half) — the outline gate previews a typed plan.
        if (/_outline-approve$/.test(open.nodeId)) {
          const row = await getRunArtifact(`${run.runId}:${open.nodeId}`);
          expect(row?.artifactTypeId, 'the outline gate must preview a typed challenge plan').toBe('kicktodo.challenge-plan');
          expect(JSON.parse(row!.content)).toEqual(VALID_PLAN);
          outlinePreviewed = true;
        }
        if (/_gate-\d$/.test(open.nodeId)) {
          const row = await getRunArtifact(`${run.runId}:${open.nodeId}`);
          expect(row, `${open.nodeId} persisted no gate preview`).toBeTruthy();
          lessonGatePreviews.push({ ...(row!.artifactTypeId ? { artifactTypeId: row!.artifactTypeId } : {}), content: row!.content });
        }
        await __resolveAndResumeForTests(storage, hostSuite, open.interruptId, { decision: 'approved', approved: true });
      }
      await __awaitRunResumeChainForTests(run.runId);
    }
    expect((await storage.getRun(run.runId))!.status).toBe('completed');
    expect(outlinePreviewed).toBe(true);
    expect(lessonGatePreviews.length).toBeGreaterThan(0);
    const shownDays: number[] = [];
    for (const p of lessonGatePreviews) {
      expect(p.artifactTypeId).toBe(CHALLENGE_LESSON_BATCH_TYPE);
      const payload = JSON.parse(p.content) as { lessons: Array<{ day: number; title: string; body: string; plan: { actionInstruction: string } }>; count: number };
      expect(validateArtifact(CHALLENGE_LESSON_BATCH_TYPE, payload).valid).toBe(true);
      expect(payload.count).toBe(payload.lessons.length);
      for (const l of payload.lessons) {
        // The lesson the approver reads, beside the plan row it was built from (XCH-LB-3).
        expect(l.body.length).toBeGreaterThan(0);
        expect(l.plan.actionInstruction.length).toBeGreaterThan(0);
        shownDays.push(l.day);
      }
    }
    // Every planned day was shown at some checkpoint, each exactly once.
    expect([...shownDays].sort((a, b) => a - b)).toEqual([1, 2, 3]);

    // The RFC 0133 host-default bind ACTUALLY dispatched: a build-N node completed
    // with a child run of the SAME-ID lesson-batch workflow, and the child completed.
    const events = await storage.listEvents(run.runId);
    const buildCompleted = events.filter((e) => e.type === 'node.completed' && e.nodeId && /_build-\d$/.test(e.nodeId));
    expect(buildCompleted.length).toBeGreaterThan(0);
    // Re-grade KTF-LB-4 — `onChildFailure: absorb` would hide a failed batch behind a
    // completed build node, so EVERY live slot's child must itself have completed
    // and built its lessons; a day-1-only stand-in used to pass here by accident.
    for (const b of buildCompleted) {
      const out = ((b.payload as { outputs?: { childRunId?: string } }).outputs ?? {});
      expect(out.childRunId, `${b.nodeId} dispatched no child`).toBeTruthy();
      const child = await storage.getRun(out.childRunId!);
      expect(child?.status, `${b.nodeId}'s child ${out.childRunId} did not complete`).toBe('completed');
    }
    const childRunId = ((buildCompleted[0]!.payload as { outputs?: { childRunId?: string } }).outputs ?? {}).childRunId;
    expect(childRunId).toBeTruthy();
    const childRun = await storage.getRun(childRunId!);
    expect(childRun?.workflowId).toBe(LESSON_BATCH_WORKFLOW_ID);
    expect(childRun?.status).toBe('completed');

    // ADR 0706 Phase-1 gate — the frozen binding reached EVERY LLM node through the
    // executor (deferred params → runtime bindings → ctx.inputs), and every node
    // FORWARDED the bound ref to callAI. Before 1.5.0 only `generate` was wired,
    // `extract-claims`/`verify-claims` had no inputs at all, and the lesson-batch
    // child chain had no provider params — so three of four dispatched on the
    // node's own 'anthropic' fallback whatever the run said.
    for (const t of ['claim-extract', 'claim-verify', 'plan-generate', 'lesson-batch-build']) {
      const rec = aiBindings.get(`feature.kicktodo.nodes.${t}`);
      expect(rec, `${t} never called callAI`).toBeTruthy();
      expect(rec!.inputs, `${t} ctx.inputs`).toEqual(AI);
      expect(rec!.req, `${t} forwarded to callAI`).toEqual(AI);
    }
    // …and the sub-chain CHILD run inherited the parent's registered ref, so its
    // own `prepareRunSecrets` resolves the same key (it used to start with an
    // EMPTY secret set and could only ever die `byok_required`).
    expect(childRun?.configurable).toEqual({ credentialRefs: ['google:two'] });
    expect(childRun?.inputs).toMatchObject(AI);
    // The run record carries the binding verbatim — what replay/fork read back.
    const parent = (await storage.getRun(run.runId))!;
    expect(parent.inputs).toMatchObject(AI);
    expect(parent.configurable).toEqual({ credentialRefs: ['google:two'] });

    // Produced variables reached the bag by name (RFC 0133 §2).
    const bag = snapshotRunVariables(run.runId) ?? {};
    expect(bag.plan).toBeTruthy();
    expect(bag.planBrief).toBeTruthy();
    // ADR 0458 §2.2 correction — the STRUCTURED evidence reached the bag and the
    // skeptic was handed it (claim id + text + source), not just the plan brief.
    const evidenceClaims = bag.evidenceClaims as Array<{ claimId: string; text: string; sources: Array<{ url: string }> }>;
    expect(evidenceClaims.map((c) => c.claimId)).toEqual(['c-1']);
    expect(evidenceClaims[0].sources[0].url).toBe('https://example.org/watercolor-guide');
    expect(String(bag.planEvidenceBrief)).toContain('[c-1] Short daily studies of 20 minutes help beginners improve.');
    expect(simTasks.get('vendor.openwop-app.kicktodo.agents.sim-skeptic')).toContain('[c-1]');
    expect(simTasks.get('vendor.openwop-app.kicktodo.agents.sim-newcomer')).not.toContain('EVIDENCE');
    // XCH-SIM-4 — every sim persona runs on the run's frozen binding, never the
    // managed tier: each declares a return schema, and the managed tier refuses
    // any request carrying a `responseSchema`.
    for (const persona of ['sim-newcomer', 'sim-time-poor', 'sim-skeptic']) {
      expect(simBindings.get(`vendor.openwop-app.kicktodo.agents.${persona}`), persona).toEqual(AI);
    }

    // SoD terminal: publication submitted, approval raised, NOTHING published in-run.
    const publication = await getPublication(T, candidate.id);
    expect(publication).toBeTruthy();
    expect(publication!.completedAt).toBeUndefined();
    expect((await getApproval(publication!.approvalId))?.kind).toBe('challenge-publish');
    expect((await getCandidate(T, candidate.id))?.state).toBe('planned');

    // ADR 0964 D1 — every build-N (a core.subWorkflow) in a REPLAY fork returns its recorded outcome and
    // re-applies its outputMapping, so NO lesson-batch child run starts again (its
    // lesson-batch-build node, which calls the model, runs only inside a child).
    // Before D1 each build-N dispatched a fresh, non-replay child.
    const forkNow = new Date().toISOString();
    const forkRun: RunRecord = {
      runId: `run-cb-e2e-fork-${Math.random().toString(36).slice(2)}`, workflowId: CHALLENGE_FACTORY_WORKFLOW_ID, tenantId: T,
      status: 'pending', inputs: parent.inputs, metadata: parent.metadata, configurable: parent.configurable,
      parentRunId: run.runId, forkMode: 'replay', createdAt: forkNow, updatedAt: forkNow,
    };
    await storage.insertRun(forkRun);
    seedRunVariables(forkRun.runId, def.variables, parent.inputs);
    await executeRun(storage, forkRun, def);
    // This from-zero harness has no inherited suspended checkpoint: the host
    // still raises its chat gates. Resolve those explicitly through the real
    // human-decision path, as for the source above. D1 proves child suppression
    // and mapped state, not automatic approval or complete gate replay.
    let replayGateRounds = 0;
    while ((await storage.getRun(forkRun.runId))?.status === 'waiting-approval' && replayGateRounds++ < 8) {
      const openGates = await storage.listOpenInterrupts(forkRun.runId);
      expect(openGates.length, 'a waiting replay must expose its human gate').toBeGreaterThan(0);
      for (const open of openGates) {
        expect(open.nodeId).toMatch(/_(?:outline-approve|gate-\d)$/);
        await __resolveAndResumeForTests(storage, hostSuite, open.interruptId, { decision: 'approved', approved: true });
      }
      await __awaitRunResumeChainForTests(forkRun.runId);
    }
    const replayed = await storage.getRun(forkRun.runId);
    expect(replayed?.status, JSON.stringify(replayed?.error)).toBe('completed');
    expect(await storage.listRunsByParent(forkRun.runId), 'a replay fork re-dispatched a lesson-batch child').toEqual([]);
    const forkBag = snapshotRunVariables(forkRun.runId) ?? {};
    const mapped = Object.keys(bag).filter((k) => /^lessonBatch/.test(k));
    expect(mapped.length, 'non-vacuity: the source mapped its lesson batches').toBeGreaterThan(0);
    for (const k of mapped) expect(forkBag[k], `${k} re-applied from the served build node`).toEqual(bag[k]);
  });
});

// XCH-GATE-1 (found building it) — a lesson batch that fails used to SKIP its
// checkpoint gate and the run went on to submit the challenge for publication:
// the executor treats a failed middle node as recoverable when every terminal
// completes or is skipped. build-fail-N now stops the run. Sabotage: deleting
// the build-fail-N edges turns this run 'completed' with a publication.
describe('(A2) a lesson batch that cannot be built stops the factory run', () => {
  it('build-N failing fails the run with checkpoint_build_failed and submits nothing', async () => {
    const T = 'tenant-cb-e2e-buildfail';
    const AUTHOR = 'user:cb-e2e-buildfail';
    const candidate = await createCandidate({
      tenantId: T, createdBy: AUTHOR, topic: 'Watercolor painting basics', audience: 'absolute beginners',
      transformation: '', durationDaysTarget: 3, dailyMinutesTarget: 15,
    });
    await setSecret('google:one', 'test-gemini-key-one', { tenantId: T });
    const AI = { provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'google:one' };
    lessonStandInBreaksDay = 2;
    try {
      const { run, def } = await startRun(CHALLENGE_FACTORY_WORKFLOW_ID, T, AUTHOR, {
        candidateId: candidate.id, topic: 'Watercolor painting basics', audience: 'absolute beginners', authorSubject: AUTHOR, ...AI,
      }, { credentialRefs: ['google:one'] });
      await executeRun(storage, run, def);
      let rounds = 0;
      while ((await storage.getRun(run.runId))!.status === 'waiting-approval' && rounds++ < 8) {
        for (const open of await storage.listOpenInterrupts(run.runId)) {
          await __resolveAndResumeForTests(storage, hostSuite, open.interruptId, { decision: 'approved', approved: true });
        }
        await __awaitRunResumeChainForTests(run.runId);
      }
      expect((await storage.getRun(run.runId))!.status).toBe('failed');
      const failed = (await storage.listEvents(run.runId)).filter((e) => e.type === 'node.failed' && /_build-fail-\d$/.test(String(e.nodeId)));
      expect(failed).toHaveLength(1);
      expect(JSON.stringify(failed[0]!.payload)).toContain('checkpoint_build_failed');
      expect(await getPublication(T, candidate.id)).toBeFalsy();
    } finally {
      lessonStandInBreaksDay = null;
    }
  });
});

describe('(B) campaign-orchestration runs to its DESIGNED human gate chain-backed', () => {
  it('validate → generate-kernel persists the kernel → suspends at the prefixed kernel-approve gate', async () => {
    const T = 'tenant-cb-e2e-campaign';
    // The marketer is a real member of the brief's org: the campaign-brief surface
    // scopes a row named by id to an org the run's person may read (security fix,
    // ADR 0948 P2 review). Before it, this run read the brief by tenant alone.
    if (!(await getOrg('org-cb-e2e'))) {
      await createOrg({ tenantId: T, createdBy: 'user:cb-e2e-marketer', name: 'Campaign e2e', orgId: 'org-cb-e2e', ownerSubject: 'user:cb-e2e-marketer' });
    }
    const brief = await createBrief(T, 'org-cb-e2e', 'user:cb-e2e-marketer', {
      name: 'Watercolor course launch',
      productName: 'Watercolor Basics',
      personaIds: ['persona-beginner'],
      messaging: { primaryValueProp: 'Paint your first watercolor in three weeks.' },
      // R2 CB-SP-13's class: 'email' is not a real channel enum — the sanitizer
      // silently DROPPED it, so this brief never had an enabled channel and only
      // the old unconditional setKernel promotion made the 'validated' assertion
      // below pass. With the real enum the brief genuinely validates.
      channels: [{ type: 'email_sequence', enabled: true }],
    });
    const { run, def } = await startRun(ORCHESTRATION_ID, T, 'user:cb-e2e-marketer', { briefId: brief.id });

    const result = await executeRun(storage, run, def);
    // Genuine terminal state: the designed human gate — never forced past it.
    expect(result.status).toBe('waiting-approval');
    expect((await storage.getRun(run.runId))!.currentNodeId).toMatch(/_kernel-approve$/);
    const open = await storage.listOpenInterrupts(run.runId);
    expect(open).toHaveLength(1);
    // ADR 0942 P2 — the gate is the autonomy gate in its legacy posture: an approval
    // with no policy block and no named approvers, exactly today's open gate.
    const gate = open[0] ? await storage.getInterrupt(open[0].interruptId) : null;
    expect(gate?.kind).toBe('approval');
    expect((gate?.data as Record<string, unknown>).autonomy).toBeUndefined();
    expect((gate?.data as Record<string, unknown>).approverRoleRefs).toBeUndefined();
    // generate-kernel REALLY persisted through the feature surface before the gate.
    const after = await getBrief(T, brief.id);
    expect(after?.kernel?.headline).toBe('Paint boldly');
    expect(after?.status).toBe('validated');
  });
});
