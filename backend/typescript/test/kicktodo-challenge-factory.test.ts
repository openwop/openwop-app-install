/**
 * ADR 0458 §2.2 — the Challenge Factory workflow, end to end.
 *
 *  (A) HAPPY PATH — every node adapter in the factory chain is driven in order
 *      against honest stand-ins (a non-stub web-search result, a validated plan
 *      from `ctx.callAI`, an approved outline gate). The candidate reaches a
 *      SUBMITTED publication with a `challenge-publish` approval raised — and NO
 *      in-run step completes publication (a distinct identity decides that).
 *
 *  (B) REJECTED PATH — the REAL `core.chat.approvalGate` node, through the REAL
 *      scheduler + resume, on a reject resolution routes the run to `core.fail`
 *      (the metaWorkflow `validate → persist` guard pattern) so the workflow
 *      FAILS TYPED and the build branch is skipped. An approve resolution runs
 *      the build branch and completes. This is the exact conditioned-edge shape
 *      the factory workflow wires (asserted structurally in (C)).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
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
import { registerWorkflow as registerHostWorkflow } from '../src/host/workflowsRegistry.js';
import { __resolveAndResumeForTests, __awaitRunResumeChainForTests } from '../src/routes/interrupts.js';
import { buildKicktodoCreatorSurface } from '../src/features/kicktodo-creator/surface.js';
import { createCandidate, getCandidate } from '../src/features/kicktodo-creator/creatorService.js';
import { getPublication } from '../src/features/kicktodo-creator/publishService.js';
import { getApproval } from '../src/host/approvalService.js';
import { kicktodoCreatorBuiltinWorkflows, CHALLENGE_FACTORY_WORKFLOW_ID } from '../src/features/kicktodo-creator/builtinWorkflows.js';
import type { WorkflowDefinition, NodeModule } from '../src/executor/types.js';
import type { RunRecord } from '../src/types.js';

const packUrl = new URL('../../../packs/feature.kicktodo.nodes/index.mjs', import.meta.url).href;
const chatUrl = new URL('../../../packs/vendor.myndhyve.chat/index.mjs', import.meta.url).href;

type NodeFn = (ctx: Record<string, unknown>) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: unknown }>;

/** A plan that genuinely passes the authoritative `validatePlan` (KTFULL-B3). */
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
  })),
};

let packNodes: Record<string, NodeFn>;
let approvalGateFn: NodeFn;

const storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initHostExtPersistence(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kt-factory-')) });
setChatStorage(storage); // the approvalGate emits a card through the chat surface
const hostSuite = createHostAdapterSuite({ storage });

beforeAll(async () => {
  ensureNodesRegistered();
  packNodes = ((await import(packUrl)) as { nodes: Record<string, NodeFn> }).nodes;
  approvalGateFn = ((await import(chatUrl)) as { approvalGate: NodeFn }).approvalGate;
});

describe('(A) the factory happy path reaches a submitted publication (ADR 0458 §2.2)', () => {
  it('drives research → search → normalize → evidence → plan → approve → validate → decompose → submit', async () => {
    const T = 'tenant-kt-factory';
    const AUTHOR = 'user:factory-author';
    const surface = buildKicktodoCreatorSurface({ tenantId: T, actingUserId: AUTHOR });
    const features = { 'kicktodo-creator': surface } as Record<string, unknown>;
    const bag = new Map<string, unknown>();
    const variables = { get: (n: string) => bag.get(n), set: (n: string, v: unknown) => bag.set(n, v) };

    const candidate = await createCandidate({
      tenantId: T, createdBy: AUTHOR, topic: 'Watercolor painting basics', audience: 'absolute beginners',
      transformation: '', durationDaysTarget: 3, dailyMinutesTarget: 15,
    });
    bag.set('candidateId', candidate.id);
    bag.set('topic', 'Watercolor painting basics');
    bag.set('audience', 'absolute beginners');
    bag.set('authorSubject', AUTHOR);

    const mkctx = (nodeId: string, inputs: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      ({ runId: 'run-factory-A', nodeId, tenantId: T, actingUserId: AUTHOR, inputs, features, variables, ...extra });

    // 1. research-frame
    const frame = await packNodes['feature.kicktodo.nodes.research-frame']!(mkctx('research-frame', { topic: 'Watercolor painting basics', audience: 'absolute beginners' }));
    expect(frame.status).toBe('success');
    const questions = (frame.outputs as { questions: string[] }).questions;
    expect(questions.length).toBeGreaterThan(0);

    // 2. core.web.search — honest non-stub stand-in (`engine:'brave'`) via a
    //    stub webResearch surface (no live egress / SSRF guard in a unit test).
    const search = getNodeRegistry().get('core.web.search') as NodeModule;
    const webResearch = { search: async () => ({ results: [{ url: 'https://example.org/watercolor-guide', title: 'A beginner watercolor guide', snippet: 'Start simple.', rank: 1 }], engine: 'brave', totalResults: 1 }) };
    const searchOut = await search.execute(mkctx('search', { query: 'Watercolor painting basics', maxResults: 8 }, { webResearch }) as never) as { status: string; outputs: Record<string, unknown> };
    expect(searchOut.status).toBe('success');
    const searchResults = searchOut.outputs as { results: unknown[]; engine: string };
    expect(searchResults.engine).toBe('brave');

    // 3. source-normalize (receives the search node's outputs via the edge)
    const normalize = await packNodes['feature.kicktodo.nodes.source-normalize']!(mkctx('normalize', { results: searchResults.results, engine: searchResults.engine }));
    const sources = (normalize.outputs as { sources: unknown[] }).sources;
    expect(sources).toHaveLength(1);

    // 4. evidence-graph — records a NON-STUB dossier (engine 'brave' passes the
    //    honesty gate); no claims ⇒ nothing unsupported.
    const graph = await packNodes['feature.kicktodo.nodes.evidence-graph']!(mkctx('evidence-graph', { candidateId: candidate.id, questions, sources, claims: [] }));
    expect(graph.status).toBe('success');

    // 5. plan-generate — honest `ctx.callAI` returning the VALID_PLAN; the node
    //    validates it authoritatively and writes `plan` to the bag.
    const callAI = async () => ({ data: VALID_PLAN });
    const generate = await packNodes['feature.kicktodo.nodes.plan-generate']!(mkctx('generate', { candidateId: candidate.id, topic: 'Watercolor painting basics', audience: 'absolute beginners', evidenceSummary: bag.get('evidenceSummary') }, { callAI }));
    expect(generate.status).toBe('success');
    expect(bag.get('plan')).toBeTruthy();

    // 6. outline-approve (REAL core.chat.approvalGate) — approved.
    const approve = await approvalGateFn(mkctx('outline-approve', { artifact: bag.get('plan') }, { config: { title: 'Approve the challenge outline?', artifactType: 'challenge-outline', maxRequestChangesIterations: 0 }, suspend: async () => ({ decision: 'approved', approved: true }) }));
    expect((approve.outputs as { approved: boolean }).approved).toBe(true);

    // 7. plan-validate
    const validate = await packNodes['feature.kicktodo.nodes.plan-validate']!(mkctx('plan-validate', { plan: bag.get('plan') }));
    expect((validate.outputs as { valid: boolean }).valid).toBe(true);

    // 8. decompose — drafts the challenge + binds it to the candidate (ADR 0441).
    const decompose = await packNodes['feature.kicktodo.nodes.decompose']!(mkctx('decompose', { plan: bag.get('plan'), authorSubject: AUTHOR, candidateId: candidate.id }));
    expect(decompose.status).toBe('success');
    const bound = await getCandidate(T, candidate.id);
    expect(bound?.draft).toBeTruthy();
    expect(bound?.state).toBe('planned');

    // 8b. simulation stage — the three sim personas' verdicts recorded on the
    //     candidate (ADR 0458 P2). The publication `simulation` gate reads these;
    //     without them the submit below fails the gate.
    await surface.recordSimulationVerdicts!({
      candidateId: candidate.id,
      // the persona-tagged array sim-collect forwards (ADR 0458 P2): verbatim
      // sim-verdict schema bodies + the port-derived `sim` routing tag.
      verdicts: [
        { sim: 'newcomer', verdict: 'pass', personaSummary: 'clear', findings: [] },
        { sim: 'time-poor', verdict: 'flag', personaSummary: 'tight on day 2', findings: [{ severity: 'flag', text: 'day-2-load', day: 2 }] },
        { sim: 'skeptic', verdict: 'pass', personaSummary: 'sourced', findings: [] },
      ],
    });

    // 9. submit-publication — raises the SoD approval; NEVER completes publication.
    const submit = await packNodes['feature.kicktodo.nodes.submit-publication']!(mkctx('submit', { candidateId: candidate.id }));
    expect(submit.status).toBe('success');
    const submitOut = submit.outputs as { approvalId: string; state: string };
    expect(submitOut.state).toBe('submitted');

    // The publication act exists, is submitted-but-not-completed, and its approval
    // is the separation-of-duties `challenge-publish` kind.
    const publication = await getPublication(T, candidate.id);
    expect(publication).toBeTruthy();
    expect(publication!.approvalId).toBe(submitOut.approvalId);
    expect(publication!.completedAt).toBeUndefined();
    expect(publication!.completedBy).toBeUndefined();
    expect((await getApproval(publication!.approvalId))?.kind).toBe('challenge-publish');
    // And the challenge is NOT published — the candidate is still 'planned'.
    expect((await getCandidate(T, candidate.id))?.state).toBe('planned');
  });

  it('the outline gate emits approved=false on a reject resolution', async () => {
    const rejected = await approvalGateFn({ runId: 'r', nodeId: 'g', config: { title: 'x' }, inputs: {}, suspend: async () => ({ decision: 'reject', approved: false }) });
    expect((rejected.outputs as { approved: boolean }).approved).toBe(false);
  });
});

describe('(B) a rejected outline FAILS the run TYPED, an approved one completes (scheduler + real gate + resume)', () => {
  const GATE_BRANCH_ID = 'wf.kt-outline-gate-branch';

  beforeAll(() => {
    // Register the REAL core.chat.approvalGate pack node so executeRun resolves it.
    getNodeRegistry().register({ typeId: 'core.chat.approvalGate', version: '1.0.0', execute: (ctx) => approvalGateFn(ctx as never) as never });
    // The exact conditioned-edge shape the factory workflow wires: approved →
    // build (a noop stand-in for validate/decompose/submit), rejected → core.fail.
    const def: WorkflowDefinition = {
      workflowId: GATE_BRANCH_ID,
      nodes: [
        { nodeId: 'outline-approve', typeId: 'core.chat.approvalGate', config: { title: 'Approve the outline?' } },
        { nodeId: 'build', typeId: 'core.noop' },
        { nodeId: 'gate-reject', typeId: 'core.fail', config: { code: 'outline_rejected', message: 'The outline was rejected.' } },
      ],
      edges: [
        { edgeId: 'e_ok', sourceNodeId: 'outline-approve', targetNodeId: 'build', triggerRule: 'all_success', condition: { path: 'approved', op: 'truthy' } },
        { edgeId: 'e_reject', sourceNodeId: 'outline-approve', targetNodeId: 'gate-reject', condition: { path: 'approved', op: 'falsy' } },
      ],
    };
    registerHostWorkflow(def);
  });

  async function runAndResolve(resumeValue: unknown): Promise<{ status: string; states: Record<string, string> }> {
    const now = new Date().toISOString();
    const run: RunRecord = { runId: `run-gate-${Math.random().toString(36).slice(2)}`, workflowId: GATE_BRANCH_ID, tenantId: 'default', status: 'pending', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now };
    await storage.insertRun(run);
    const def = (await hostSuite.workflowCatalog.getWorkflow(GATE_BRANCH_ID))!.definition;
    const initial = await executeRun(storage, run, def);
    expect(initial.status).toBe('waiting-approval');
    const open = await storage.listOpenInterrupts(run.runId);
    await __resolveAndResumeForTests(storage, hostSuite, open[0]!.interruptId, resumeValue);
    await __awaitRunResumeChainForTests(run.runId);
    const events = await storage.listEvents(run.runId);
    const states: Record<string, string> = {};
    for (const e of events) {
      if (e.type === 'node.completed' && e.nodeId) states[e.nodeId] = 'completed';
      if (e.type === 'node.failed' && e.nodeId) states[e.nodeId] = 'failed';
      if (e.type === 'node.skipped' && e.nodeId) states[e.nodeId] = 'skipped';
    }
    return { status: (await storage.getRun(run.runId))!.status, states };
  }

  it('reject ⇒ the run FAILS and core.fail runs while the build branch is skipped', async () => {
    const { status, states } = await runAndResolve({ decision: 'reject', approved: false });
    expect(status).toBe('failed');
    expect(states['gate-reject']).toBe('failed');
    expect(states['build']).not.toBe('completed');
  });

  it('approve ⇒ the run COMPLETES and the build branch runs while core.fail is skipped', async () => {
    const { status, states } = await runAndResolve({ decision: 'approved', approved: true });
    expect(status).toBe('completed');
    expect(states['build']).toBe('completed');
    expect(states['gate-reject']).not.toBe('failed');
  });
});

describe('(C) the factory workflow wires the fail-typed reject branch (structural)', () => {
  const wf = kicktodoCreatorBuiltinWorkflows.find((w) => w.workflowId === CHALLENGE_FACTORY_WORKFLOW_ID)!;

  it('the outline gate feeds TWO conditioned edges — a truthy build edge and a falsy core.fail edge', () => {
    const fromGate = (wf.edges ?? []).filter((e) => e.sourceNodeId === 'outline-approve');
    const truthy = fromGate.find((e) => e.condition?.path === 'approved' && e.condition?.op === 'truthy');
    const falsy = fromGate.find((e) => e.condition?.path === 'approved' && e.condition?.op === 'falsy');
    expect(truthy?.targetNodeId).toBe('plan-validate');
    expect(falsy?.targetNodeId).toBe('gate-reject');
    expect(wf.nodes.find((n) => n.nodeId === 'gate-reject')?.typeId).toBe('core.fail');
    // The terminal build step is the SoD submit — never a publish.
    expect(wf.nodes.find((n) => n.nodeId === 'submit')?.typeId).toBe('feature.kicktodo.nodes.submit-publication');
  });
});
