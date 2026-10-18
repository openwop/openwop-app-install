/**
 * ADR 0901 (DEC-1) — KickTodo workflow surfaces bind to the RUN PRINCIPAL.
 *
 * What this file proves, and what breaks each part:
 *
 *  1. COMPLETENESS — every method of every one of the nine registered
 *     `kicktodo-*` surfaces has a spec, the registered surfaces ARE those nine,
 *     and the binder refuses to build a surface with an unbound method. Breaks
 *     when a method is added to a surface without a spec, when a tenth KickTodo
 *     surface ships outside the binding, or when `bindKicktodoSurface` stops
 *     checking keys. The pinned system-callable set breaks when a method is made
 *     callable without a person (or a host job's op is made person-only) without
 *     this table being reviewed.
 *  2. THE SUBJECT TABLE — for every method with a subject arg: a matching or
 *     omitted subject passes (and is defaulted to the person when enforced); a
 *     mismatched one is `forbidden` when the toggle is ON and passes unchanged +
 *     logs `kicktodo_surface_unbound` (a closed `reasonCode`, no subject value in
 *     the line) when OFF; the cause lane behaves like the actor lane; the system lane passes
 *     unless the method is person-only. Breaks when the subject check, the
 *     shadow branch, the lane order or the personOnly branch regresses.
 *  3. THE AUTHORITY KINDS against the REAL predicates (real enrollments, real
 *     org members, a real circle): enrollment (`hasKicktodoEnrollmentAuthority`),
 *     manage (`hasKicktodoManageAuthority`), org-manage (`assertRunScopeOrg`
 *     with `host:org:manage`) and the circle-owner relation. Breaks when a spec
 *     loses its authority or a predicate stops being asked.
 *  4. ADR 0901 D3 (P2) — a person cannot make `kickbotCoachTurn` mint a job that
 *     acts as someone else, through the surface (subject binding) or the service
 *     (`boundActor` assertion), and that refusal is ALWAYS ON — it holds with the
 *     binding toggle OFF. The direct-service case and the toggle-OFF case are
 *     the sabotage witnesses for the assertion in `kickbotCoachTurnService.ts`
 *     and for the surface passing `boundActor` regardless of the toggle.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { enableTenantOverride } from '../src/host/featureToggles/service.js';
import { setNotificationBackend } from '../src/notifications/emitter.js';
import { setNotificationMuteResolver } from '../src/host/notificationPolicy.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createOrg, createMember } from '../src/host/accessControlService.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { enqueueKickbotCoachTurn } from '../src/features/kicktodo-core/kickbotCoachTurnService.js';
import { seedKicktodoConveneTurnWorkflow } from '../src/features/kicktodo-core/conveneTurnWorkflow.js';
import { loadWorkflowChainPacks, defaultWorkflowChainPackRoots, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';
import { listJobsForSubject, type ScheduledJob } from '../src/host/schedulingService.js';
import { createCircle } from '../src/features/kicktodo-accountability/circleService.js';
import { BACKEND_FEATURES } from '../src/features/index.js';
import { OpenwopError } from '../src/types.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';
import {
  bindKicktodoSurface,
  KICKTODO_RUN_PRINCIPAL_BINDING_TOGGLE,
  KICKTODO_RUN_PRINCIPAL_BINDING_TOGGLE_ID,
  type BoundSurfaceFn,
  type KicktodoMethodSpec,
} from '../src/features/kicktodo-core/surfaceBinding.js';
import { buildKicktodoCoreSurface, KICKTODO_CORE_SURFACE_SPECS } from '../src/features/kicktodo-core/surface.js';
import { KICKTODO_ACCOUNTABILITY_SURFACE_SPECS } from '../src/features/kicktodo-accountability/surface.js';
import { KICKTODO_COMMERCE_SURFACE_SPECS } from '../src/features/kicktodo-commerce/surface.js';
import { KICKTODO_COMMUNITY_SURFACE_SPECS } from '../src/features/kicktodo-community/surface.js';
import { KICKTODO_CREATOR_SURFACE_SPECS } from '../src/features/kicktodo-creator/surface.js';
import { KICKTODO_ENGAGEMENT_SURFACE_SPECS } from '../src/features/kicktodo-engagement/surface.js';
import { KICKTODO_INTEGRATIONS_SURFACE_SPECS } from '../src/features/kicktodo-integrations/surface.js';
import { KICKTODO_METRICS_SURFACE_SPECS } from '../src/features/kicktodo-metrics/surface.js';
import { KICKTODO_ORGANIZATIONS_SURFACE_SPECS } from '../src/features/kicktodo-organizations/surface.js';

type Specs = Readonly<Record<string, KicktodoMethodSpec>>;

const SPECS: Record<string, Specs> = {
  'kicktodo-core': KICKTODO_CORE_SURFACE_SPECS,
  'kicktodo-accountability': KICKTODO_ACCOUNTABILITY_SURFACE_SPECS,
  'kicktodo-commerce': KICKTODO_COMMERCE_SURFACE_SPECS,
  'kicktodo-community': KICKTODO_COMMUNITY_SURFACE_SPECS,
  'kicktodo-creator': KICKTODO_CREATOR_SURFACE_SPECS,
  'kicktodo-engagement': KICKTODO_ENGAGEMENT_SURFACE_SPECS,
  'kicktodo-integrations': KICKTODO_INTEGRATIONS_SURFACE_SPECS,
  'kicktodo-metrics': KICKTODO_METRICS_SURFACE_SPECS,
  'kicktodo-organizations': KICKTODO_ORGANIZATIONS_SURFACE_SPECS,
};

// Personal tenants for the subject table: `tenantId === subject` is the
// implicit-owner arm of `hasKicktodoManageAuthority`, so a manage method's
// MATCH case passes on its merits and only the subject check is under test.
const ALICE = 'user:rp-alice';
const CAROL = 'user:rp-carol';
const MALLORY = 'user:rp-mallory';
const P_ON = ALICE; // binding ON
const P_OFF = CAROL; // binding OFF (shadow)

// Shared workspaces for the authority cases and P2.
const T_ON = 'kt-rp-shared-on';
const T_OFF = 'kt-rp-shared-off';
const BOB = 'user:rp-bob';
const ADMIN = 'user:rp-admin';
const EDITOR = 'user:rp-editor';
const OWNER = 'user:rp-owner';
const ANON_SANDBOX = 'anon:rp-sandbox';

let orgOn = '';
const challengeOf: Record<string, string> = {};

async function seedChallenge(tenantId: string): Promise<void> {
  const draft = await createDraft({
    tenantId, title: 'Run Principal Challenge', summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'walk', day: 1, title: 'Morning walk', instructions: 'i', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(tenantId, draft.id, 1);
  challengeOf[tenantId] = draft.id;
}

async function enrolled(tenantId: string, owner: string): Promise<string> {
  const { enrollment } = await enroll({ tenantId, ownerSubject: owner, challengeId: challengeOf[tenantId]!, challengeVersion: 1, timezone: 'UTC' });
  return enrollment.id;
}

async function coachJobs(tenantId: string, owner: string): Promise<ScheduledJob[]> {
  return (await listJobsForSubject(tenantId, { kind: 'user', id: owner })).filter((j) => j.metadata?.['purpose'] === 'kickbot-coach-turn');
}

/** Run `fn` while capturing the binding's own log lines (the logger writes one
 *  JSON line per non-error entry to stdout and binds its sink at load). */
async function withLog<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; lines: Array<Record<string, unknown>>; raw: string }> {
  const chunks: string[] = [];
  const sink = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { chunks.push(String(chunk)); return true; });
  const read = () => {
    const raw = chunks.join('');
    const lines = raw.split('\n').flatMap((l) => {
      try { const o = JSON.parse(l) as Record<string, unknown>; return o.component === 'kicktodo.surfaceBinding' ? [o] : []; } catch { return []; }
    });
    return { raw: lines.map((l) => JSON.stringify(l)).join('\n'), lines };
  };
  try {
    const value = await fn();
    sink.mockRestore();
    return { value, ...read() };
  } catch (error) {
    sink.mockRestore();
    return { error, ...read() };
  }
}

/** A surface bound with the REAL specs over stub implementations that echo what
 *  they were called with — isolates the binding from each service's behaviour. */
function stubbed(surfaceId: string, scope: BundleScope) {
  const specs = SPECS[surfaceId]!;
  const calls: Array<{ method: string; args: Record<string, unknown>; enforced: boolean }> = [];
  const impl: Record<string, BoundSurfaceFn> = {};
  for (const method of Object.keys(specs)) {
    impl[method] = async (args, binding) => {
      calls.push({ method, args, enforced: binding.enforced });
      return { ok: true };
    };
  }
  return { surface: bindKicktodoSurface(surfaceId, scope, impl, specs), calls };
}

function expectRefusal(err: unknown, code: string, reason?: string): void {
  expect(err).toBeInstanceOf(OpenwopError);
  const e = err as OpenwopError;
  expect(e.code).toBe(code);
  if (reason) expect(e.details?.['reason']).toBe(reason);
}

beforeAll(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  setNotificationBackend(storage);
  setNotificationMuteResolver(async () => false);
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  _resetChainRegistryForTest();
  loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  seedKicktodoConveneTurnWorkflow();

  registerToggleDefault(KICKTODO_RUN_PRINCIPAL_BINDING_TOGGLE);
  for (const t of [P_ON, T_ON, ANON_SANDBOX]) {
    expect(await enableTenantOverride(KICKTODO_RUN_PRINCIPAL_BINDING_TOGGLE_ID, t, 'test')).toBe('enabled');
  }

  await seedChallenge(T_ON);
  await seedChallenge(T_OFF);
  const org = await createOrg({ tenantId: T_ON, name: 'Run Principal Org', createdBy: 'user:rp-setup' });
  orgOn = org.orgId;
  await createMember({ tenantId: T_ON, orgId: orgOn, subject: ADMIN, displayName: 'Ad', roles: ['admin'] });
  await createMember({ tenantId: T_ON, orgId: orgOn, subject: EDITOR, displayName: 'Ed', roles: ['editor'] });
  await createMember({ tenantId: T_ON, orgId: orgOn, subject: OWNER, displayName: 'Ow', roles: ['owner'] });
});

afterAll(() => {
  __resetHostExtPersistence();
});

describe('1 — completeness: no KickTodo surface method ships unbound', () => {
  it('the registered kicktodo-* surfaces are exactly the nine, and every built method has a spec (and vice versa)', () => {
    const registered = BACKEND_FEATURES.filter((f) => f.surface?.id.startsWith('kicktodo-'));
    expect(registered.map((f) => f.surface!.id).sort()).toEqual(Object.keys(SPECS).sort());
    for (const f of registered) {
      const built = f.surface!.build({ tenantId: 'kt-rp-completeness' });
      expect(Object.keys(built).sort(), f.surface!.id).toEqual(Object.keys(SPECS[f.surface!.id]!).sort());
    }
  });

  it('the binder refuses to build a surface with an unbound method or a spec for no method', () => {
    const fn: BoundSurfaceFn = async () => ({});
    expect(() => bindKicktodoSurface('kicktodo-x', { tenantId: 't' }, { a: fn, b: fn }, { a: { authority: 'none' } } as never)).toThrow(/unbound: \[b\]/);
    expect(() => bindKicktodoSurface('kicktodo-x', { tenantId: 't' }, { a: fn }, { a: { authority: 'none' }, z: { authority: 'none' } } as never)).toThrow(/no such method: \[z\]/);
  });

  it('every relation spec carries its predicate', () => {
    for (const [id, specs] of Object.entries(SPECS)) {
      for (const [m, s] of Object.entries(specs)) if (s.authority === 'relation') expect(typeof s.relation, `${id}.${m}`).toBe('function');
    }
  });

  it('the methods callable WITHOUT a person are exactly the host jobs’ ops plus the public reads (reviewed table)', () => {
    const systemCallable: string[] = [];
    for (const [id, specs] of Object.entries(SPECS)) {
      for (const [m, s] of Object.entries(specs)) if (!s.personOnly) systemCallable.push(`${id}.${m}`);
    }
    expect(systemCallable.sort()).toEqual([
      // host jobs (daily-loop, reminder-loop, calendar-sync, session-reminder)
      'kicktodo-accountability.sendSessionReminder',
      'kicktodo-core.evaluate',
      'kicktodo-core.kickbotCoachTurn',
      'kicktodo-core.materializeToday',
      'kicktodo-integrations.calendarSync',
      'kicktodo-integrations.remindToday',
      // no HTTP route; system-callable per ADR 0901 §5 (open question, proposed yes)
      'kicktodo-core.applyMissedWindow',
      'kicktodo-core.freezeEvidence',
      // public / model-free reads that touch no person's data
      'kicktodo-commerce.isPaid',
      'kicktodo-community.profile',
      'kicktodo-community.reviews',
      'kicktodo-core.catalogForLocale',
      'kicktodo-core.listChallenges',
      'kicktodo-creator.checkpointPlan',
      'kicktodo-creator.claimSchema',
      'kicktodo-creator.frameResearch',
      'kicktodo-creator.lessonSchema',
      'kicktodo-creator.normalizeSource',
      'kicktodo-creator.planSchema',
      'kicktodo-creator.validatePlan',
      'kicktodo-creator.verdictSchema',
      'kicktodo-organizations.catalog',
    ].sort());
  });
});

const SUBJECT_ROWS = Object.entries(SPECS).flatMap(([surfaceId, specs]) =>
  Object.entries(specs).filter(([, s]) => s.subjectArg).map(([method, s]) => ({ surfaceId, method, field: s.subjectArg!, personOnly: !!s.personOnly })));

describe('2 — the subject table (every subject-arg method)', () => {
  it('covers the 24 subject-arg methods the ADR inventories', () => {
    expect(SUBJECT_ROWS).toHaveLength(24);
  });

  for (const row of SUBJECT_ROWS) {
    const name = `${row.surfaceId}.${row.method}(${row.field})`;
    it(`${name}: match/omitted pass, mismatch forbidden ON / shadow-logged OFF, cause = actor, system ${row.personOnly ? 'refused' : 'passes'}`, async () => {
      const call = (scope: BundleScope, args: Record<string, unknown>) => {
        const s = stubbed(row.surfaceId, scope);
        return { s, run: () => s.surface[row.method]!(args) };
      };

      for (const lane of ['actor', 'cause'] as const) {
        const scopeOn: BundleScope = lane === 'actor' ? { tenantId: P_ON, actingUserId: ALICE } : { tenantId: P_ON, orgScopeSubject: ALICE };

        // match — passes, enforced
        const match = call(scopeOn, { [row.field]: ALICE });
        await match.run();
        expect(match.s.calls).toEqual([{ method: row.method, args: { [row.field]: ALICE }, enforced: true }]);

        // omitted — defaulted to the person
        const omitted = call(scopeOn, { [row.field]: '' });
        await omitted.run();
        expect(omitted.s.calls[0]!.args[row.field]).toBe(ALICE);

        // mismatch, ON — forbidden, implementation never reached
        const bad = call(scopeOn, { [row.field]: MALLORY });
        const refused = await withLog(bad.run);
        expectRefusal(refused.error, 'forbidden', 'subject_mismatch');
        expect(bad.s.calls).toEqual([]);
        expect(refused.lines.map((l) => l.msg)).toContain('kicktodo_surface_refused');
      }

      // mismatch, OFF (shadow) — today's path with the ORIGINAL args, logged
      // without any subject value
      for (const scopeOff of [{ tenantId: P_OFF, actingUserId: CAROL }, { tenantId: P_OFF, orgScopeSubject: CAROL }] as BundleScope[]) {
        const shadow = call(scopeOff, { [row.field]: MALLORY });
        const logged = await withLog(shadow.run);
        expect(logged.error).toBeUndefined();
        expect(shadow.s.calls).toEqual([{ method: row.method, args: { [row.field]: MALLORY }, enforced: false }]);
        const unbound = logged.lines.find((l) => l.msg === 'kicktodo_surface_unbound');
        expect(unbound).toMatchObject({ surface: row.surfaceId, method: row.method, reasonCode: 'kicktodo_subject_mismatch', tenant: 'personal' });
        expect(unbound).not.toHaveProperty('reasonCodeRejected');
        expect(logged.raw).not.toContain(MALLORY);
        expect(logged.raw).not.toContain(CAROL);
      }

      // system lane — host-authored args keep tenant trust unless person-only
      const sys = call({ tenantId: P_ON }, { [row.field]: MALLORY });
      const sysOut = await withLog(sys.run);
      if (row.personOnly) {
        expectRefusal(sysOut.error, 'forbidden', 'person_required');
        expect(sys.s.calls).toEqual([]);
      } else {
        expect(sysOut.error).toBeUndefined();
        expect(sys.s.calls).toEqual([{ method: row.method, args: { [row.field]: MALLORY }, enforced: true }]);
      }
    });
  }
});

describe('3 — the authority kinds, against the real predicates', () => {
  it('enrollment (core.getEnrollment / materializeToday): only the enrollment owner; foreign is a uniform not_found ON, shadow-logged OFF', async () => {
    const aliceOn = await enrolled(T_ON, ALICE);
    const aliceOff = await enrolled(T_OFF, ALICE);

    const owner = stubbed('kicktodo-core', { tenantId: T_ON, actingUserId: ALICE });
    await owner.surface.getEnrollment!({ enrollmentId: aliceOn });
    expect(owner.calls).toHaveLength(1);

    for (const scope of [{ tenantId: T_ON, actingUserId: BOB }, { tenantId: T_ON, orgScopeSubject: BOB }] as BundleScope[]) {
      const foreign = stubbed('kicktodo-core', scope);
      expectRefusal((await withLog(() => foreign.surface.getEnrollment!({ enrollmentId: aliceOn }))).error, 'not_found', 'enrollment_not_owned');
      expectRefusal((await withLog(() => foreign.surface.progress!({ enrollmentId: aliceOn }))).error, 'not_found', 'enrollment_not_owned');
      expect(foreign.calls).toEqual([]);
    }

    const shadow = stubbed('kicktodo-core', { tenantId: T_OFF, actingUserId: BOB });
    const logged = await withLog(() => shadow.surface.getEnrollment!({ enrollmentId: aliceOff }));
    expect(logged.error).toBeUndefined();
    expect(shadow.calls).toHaveLength(1);
    expect(logged.lines.find((l) => l.msg === 'kicktodo_surface_unbound')).toMatchObject({ reasonCode: 'kicktodo_enrollment_not_owned', tenant: T_OFF });

    // System lane: the daily-loop's op keeps working; the participant read does not.
    const sys = stubbed('kicktodo-core', { tenantId: T_ON });
    await sys.surface.materializeToday!({ enrollmentId: aliceOn });
    expect(sys.calls.map((c) => c.method)).toEqual(['materializeToday']);
    expectRefusal((await withLog(() => sys.surface.getEnrollment!({ enrollmentId: aliceOn }))).error, 'forbidden', 'person_required');
  });

  it('manage (metrics.activation, creator.getCandidate): host:kicktodo:manage holders only; no person ⇒ refused', async () => {
    const admin = stubbed('kicktodo-metrics', { tenantId: T_ON, actingUserId: ADMIN });
    await admin.surface.activation!({});
    expect(admin.calls).toHaveLength(1);

    for (const scope of [{ tenantId: T_ON, actingUserId: EDITOR }, { tenantId: T_ON, orgScopeSubject: EDITOR }] as BundleScope[]) {
      const editor = stubbed('kicktodo-metrics', scope);
      expectRefusal((await withLog(() => editor.surface.activation!({}))).error, 'forbidden_scope', 'manage_required');
      const creator = stubbed('kicktodo-creator', scope);
      expectRefusal((await withLog(() => creator.surface.getCandidate!({ candidateId: 'c1' }))).error, 'forbidden_scope', 'manage_required');
      expect([...editor.calls, ...creator.calls]).toEqual([]);
    }

    // The route's implicit personal-workspace owner, run-lane form (actor only).
    // The anon principal holds no scope in its sandbox, so only the short-circuit
    // admits it (the tenant is ON, so a missing short-circuit is a refusal, not a
    // shadow pass); the same subject without the stamp is refused.
    const anonOwner = stubbed('kicktodo-metrics', { tenantId: ANON_SANDBOX, actingUserId: 'session:rp-sandbox', personalTenant: ANON_SANDBOX });
    await anonOwner.surface.activation!({});
    expect(anonOwner.calls).toHaveLength(1);
    const unstamped = stubbed('kicktodo-metrics', { tenantId: ANON_SANDBOX, actingUserId: 'session:rp-sandbox' });
    expectRefusal((await withLog(() => unstamped.surface.activation!({}))).error, 'forbidden_scope', 'manage_required');

    const sys = stubbed('kicktodo-metrics', { tenantId: T_ON });
    expectRefusal((await withLog(() => sys.surface.activation!({}))).error, 'forbidden', 'person_required');
  });

  it('org-manage (organizations.report): host:org:manage in that org (owner), not admin; org required; no person ⇒ refused', async () => {
    const owner = stubbed('kicktodo-organizations', { tenantId: T_ON, actingUserId: OWNER });
    await owner.surface.report!({ orgId: orgOn });
    expect(owner.calls).toHaveLength(1);

    const admin = stubbed('kicktodo-organizations', { tenantId: T_ON, actingUserId: ADMIN });
    expectRefusal((await withLog(() => admin.surface.report!({ orgId: orgOn }))).error, 'forbidden_scope');
    expectRefusal((await withLog(() => admin.surface.report!({}))).error, 'validation_error', 'org_required');
    expect(admin.calls).toEqual([]);

    const sys = stubbed('kicktodo-organizations', { tenantId: T_ON });
    expectRefusal((await withLog(() => sys.surface.report!({ orgId: orgOn }))).error, 'forbidden', 'person_required');
    await sys.surface.catalog!({ orgId: orgOn }); // the public library read stays open
    expect(sys.calls.map((c) => c.method)).toEqual(['catalog']);
  });

  it('relation (accountability.sendSessionReminder): the circle owner, or the host job; anyone else is not_found', async () => {
    const enr = await enrolled(T_ON, ALICE);
    const circle = await createCircle({ tenantId: T_ON, type: 'coach', enrollmentId: enr, ownerSubject: ALICE, name: 'RP circle' });
    const args = { circleId: circle.id, atIso: new Date(Date.now() + 3_600_000).toISOString() };

    const owner = stubbed('kicktodo-accountability', { tenantId: T_ON, actingUserId: ALICE });
    await owner.surface.sendSessionReminder!(args);
    expect(owner.calls).toHaveLength(1);

    const other = stubbed('kicktodo-accountability', { tenantId: T_ON, actingUserId: BOB });
    expectRefusal((await withLog(() => other.surface.sendSessionReminder!(args))).error, 'not_found', 'relation_denied');
    expectRefusal((await withLog(() => other.surface.sendSessionReminder!({ ...args, circleId: 'circle:absent' }))).error, 'not_found', 'relation_denied');
    expect(other.calls).toEqual([]);

    const job = stubbed('kicktodo-accountability', { tenantId: T_ON });
    await job.surface.sendSessionReminder!(args);
    expect(job.calls).toHaveLength(1);
  });
});

describe('4 — ADR 0901 D3: a person cannot mint a coach turn that acts as someone else', () => {
  it('through the REAL surface (binding ON): naming another participant is forbidden and mints nothing', async () => {
    const victim = 'user:rp-p2-victim';
    const enr = await enrolled(T_ON, victim);
    const core = buildKicktodoCoreSurface({ tenantId: T_ON, actingUserId: BOB });
    expectRefusal((await withLog(() => core.kickbotCoachTurn!({ enrollmentId: enr, ownerSubject: victim }))).error, 'forbidden', 'subject_mismatch');
    // Omitting the subject binds it to the caller, whose enrollment this is not.
    expect(await core.kickbotCoachTurn!({ enrollmentId: enr })).toMatchObject({ queued: false, reason: 'not-found' });
    expect(await coachJobs(T_ON, victim)).toEqual([]);
    expect(await coachJobs(T_ON, BOB)).toEqual([]);
  });

  it('through the SERVICE: a boundActor that differs from the job’s actingUserId is refused before the scheduler (sabotage witness)', async () => {
    const victim = 'user:rp-p2-direct';
    const enr = await enrolled(T_ON, victim);
    const err = await enqueueKickbotCoachTurn(T_ON, { ownerSubject: victim, enrollmentId: enr, occasion: 'reminder', boundActor: BOB })
      .then(() => undefined, (e: unknown) => e);
    expectRefusal(err, 'forbidden', 'actor_mismatch');
    expect(await coachJobs(T_ON, victim)).toEqual([]);
    // The same request with the matching actor IS minted — the refusal above is the assertion, not a dead enrollment.
    expect(await enqueueKickbotCoachTurn(T_ON, { ownerSubject: victim, enrollmentId: enr, occasion: 'reminder', boundActor: victim })).toMatchObject({ queued: true });
    expect((await coachJobs(T_ON, victim))[0]?.metadata?.['actingUserId']).toBe(victim);
  });

  it('the person’s own turn is minted acting as that person; the host reminder-loop (system lane) still mints', async () => {
    const self = 'user:rp-p2-self';
    const selfEnr = await enrolled(T_ON, self);
    const mine = await buildKicktodoCoreSurface({ tenantId: T_ON, actingUserId: self }).kickbotCoachTurn!({ enrollmentId: selfEnr });
    expect(mine).toMatchObject({ queued: true });
    const [job] = await coachJobs(T_ON, self);
    expect(job?.metadata?.['actingUserId']).toBe(self);

    const sysOwner = 'user:rp-p2-system';
    const sysEnr = await enrolled(T_ON, sysOwner);
    const viaJob = await buildKicktodoCoreSurface({ tenantId: T_ON }).kickbotCoachTurn!({ enrollmentId: sysEnr, ownerSubject: sysOwner });
    expect(viaJob).toMatchObject({ queued: true });
    expect((await coachJobs(T_ON, sysOwner))[0]?.metadata?.['actingUserId']).toBe(sysOwner);
  });

  it('with the binding OFF (shadow) the D3 refusal STILL holds — always on, logged as unbound, mints nothing (sabotage witness)', async () => {
    const victim = 'user:rp-p2-shadow';
    const enr = await enrolled(T_OFF, victim);
    const logged = await withLog(() => buildKicktodoCoreSurface({ tenantId: T_OFF, actingUserId: BOB }).kickbotCoachTurn!({ enrollmentId: enr, ownerSubject: victim }));
    expectRefusal(logged.error, 'forbidden', 'actor_mismatch');
    expect(logged.lines.find((l) => l.msg === 'kicktodo_surface_unbound')).toMatchObject({ method: 'kickbotCoachTurn', reasonCode: 'kicktodo_subject_mismatch' });
    expect(await coachJobs(T_OFF, victim)).toEqual([]);
    // The cause lane is a person lane too.
    const viaCause = await withLog(() => buildKicktodoCoreSurface({ tenantId: T_OFF, orgScopeSubject: BOB }).kickbotCoachTurn!({ enrollmentId: enr, ownerSubject: victim }));
    expectRefusal(viaCause.error, 'forbidden', 'actor_mismatch');
    expect(await coachJobs(T_OFF, victim)).toEqual([]);
    // Shadow keeps everything else as today: the victim's own turn still mints.
    expect(await buildKicktodoCoreSurface({ tenantId: T_OFF, actingUserId: victim }).kickbotCoachTurn!({ enrollmentId: enr, ownerSubject: victim })).toMatchObject({ queued: true });
    expect((await coachJobs(T_OFF, victim))[0]?.metadata?.['actingUserId']).toBe(victim);
  });
});
