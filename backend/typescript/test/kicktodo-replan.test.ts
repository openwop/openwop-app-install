/**
 * ADR 0459 P1 — the participant-loop chat-ignition (replan) lane, host half.
 *
 *  1. the SHARED enrollment-authority predicate (`hasKicktodoEnrollmentAuthority`)
 *     the enrollment routes AND the replan tool both call — foreign/absent/no-subject
 *     all deny; the owner is admitted;
 *  2. the replan ACTION tool fails typed without an acting user / on a foreign
 *     enrollment, and on the owner path dispatches the replan workflow with the
 *     enrollment identity seeded;
 *  3. `applyRevisionCommands` (the governed surface op): a valid closed-world list
 *     applies through the lanes + re-materializes ONCE; an unknown lane is a typed
 *     validation_error; a failing command surfaces its index; a foreign subject is
 *     refused BEFORE anything runs;
 *  4. schema-parity: the TS command validator agrees, case for case, with the
 *     agents-pack `plan-revision.schema.json`;
 *  5. the replan builtin end-to-end through the REAL approval gate + resume: an
 *     APPROVE applies the commands (the enrollment mutates); a REJECT fails the run
 *     typed and mutates NOTHING.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, afterAll } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { RunRecord } from '../src/types.js';
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
import { registerWorkflow as registerHostWorkflow } from '../src/host/workflowsRegistry.js';
import { registerFeatureSurface, __clearFeatureSurfaces } from '../src/host/featureSurfaces.js';
import { enableTenantOverride } from '../src/host/featureToggles/service.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { __resolveAndResumeForTests, __awaitRunResumeChainForTests } from '../src/routes/interrupts.js';
import { hasKicktodoEnrollmentAuthority } from '../src/features/featureRoute.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, getEnrollment, materializeOccurrences, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { effectiveDateForDay } from '../src/features/kicktodo-core/types.js';
import { applyRevisionCommands, previewRevisionCommands, revisionCommandsValid, RevisionCommandError } from '../src/features/kicktodo-core/replanService.js';
import { registerPlanRevisedListener, __resetPlanRevisedListenersForTest } from '../src/host/planRevisedHook.js';
import { buildKicktodoCoreSurface } from '../src/features/kicktodo-core/surface.js';
import { runReplanTool } from '../src/features/kicktodo-core/agentTools.js';
import { kicktodoBuiltinWorkflows, KICKTODO_REPLAN_WORKFLOW_ID } from '../src/features/kicktodo-core/builtinWorkflows.js';

type NodeFn = (ctx: Record<string, unknown>) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: unknown }>;

// ADR 0734: registerFeatureSurface() mutates a module-level registry this file
// dirtied and never cleaned up. Hygiene — leave the registry as we found it.
// NOT a cross-file fix: vitest forks a fresh process per test file (measured),
// so this residue could never have reached another file. See the ADR's
// correction note before citing this as protection.
afterAll(() => { __clearFeatureSurfaces(); });

const packUrl = new URL('../../../packs/feature.kicktodo.nodes/index.mjs', import.meta.url).href;
const chatUrl = new URL('../../../packs/vendor.myndhyve.chat/index.mjs', import.meta.url).href;
const AGENTS_PACK = new URL('../../../packs/feature.kicktodo.agents', import.meta.url);

const storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initHostExtPersistence(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kt-replan-')) });
setChatStorage(storage);
const hostSuite = createHostAdapterSuite({ storage });
const deps = { storage, hostSuite };

const ACTIVITY = { stableActivityId: 'run', day: 1, title: 'Run 5k', instructions: 'Run', evidencePolicy: 'attestation' as const };

let packNodes: Record<string, NodeFn>;
let approvalGateFn: NodeFn;

beforeAll(async () => {
  ensureNodesRegistered();
  packNodes = ((await import(packUrl)) as { nodes: Record<string, NodeFn> }).nodes;
  approvalGateFn = ((await import(chatUrl)) as { approvalGate: NodeFn }).approvalGate;
  // The kicktodo-core feature surface is what the apply node composes; register it
  // and enable the toggle so the run-scoped surface is not gated off.
  registerFeatureSurface('kicktodo-core', buildKicktodoCoreSurface);
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  // The replan tool resolves the workflow via the host catalog; register the
  // builtins so the tool's dispatch (and the E2E below) find it.
  for (const w of kicktodoBuiltinWorkflows) registerHostWorkflow(w);
});

beforeEach(() => {
  __clearEnrollGuards();
});

async function publishChallengeWith(tenant: string): Promise<string> {
  const draft = await createDraft({ tenantId: tenant, title: 'Replan', summary: 's', outcome: 'o', durationDays: 5, activities: [ACTIVITY] as never });
  await publishChallenge(tenant, draft.id, 1);
  return draft.id;
}

async function enrollParticipant(tenant: string, owner: string): Promise<string> {
  const challengeId = await publishChallengeWith(tenant);
  const { enrollment } = await enroll({ tenantId: tenant, ownerSubject: owner, challengeId, challengeVersion: 1, timezone: 'UTC' });
  return enrollment.id;
}

// ── 1. the shared enrollment-authority predicate ──────────────────────────
describe('hasKicktodoEnrollmentAuthority (ADR 0459 P1 — shared by route + tool)', () => {
  it('admits the owner; denies a foreign subject, an absent enrollment, and no subject', async () => {
    const T = 'tenant-pred';
    const OWNER = 'user:pred-owner';
    const enrollmentId = await enrollParticipant(T, OWNER);
    expect(await hasKicktodoEnrollmentAuthority(T, enrollmentId, OWNER)).toBe(true);
    expect(await hasKicktodoEnrollmentAuthority(T, enrollmentId, 'user:pred-intruder')).toBe(false);
    expect(await hasKicktodoEnrollmentAuthority(T, 'enr:does-not-exist', OWNER)).toBe(false);
    expect(await hasKicktodoEnrollmentAuthority(T, enrollmentId, undefined)).toBe(false);
  });
});

// ── 2. the replan ACTION tool ─────────────────────────────────────────────
describe('openwop:kicktodo.replan (ACTION) — participant-scoped, typed failures', () => {
  const T = 'tenant-tool';
  const OWNER = 'user:tool-owner';
  let enrollmentId: string;
  beforeEach(async () => { enrollmentId = await enrollParticipant(T, OWNER); });

  it('no acting user ⇒ acting_user_required', async () => {
    const r = await runReplanTool(deps, { enrollmentId, intent: 'move to evenings' }, { tenantId: T });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content)).toMatchObject({ error: 'acting_user_required' });
  });

  it('a foreign enrollment ⇒ not_found (uniform denial, the SAME predicate the route uses)', async () => {
    const r = await runReplanTool(deps, { enrollmentId, intent: 'move to evenings' }, { tenantId: T, actingUserId: 'user:tool-intruder' });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content)).toMatchObject({ error: 'not_found' });
  });

  it('missing enrollmentId / intent ⇒ validation_error', async () => {
    const a = await runReplanTool(deps, { intent: 'x' }, { tenantId: T, actingUserId: OWNER });
    expect(JSON.parse(a.content)).toMatchObject({ error: 'validation_error' });
    const b = await runReplanTool(deps, { enrollmentId }, { tenantId: T, actingUserId: OWNER });
    expect(JSON.parse(b.content)).toMatchObject({ error: 'validation_error' });
  });

  it('the owner dispatches the replan workflow with the enrollment identity seeded', async () => {
    const r = await runReplanTool(deps, { enrollmentId, intent: 'move my rest days to weekends' }, { tenantId: T, actingUserId: OWNER });
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content) as { runId: string; enrollmentId: string };
    expect(body.runId).toBeTruthy();
    const run = await storage.getRun(body.runId);
    expect(run?.workflowId).toBe(KICKTODO_REPLAN_WORKFLOW_ID);
    expect((run?.inputs as Record<string, unknown>)?.enrollmentId).toBe(enrollmentId);
    expect((run?.inputs as Record<string, unknown>)?.ownerSubject).toBe(OWNER);
    // The participant intent is carried; the real-state summary is folded in.
    expect(String((run?.inputs as Record<string, unknown>)?.participantIntent)).toContain('move my rest days to weekends');
  });
});

// ── 3. applyRevisionCommands (the governed surface op) ─────────────────────
describe('applyRevisionCommands (ADR 0459 P1 — closed-world, owner-checked)', () => {
  const T = 'tenant-apply';

  it('a valid list applies through the lanes and re-materializes ONCE (planRevision bumps)', async () => {
    const OWNER = 'user:apply-ok';
    const enrollmentId = await enrollParticipant(T, OWNER);
    const before = await getEnrollment(T, enrollmentId);
    const res = await applyRevisionCommands(T, { enrollmentId, subject: OWNER, commands: [{ lane: 'schedule', daypart: 'evening' }] });
    expect(res.applied).toBe(true);
    const after = await getEnrollment(T, enrollmentId);
    expect(after?.schedulePreference?.daypart).toBe('evening');
    expect(after!.planRevision).toBe(before!.planRevision + 1); // exactly one re-materialize
  });

  it('an EMPTY command list is an honest no-op (no revision bump)', async () => {
    const OWNER = 'user:apply-empty';
    const enrollmentId = await enrollParticipant(T, OWNER);
    const before = await getEnrollment(T, enrollmentId);
    const res = await applyRevisionCommands(T, { enrollmentId, subject: OWNER, commands: [] });
    expect(res.applied).toBe(false);
    expect((await getEnrollment(T, enrollmentId))!.planRevision).toBe(before!.planRevision);
  });

  it('an unknown lane is a typed validation_error', async () => {
    const OWNER = 'user:apply-badlane';
    const enrollmentId = await enrollParticipant(T, OWNER);
    await expect(applyRevisionCommands(T, { enrollmentId, subject: OWNER, commands: [{ lane: 'evidence-policy' }] }))
      .rejects.toMatchObject({ code: 'validation_error' });
  });

  it('a failing command surfaces its INDEX (the second command is a bad substitution)', async () => {
    const OWNER = 'user:apply-idx';
    const enrollmentId = await enrollParticipant(T, OWNER);
    let caught: unknown;
    try {
      await applyRevisionCommands(T, {
        enrollmentId, subject: OWNER,
        commands: [{ lane: 'schedule', daypart: 'morning' }, { lane: 'substitute', cardId: 'kicktodo:enr:nope:2026-01-01:x:r1', alternativeId: 'nope' }],
      });
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(RevisionCommandError);
    expect((caught as RevisionCommandError).failedIndex).toBe(1);
  });

  it('a foreign subject is refused BEFORE anything runs (forbidden)', async () => {
    const OWNER = 'user:apply-owner';
    const enrollmentId = await enrollParticipant(T, OWNER);
    const before = await getEnrollment(T, enrollmentId);
    await expect(applyRevisionCommands(T, { enrollmentId, subject: 'user:apply-intruder', commands: [{ lane: 'schedule', daypart: 'evening' }] }))
      .rejects.toMatchObject({ code: 'forbidden' });
    // Nothing changed.
    expect((await getEnrollment(T, enrollmentId))!.planRevision).toBe(before!.planRevision);
    expect((await getEnrollment(T, enrollmentId))!.schedulePreference).toBeUndefined();
  });
});

// ── 3b. the ADR 0496 move lane + preview parity ────────────────────────────
describe('the move lane + previewRevisionCommands (ADR 0496 D1/D2)', () => {
  const T = 'tenant-move';
  const isoShift = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  /** A 5-day challenge with a DAY-3 activity so a future day exists to move. */
  async function enrollWithDay3(owner: string): Promise<string> {
    const draft = await createDraft({
      tenantId: T, title: 'Move', summary: 's', outcome: 'o', durationDays: 5,
      activities: [ACTIVITY, { stableActivityId: 'read', day: 3, title: 'Read', instructions: 'r', evidencePolicy: 'attestation' }] as never,
    });
    await publishChallenge(T, draft.id, 1);
    const { enrollment } = await enroll({ tenantId: T, ownerSubject: owner, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' });
    return enrollment.id;
  }

  // ENG-15(b) — the revision announces itself so projections (the calendar write in
  // kicktodo-integrations) can re-derive. Pinned HERE because the emit lives in
  // replanService; the seam's own fail-soft contract is pinned in
  // plan-revised-hook.test.ts.
  it('a MOVE announces the revision with its lanes; a schedule-only revision announces schedule', async () => {
    const seen: Array<{ enrollmentId: string; lanes: string[] }> = [];
    __resetPlanRevisedListenersForTest();
    registerPlanRevisedListener((ev) => { seen.push({ enrollmentId: ev.enrollmentId, lanes: [...ev.lanes] }); });
    try {
      const OWNER = 'user:move-announce';
      const enrollmentId = await enrollWithDay3(OWNER);
      await applyRevisionCommands(T, { enrollmentId, subject: OWNER, commands: [{ lane: 'move', day: 3, toDate: isoShift(6) }] });
      expect(seen).toEqual([{ enrollmentId, lanes: ['move'] }]);

      // A schedule-only revision still announces, but with lanes the calendar
      // listener ignores — that gate is what stops a preference tweak becoming an
      // external write.
      seen.length = 0;
      await applyRevisionCommands(T, { enrollmentId, subject: OWNER, commands: [{ lane: 'schedule', daypart: 'evening' }] });
      expect(seen).toEqual([{ enrollmentId, lanes: ['schedule'] }]);
    } finally {
      __resetPlanRevisedListenersForTest();
    }
  });

  it('a move applies durably (override stored, revision bumps); moving back to the natural date clears it', async () => {
    const OWNER = 'user:move-ok';
    const enrollmentId = await enrollWithDay3(OWNER);
    const before = await getEnrollment(T, enrollmentId);
    const natural = effectiveDateForDay(before!, 3);
    const toDate = isoShift(6);
    await applyRevisionCommands(T, { enrollmentId, subject: OWNER, commands: [{ lane: 'move', day: 3, toDate }] });
    const moved = await getEnrollment(T, enrollmentId);
    expect(moved?.schedulePreference?.dayOverrides).toEqual({ '3': toDate });
    expect(moved!.planRevision).toBe(before!.planRevision + 1);
    // Materialization fires the moved day at its new date, not its natural one.
    expect((await materializeOccurrences(T, enrollmentId, toDate)).some((o) => o.stableActivityId === 'read')).toBe(true);
    expect((await materializeOccurrences(T, enrollmentId, natural)).some((o) => o.stableActivityId === 'read')).toBe(false);
    // Move back to the natural date ⇒ the override key is DELETED (no tombstone).
    await applyRevisionCommands(T, { enrollmentId, subject: OWNER, commands: [{ lane: 'move', day: 3, toDate: natural }] });
    expect((await getEnrollment(T, enrollmentId))?.schedulePreference?.dayOverrides).toBeUndefined();
  });

  it('window guards fail closed: the past and beyond end+14 are refused with the command index', async () => {
    const OWNER = 'user:move-window';
    const enrollmentId = await enrollWithDay3(OWNER);
    for (const toDate of [isoShift(-1), isoShift(60)]) {
      let caught: unknown;
      try {
        await applyRevisionCommands(T, { enrollmentId, subject: OWNER, commands: [{ lane: 'move', day: 3, toDate }] });
      } catch (err) { caught = err; }
      expect(caught).toBeInstanceOf(RevisionCommandError);
      expect((caught as RevisionCommandError).failedIndex).toBe(0);
      expect((caught as RevisionCommandError).message).toContain('window');
    }
    expect((await getEnrollment(T, enrollmentId))?.schedulePreference?.dayOverrides).toBeUndefined();
  });

  it('PREVIEW PARITY (architect M5): preview refuses exactly what apply refuses, mutates nothing, and describes a valid move', async () => {
    const OWNER = 'user:move-preview';
    const enrollmentId = await enrollWithDay3(OWNER);
    const before = await getEnrollment(T, enrollmentId);
    // The same window refusal, same code, same failing index as apply.
    let caught: unknown;
    try {
      await previewRevisionCommands(T, { enrollmentId, subject: OWNER, commands: [{ lane: 'move', day: 3, toDate: isoShift(-1) }] });
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(RevisionCommandError);
    expect((caught as RevisionCommandError).failedIndex).toBe(0);
    expect((caught as RevisionCommandError).message).toContain('window');
    // A valid move previews with before/after dates — and NOTHING mutated.
    const toDate = isoShift(6);
    const { changes } = await previewRevisionCommands(T, { enrollmentId, subject: OWNER, commands: [{ lane: 'move', day: 3, toDate }] });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ lane: 'move', day: 3, fromDate: effectiveDateForDay(before!, 3), toDate });
    expect(changes[0]!.line.length).toBeGreaterThan(0);
    const after = await getEnrollment(T, enrollmentId);
    expect(after!.planRevision).toBe(before!.planRevision);
    expect(after?.schedulePreference?.dayOverrides).toBeUndefined();
    // A foreign subject gets the same forbidden as apply.
    await expect(previewRevisionCommands(T, { enrollmentId, subject: 'user:move-intruder', commands: [] }))
      .rejects.toMatchObject({ code: 'forbidden' });
  });
});

// ── 4. schema-parity with the agents-pack plan-revision schema ─────────────
describe('command validator ↔ plan-revision.schema.json parity (ADR 0459 P1)', () => {
  let ajvValid: (v: unknown) => boolean;
  beforeAll(async () => {
    const { default: Ajv2020 } = (await import('ajv/dist/2020.js')) as { default: new (o?: unknown) => { compile: (s: unknown) => (v: unknown) => boolean } };
    const schema = JSON.parse(readFileSync(join(AGENTS_PACK.pathname, 'schemas/plan-revision.schema.json'), 'utf8'));
    ajvValid = new Ajv2020({ strict: false }).compile(schema);
  });

  // Each case: the command LIST + whether it should validate. Ajv sees the full
  // { commands, rationale } object; our validator sees the commands array — they
  // must AGREE on the commands' shape.
  const cases: Array<{ name: string; commands: unknown[] }> = [
    { name: 'schedule morning', commands: [{ lane: 'schedule', daypart: 'morning' }] },
    { name: 'schedule null (clear)', commands: [{ lane: 'schedule', daypart: null }] },
    { name: 'substitute', commands: [{ lane: 'substitute', cardId: 'c1', alternativeId: 'a1' }] },
    { name: 'recovery', commands: [{ lane: 'recovery' }] },
    { name: 'empty', commands: [] },
    { name: 'five mixed', commands: [{ lane: 'recovery' }, { lane: 'schedule', daypart: 'evening' }, { lane: 'substitute', cardId: 'c', alternativeId: 'a' }, { lane: 'recovery' }, { lane: 'schedule', daypart: null }] },
    { name: 'six (too many)', commands: Array.from({ length: 6 }, () => ({ lane: 'recovery' })) },
    { name: 'unknown lane', commands: [{ lane: 'evidence-policy' }] },
    { name: 'schedule bad daypart', commands: [{ lane: 'schedule', daypart: 'midnight' }] },
    { name: 'schedule extra field', commands: [{ lane: 'schedule', daypart: 'morning', bogus: 1 }] },
    { name: 'substitute missing alternativeId', commands: [{ lane: 'substitute', cardId: 'c1' }] },
    { name: 'recovery extra field', commands: [{ lane: 'recovery', enrollmentId: 'e1' }] },
    { name: 'not an object', commands: ['nope'] },
    // ADR 0496 D1 — the move lane joins the closed world on BOTH sides.
    { name: 'move valid', commands: [{ lane: 'move', day: 3, toDate: '2027-01-15' }] },
    { name: 'move bad date format', commands: [{ lane: 'move', day: 3, toDate: '15/01/2027' }] },
    { name: 'move non-integer day', commands: [{ lane: 'move', day: 2.5, toDate: '2027-01-15' }] },
    { name: 'move day zero', commands: [{ lane: 'move', day: 0, toDate: '2027-01-15' }] },
    { name: 'move missing toDate', commands: [{ lane: 'move', day: 3 }] },
    { name: 'move extra field', commands: [{ lane: 'move', day: 3, toDate: '2027-01-15', cardId: 'c1' }] },
  ];

  it.each(cases)('agrees on: $name', ({ commands }) => {
    const mine = revisionCommandsValid(commands);
    const theirs = ajvValid({ commands, rationale: 'a non-empty rationale' });
    expect(mine).toBe(theirs);
  });
});

// ── 5. the replan builtin E2E through the real gate + resume ───────────────
describe('the replan builtin: approve applies, reject fails typed and mutates nothing (ADR 0459 P1)', () => {
  const REVISION = { commands: [{ lane: 'schedule', daypart: 'evening' }], rationale: 'Evenings fit better.' };
  const wf = kicktodoBuiltinWorkflows.find((w) => w.workflowId === KICKTODO_REPLAN_WORKFLOW_ID)!;

  beforeAll(async () => {
    // Enable kicktodo-core for the E2E tenant so the run-scoped surface is live.
    await enableTenantOverride('kicktodo-core', 'tenant-e2e', 'test');
    // STUB the composer (agent-runner) — no model in a unit test; it returns the
    // structured revision the gate then shows and the apply node consumes.
    getNodeRegistry().register({ typeId: 'local.openwop-app.agent-runner', version: '1.0.0', execute: async () => ({ status: 'success', outputs: { result: REVISION } }) as never });
    // The REAL approval gate + the REAL enrich + apply pack nodes.
    getNodeRegistry().register({ typeId: 'core.chat.approvalGate', version: '1.0.0', execute: (ctx) => approvalGateFn(ctx as never) as never });
    getNodeRegistry().register({ typeId: 'feature.kicktodo.nodes.enrich-plan-revision', version: '1.0.0', execute: (ctx) => packNodes['feature.kicktodo.nodes.enrich-plan-revision']!(ctx as never) as never });
    // ADR 0463 (#2343) — the clarify leg sits between compose and enrich; with no
    // `clarification` on the composed revision it passes through unchanged, which
    // is exactly this suite's path (the composer mock fills all slots).
    getNodeRegistry().register({ typeId: 'feature.kicktodo.nodes.replan-clarify', version: '1.0.0', execute: (ctx) => packNodes['feature.kicktodo.nodes.replan-clarify']!(ctx as never) as never });
    getNodeRegistry().register({ typeId: 'feature.kicktodo.nodes.apply-revision-commands', version: '1.0.0', execute: (ctx) => packNodes['feature.kicktodo.nodes.apply-revision-commands']!(ctx as never) as never });
    registerHostWorkflow(wf);
  });

  async function runReplanAndResolve(owner: string, enrollmentId: string, resume: unknown): Promise<{ status: string; states: Record<string, string> }> {
    const now = new Date().toISOString();
    const run: RunRecord = {
      runId: `run-replan-${Math.random().toString(36).slice(2)}`,
      workflowId: KICKTODO_REPLAN_WORKFLOW_ID, tenantId: 'tenant-e2e', status: 'pending',
      inputs: { enrollmentId, ownerSubject: owner, participantIntent: 'shift later' },
      metadata: { actingUserId: owner }, configurable: {}, createdAt: now, updatedAt: now,
    };
    await storage.insertRun(run);
    seedRunVariables(run.runId, wf.variables, run.inputs);
    const def = (await hostSuite.workflowCatalog.getWorkflow(KICKTODO_REPLAN_WORKFLOW_ID))!.definition;
    const initial = await executeRun(storage, run, def, { policyResolver: hostSuite.providerPolicyResolver });
    expect(initial.status).toBe('waiting-approval');
    const open = await storage.listOpenInterrupts(run.runId);
    await __resolveAndResumeForTests(storage, hostSuite, open[0]!.interruptId, resume);
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

  it('APPROVE ⇒ the run completes, apply runs, and the enrollment mutates (schedule set, revision bumped)', async () => {
    const OWNER = 'user:e2e-approve';
    const enrollmentId = await enrollParticipant('tenant-e2e', OWNER);
    const before = await getEnrollment('tenant-e2e', enrollmentId);
    const { status, states } = await runReplanAndResolve(OWNER, enrollmentId, { decision: 'approved', approved: true });
    expect(status).toBe('completed');
    expect(states['enrich']).toBe('completed'); // the humanizer ran on the compose→approve path
    expect(states['apply']).toBe('completed');
    expect(states['reject']).not.toBe('failed');
    const after = await getEnrollment('tenant-e2e', enrollmentId);
    expect(after?.schedulePreference?.daypart).toBe('evening');
    expect(after!.planRevision).toBe(before!.planRevision + 1);
  });

  it('REJECT ⇒ the run FAILS typed, apply is skipped, and NOTHING mutated', async () => {
    const OWNER = 'user:e2e-reject';
    const enrollmentId = await enrollParticipant('tenant-e2e', OWNER);
    const before = await getEnrollment('tenant-e2e', enrollmentId);
    const { status, states } = await runReplanAndResolve(OWNER, enrollmentId, { decision: 'reject', approved: false });
    expect(status).toBe('failed');
    expect(states['reject']).toBe('failed');
    expect(states['apply']).not.toBe('completed');
    const after = await getEnrollment('tenant-e2e', enrollmentId);
    expect(after?.schedulePreference).toBeUndefined();
    expect(after!.planRevision).toBe(before!.planRevision); // untouched
  });
});
