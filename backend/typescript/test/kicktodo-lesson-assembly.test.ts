/**
 * ADR 0458 Phase 2 — per-lesson assembly, the simulation gate, and the
 * reject-safe checkpoint barrier.
 *
 *  (A) `computeCheckpointBatches` — deterministic ≤4-batch partitioning across
 *      cadence × duration (the 1-day and 30-day corners), contiguous coverage,
 *      liveness flags.
 *  (B) `setLessonMedia` — replace-on-retry idempotency (one pointer per day).
 *  (C) simulation verdicts — closed-world normalization (unreadable ⇒ `block`)
 *      and the REAL publication `simulation` gate (blocks on `block`/missing,
 *      passes on `flag`).
 *  (D) the reject-safe barrier — the exact factory slot/gate/fail/decompose edge
 *      shape, through the real scheduler + resume: a rejected checkpoint fails
 *      the run typed and `decompose` is skipped; an approved one proceeds; a
 *      zero-live-slot (outline-only) run reaches `decompose` with NO gate.
 *  (E) the factory workflow wires the P2 stages structurally.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import {
  computeCheckpointBatches,
  normalizeSimulationVerdicts,
  setLessonMedia,
  listLessonMedia,
  MAX_CHECKPOINT_SLOTS,
  __test as lessonTest,
} from '../src/features/kicktodo-creator/lessonAssembly.js';
import { createCandidate, recordResearch, setCandidateDraft, setCandidateSimulation } from '../src/features/kicktodo-creator/creatorService.js';
import { submitForPublication, getPublication } from '../src/features/kicktodo-creator/publishService.js';
import { getApproval } from '../src/host/approvalService.js';
import { createDraft } from '../src/features/kicktodo-core/challengeService.js';
import { kicktodoCreatorBuiltinWorkflows, CHALLENGE_FACTORY_WORKFLOW_ID } from '../src/features/kicktodo-creator/builtinWorkflows.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { RunRecord } from '../src/types.js';

const chatUrl = new URL('../../../packs/vendor.myndhyve.chat/index.mjs', import.meta.url).href;
type NodeFn = (ctx: Record<string, unknown>) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: unknown }>;

const storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initHostExtPersistence(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kt-p2-')) });
setChatStorage(storage);
const hostSuite = createHostAdapterSuite({ storage });

let approvalGateFn: NodeFn;
beforeAll(async () => {
  ensureNodesRegistered();
  approvalGateFn = ((await import(chatUrl)) as { approvalGate: NodeFn }).approvalGate;
});

/* ─────────────────────── (A) checkpoint batching ─────────────────────── */

describe('(A) computeCheckpointBatches — deterministic ≤4-batch cadence', () => {
  const daysOf = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

  it('outline-only yields ZERO batches at every duration (only the outline gate remains)', () => {
    for (const n of [1, 7, 30]) {
      const plan = computeCheckpointBatches(daysOf(n), 'outline-only');
      expect(plan.batches).toHaveLength(0);
      expect(plan.noLiveSlots).toBe(true);
      expect(plan.slotLive).toEqual([false, false, false, false]);
    }
  });

  it('a 1-day batched plan is a single checkpoint over day 1', () => {
    const plan = computeCheckpointBatches([1], 'batched');
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0]).toMatchObject({ slot: 0, days: [1], fromDay: 1, toDay: 1 });
    expect(plan.slotLive).toEqual([true, false, false, false]);
    expect(plan.noLiveSlots).toBe(false);
  });

  it('a 30-day batched plan is four contiguous, balanced, gap-free batches', () => {
    const plan = computeCheckpointBatches(daysOf(30), 'batched');
    expect(plan.batches).toHaveLength(MAX_CHECKPOINT_SLOTS);
    expect(plan.slotLive).toEqual([true, true, true, true]);
    // Contiguous + gap-free + every day covered exactly once.
    const flattened = plan.batches.flatMap((b) => b.days);
    expect(flattened).toEqual(daysOf(30));
    // Balanced: earlier batches absorb the remainder (8,8,7,7), never >10 here.
    expect(plan.batches.map((b) => b.days.length)).toEqual([8, 8, 7, 7]);
    // The gate-title ranges are ascending and adjacent.
    expect(plan.batches.map((b) => [b.fromDay, b.toDay])).toEqual([[1, 8], [9, 16], [17, 23], [24, 30]]);
  });

  it('a batched plan under four days gets one checkpoint per day (bounded by day count)', () => {
    expect(computeCheckpointBatches([1, 2, 3], 'batched').batches).toHaveLength(3);
    expect(computeCheckpointBatches([1, 2], 'batched').slotLive).toEqual([true, true, false, false]);
  });

  it('is total over junk input (duplicates / zero / non-integers dropped)', () => {
    const plan = computeCheckpointBatches([3, 3, 0, -1, 1.5, 1, 2], 'batched');
    expect(plan.batches.flatMap((b) => b.days)).toEqual([1, 2, 3]);
  });
});

/* ─────────────────────── (B) lesson media pointers ───────────────────── */

describe('(B) setLessonMedia — replace-on-retry, one pointer per (candidate, day)', () => {
  beforeEach(async () => { await lessonTest.lessonMedia.__clear(); });

  it('re-writing a day OVERWRITES its single pointer instead of orphaning a second', async () => {
    const key = { tenantId: 't1', candidateId: 'cand:x', day: 3, kind: 'image' as const };
    await setLessonMedia({ ...key, assetId: 'asset:v1' });
    await setLessonMedia({ ...key, assetId: 'asset:v2' }); // a retry / re-generation
    const rows = await listLessonMedia('t1', 'cand:x');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.assetId).toBe('asset:v2');
  });

  it('keeps distinct days apart, ascending, tenant-scoped', async () => {
    await setLessonMedia({ tenantId: 't1', candidateId: 'cand:x', day: 2, assetId: 'a2', kind: 'video' });
    await setLessonMedia({ tenantId: 't1', candidateId: 'cand:x', day: 1, assetId: 'a1', kind: 'image' });
    await setLessonMedia({ tenantId: 't2', candidateId: 'cand:x', day: 1, assetId: 'other', kind: 'image' });
    const rows = await listLessonMedia('t1', 'cand:x');
    expect(rows.map((r) => r.day)).toEqual([1, 2]);
  });

  it('rejects a bad kind / non-positive day (typed, never a silent write)', async () => {
    await expect(setLessonMedia({ tenantId: 't', candidateId: 'c', day: 0, assetId: 'a', kind: 'image' })).rejects.toThrow();
    await expect(setLessonMedia({ tenantId: 't', candidateId: 'c', day: 1, assetId: 'a', kind: 'gif' as never })).rejects.toThrow();
  });
});

/* ─────────────────── (C) simulation normalization + gate ─────────────── */

describe('(C) simulation verdicts — closed-world normalization (persona-tagged array, schema-verbatim)', () => {
  it('reads the sim-collect ARRAY (persona from the node-attached `sim` tag); unreadable verdict → block; junk item dropped', () => {
    const out = normalizeSimulationVerdicts([
      { sim: 'newcomer', verdict: 'maybe', findings: [], personaSummary: 'x' }, // unreadable verdict
      { sim: 'martian', verdict: 'pass' }, // unknown persona ⇒ dropped
      'garbage',
    ]);
    expect(out).toEqual([{ sim: 'newcomer', verdict: 'block', personaSummary: 'x', findings: [] }]);
  });

  it('also accepts the persona-KEYED map shape (dual-accept robustness)', () => {
    const out = normalizeSimulationVerdicts({ skeptic: { verdict: 'pass', personaSummary: 'ok', findings: [] } });
    expect(out).toEqual([{ sim: 'skeptic', verdict: 'pass', personaSummary: 'ok', findings: [] }]);
  });

  it('defense in depth: a block-severity finding FORCES block even when the verdict says pass', () => {
    const out = normalizeSimulationVerdicts([
      { sim: 'time-poor', verdict: 'pass', personaSummary: 'ok', findings: [{ severity: 'note', text: 'minor' }, { severity: 'block', text: 'cannot finish', day: 2 }] },
    ]);
    expect(out[0]).toMatchObject({ sim: 'time-poor', verdict: 'block' });
    expect(out[0]!.findings).toEqual([{ severity: 'note', text: 'minor' }, { severity: 'block', text: 'cannot finish', day: 2 }]);
  });

  it('keeps well-formed findings verbatim (severity default `note`, empty-text dropped)', () => {
    const out = normalizeSimulationVerdicts([
      { sim: 'newcomer', verdict: 'flag', personaSummary: 'ok', findings: [{ text: 'unclear day 3' }, { severity: 'bogus', text: '' }] },
    ]);
    expect(out[0]).toMatchObject({ sim: 'newcomer', verdict: 'flag' });
    expect(out[0]!.findings).toEqual([{ severity: 'note', text: 'unclear day 3' }]);
  });

  it('parity with the sim-verdict pack schema — accepts a schema-valid verdict VERBATIM, derives block from a block finding', async () => {
    const schemaPath = new URL('../../../packs/feature.kicktodo.agents/schemas/sim-verdict.schema.json', import.meta.url);
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const { default: Ajv2020 } = (await import('ajv/dist/2020.js')) as { default: new (o?: unknown) => { compile: (s: unknown) => (v: unknown) => boolean } };
    const validate = new Ajv2020({ strict: false }).compile(schema);

    const passBody = { verdict: 'pass', findings: [{ severity: 'note', text: 'clear enough', day: 1 }], personaSummary: 'felt doable' };
    expect(validate(passBody)).toBe(true); // the fixture IS schema-valid (no `sim`)
    // sim-collect tags the verbatim schema body with the persona from the port;
    // the normalizer preserves the body and keeps the persona.
    expect(normalizeSimulationVerdicts([{ sim: 'newcomer', ...passBody }])[0]).toEqual({
      sim: 'newcomer', verdict: 'pass', personaSummary: 'felt doable', findings: [{ severity: 'note', text: 'clear enough', day: 1 }],
    });

    // A schema-VALID verdict that headlines `pass` but logs a `block` finding is
    // forced to block (defense in depth — the schema can't express that rule).
    const sneaky = { verdict: 'pass', findings: [{ severity: 'block', text: 'needs equipment I lack' }], personaSummary: 'blocked in practice' };
    expect(validate(sneaky)).toBe(true);
    expect(normalizeSimulationVerdicts([{ sim: 'skeptic', ...sneaky }])[0]!.verdict).toBe('block');
  });
});

describe('(C) the publication `simulation` gate is REAL', () => {
  const T = 'tenant-kt-sim-gate';
  const A = 'user:author';

  /** A candidate that passes every OTHER publication gate (dossier, claims,
   *  safety, bound draft) so the simulation gate is the ONLY variable. Returns
   *  the candidate id + its bound draft coordinates. */
  async function readyCandidate(): Promise<{ candidateId: string; challengeId: string; challengeVersion: number }> {
    const cand = await createCandidate({ tenantId: T, createdBy: A, topic: 'Watercolor painting basics', audience: 'beginners', transformation: '', durationDaysTarget: 3, dailyMinutesTarget: 15 });
    await recordResearch(T, cand.id, {
      questions: [],
      sources: [{ url: 'https://example.org/guide', domain: 'x', title: 'Guide', hash: 'h', engine: 'searx' }],
      claims: [{ claimId: 'c1', text: 'brush control improves with repetition', sourceHashes: ['h'] }],
    });
    const draft = await createDraft({ tenantId: T, authorSubject: A, title: 'Watercolor', summary: 's', outcome: 'o', durationDays: 3, activities: [{ stableActivityId: 'd1', day: 1, title: 'Study', instructions: 'paint', evidencePolicy: 'photo' }] });
    await setCandidateDraft(T, cand.id, draft.id, 1);
    return { candidateId: cand.id, challengeId: draft.id, challengeVersion: 1 };
  }

  const PASS = [
    { sim: 'newcomer' as const, verdict: 'pass' as const, personaSummary: '', findings: [] },
    { sim: 'time-poor' as const, verdict: 'pass' as const, personaSummary: '', findings: [] },
    { sim: 'skeptic' as const, verdict: 'pass' as const, personaSummary: '', findings: [] },
  ];

  it('blocks publication when no simulation has run (fail-closed coverage)', async () => {
    const c = await readyCandidate();
    await expect(submitForPublication(T, c.candidateId, c.challengeId, c.challengeVersion, A))
      .rejects.toMatchObject({ gate: 'simulation' });
    expect(await getPublication(T, c.candidateId)).toBeNull(); // no approval raised
  });

  it('blocks when a persona is missing', async () => {
    const c = await readyCandidate();
    await setCandidateSimulation(T, c.candidateId, [PASS[0]!, PASS[2]!]); // no time-poor
    await expect(submitForPublication(T, c.candidateId, c.challengeId, c.challengeVersion, A))
      .rejects.toMatchObject({ gate: 'simulation' });
  });

  it('blocks on a `block` verdict', async () => {
    const c = await readyCandidate();
    await setCandidateSimulation(T, c.candidateId, [PASS[0]!, { sim: 'time-poor', verdict: 'block', personaSummary: 'cannot finish', findings: [] }, PASS[2]!]);
    await expect(submitForPublication(T, c.candidateId, c.challengeId, c.challengeVersion, A))
      .rejects.toMatchObject({ gate: 'simulation' });
  });

  it('passes on a `flag` (not block); the flag rides the approval proposal', async () => {
    const c = await readyCandidate();
    await setCandidateSimulation(T, c.candidateId, [PASS[0]!, { sim: 'time-poor', verdict: 'flag', personaSummary: 'tight', findings: [{ severity: 'flag', text: 'day-2-load' }] }, PASS[2]!]);
    const record = await submitForPublication(T, c.candidateId, c.challengeId, c.challengeVersion, A);
    expect(record.approvalId).toBeTruthy();
    const approval = await getApproval(record.approvalId);
    expect(approval?.proposal).toContain('day-2-load'); // the human approver sees the finding
  });
});

/* ───────────────── (D) the reject-safe checkpoint barrier ────────────── */

describe('(D) the reject-safe barrier — one live slot, through the real scheduler', () => {
  const BARRIER_ID = 'wf.kt-checkpoint-barrier';
  const EMIT = 'test.emit-outputs';

  beforeAll(() => {
    // A node that emits fixed outputs from config — stands in for checkpoint-plan.
    getNodeRegistry().register({
      typeId: EMIT, version: '1.0.0',
      execute: (ctx) => Promise.resolve({ status: 'success', outputs: ((ctx as { config?: { outputs?: Record<string, unknown> } }).config?.outputs) ?? {} }) as never,
    });
    getNodeRegistry().register({ typeId: 'core.chat.approvalGate', version: '1.0.0', execute: (ctx) => approvalGateFn(ctx as never) as never });

    // The EXACT factory shape for one slot + the noLiveSlots bypass.
    const def: WorkflowDefinition = {
      workflowId: BARRIER_ID,
      variables: [{ name: 'cadence' }],
      nodes: [
        { nodeId: 'checkpoint-plan', typeId: EMIT },
        { nodeId: 'build-0', typeId: 'core.noop' },
        { nodeId: 'gate-0', typeId: 'core.chat.approvalGate', config: { title: 'Approve checkpoint 1?' } },
        { nodeId: 'fail-0', typeId: 'core.fail', config: { code: 'checkpoint_rejected', message: 'rejected' } },
        { nodeId: 'decompose', typeId: 'core.noop' },
      ],
      edges: [
        { edgeId: 'e_cp_build0', sourceNodeId: 'checkpoint-plan', targetNodeId: 'build-0', triggerRule: 'all_success', condition: { path: 'slot0Live', op: 'truthy' } },
        { edgeId: 'e_build0_gate0', sourceNodeId: 'build-0', targetNodeId: 'gate-0', triggerRule: 'all_success' },
        { edgeId: 'e_gate0_fail0', sourceNodeId: 'gate-0', targetNodeId: 'fail-0', condition: { path: 'approved', op: 'falsy' } },
        // The reject-safe barrier — decompose ← fail-0 (none_failed): skipped fail
        // (approved / dead slot) ⇒ decompose runs; a FAILED fail (reject) ⇒ skip.
        { edgeId: 'e_fail0_decompose', sourceNodeId: 'fail-0', targetNodeId: 'decompose', triggerRule: 'none_failed' },
      ],
    };
    registerHostWorkflow(def);
  });

  async function runWithCp(cpOutputs: Record<string, unknown>, resumeValue?: unknown): Promise<{ status: string; states: Record<string, string> }> {
    const now = new Date().toISOString();
    const run: RunRecord = { runId: `run-barrier-${Math.random().toString(36).slice(2)}`, workflowId: BARRIER_ID, tenantId: 'default', status: 'pending', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now };
    await storage.insertRun(run);
    // Inject checkpoint-plan's fixed outputs onto the node config for this run.
    const base = (await hostSuite.workflowCatalog.getWorkflow(BARRIER_ID))!.definition;
    const def: WorkflowDefinition = { ...base, nodes: base.nodes.map((n) => (n.nodeId === 'checkpoint-plan' ? { ...n, config: { outputs: cpOutputs } } : n)) };
    const initial = await executeRun(storage, run, def);
    if (initial.status === 'waiting-approval' && resumeValue !== undefined) {
      const open = await storage.listOpenInterrupts(run.runId);
      await __resolveAndResumeForTests(storage, hostSuite, open[0]!.interruptId, resumeValue);
      await __awaitRunResumeChainForTests(run.runId);
    }
    const events = await storage.listEvents(run.runId);
    const states: Record<string, string> = {};
    for (const e of events) {
      if (e.type === 'node.completed' && e.nodeId) states[e.nodeId] = 'completed';
      if (e.type === 'node.failed' && e.nodeId) states[e.nodeId] = 'failed';
      if (e.type === 'node.skipped' && e.nodeId) states[e.nodeId] = 'skipped';
    }
    return { status: (await storage.getRun(run.runId))!.status, states };
  }

  it('a LIVE slot APPROVED ⇒ decompose runs, run completes', async () => {
    const { status, states } = await runWithCp({ slot0Live: true, noLiveSlots: false }, { decision: 'approved', approved: true });
    expect(status).toBe('completed');
    expect(states['decompose']).toBe('completed');
    expect(states['fail-0']).not.toBe('failed');
  });

  it('a LIVE slot REJECTED ⇒ core.fail fails, decompose is SKIPPED, run fails typed', async () => {
    const { status, states } = await runWithCp({ slot0Live: true, noLiveSlots: false }, { decision: 'reject', approved: false });
    expect(status).toBe('failed');
    expect(states['fail-0']).toBe('failed');
    expect(states['decompose']).not.toBe('completed');
  });

  it('NO live slots (outline-only) ⇒ no gate suspends, decompose runs via the bypass', async () => {
    const { status, states } = await runWithCp({ slot0Live: false, noLiveSlots: true });
    expect(status).toBe('completed');
    expect(states['decompose']).toBe('completed');
    expect(states['build-0']).not.toBe('completed'); // dead slot never built
    expect(states['gate-0']).not.toBe('completed'); // and never gated a human
  });
});

/* ───────────────────── (E) factory structure (P2) ───────────────────── */

describe('(E) the factory workflow wires the P2 stages', () => {
  const wf = kicktodoCreatorBuiltinWorkflows.find((w) => w.workflowId === CHALLENGE_FACTORY_WORKFLOW_ID)!;
  const edge = (id: string) => (wf.edges ?? []).find((e) => e.edgeId === id);

  it('each of the four slots conditions its build on liveness and routes reject → fail → decompose (none_failed barrier)', () => {
    for (const n of [0, 1, 2, 3]) {
      expect(edge(`e_cp_build${n}`)?.condition).toEqual({ path: `slot${n}Live`, op: 'truthy' });
      expect(edge(`e_gate${n}_fail${n}`)?.condition).toEqual({ path: 'approved', op: 'falsy' });
      // the fail node is the SOLE decompose upstream (the skip-on-reject barrier),
      // wired none_failed so all-skipped (approved / dead / outline-only) proceeds.
      const barrier = edge(`e_fail${n}_decompose`);
      expect(barrier?.targetNodeId).toBe('decompose');
      expect(barrier?.triggerRule).toBe('none_failed');
      expect(wf.nodes.find((nd) => nd.nodeId === `fail-${n}`)?.typeId).toBe('core.fail');
    }
    // decompose has NO direct edge from checkpoint-plan (that would strand it in
    // the synchronous outline-only skip cascade); the fails encode the bypass.
    expect((wf.edges ?? []).some((e) => e.sourceNodeId === 'checkpoint-plan' && e.targetNodeId === 'decompose')).toBe(false);
  });

  it('the three sims dispatch read-only (offerTools:[]) and feed sim-collect → submit', () => {
    for (const id of ['sim-newcomer', 'sim-time-poor', 'sim-skeptic']) {
      const node = wf.nodes.find((n) => n.nodeId === id)!;
      expect(node.typeId).toBe('local.openwop-app.agent-runner');
      expect((node.config as { offerTools?: unknown }).offerTools).toEqual([]);
      expect(edge(`e_${id}_collect`)?.targetNodeId).toBe('sim-collect');
    }
    expect(edge('e_collect_submit')?.targetNodeId).toBe('submit');
    expect(wf.nodes.find((n) => n.nodeId === 'submit')?.typeId).toBe('feature.kicktodo.nodes.submit-publication');
  });
});
