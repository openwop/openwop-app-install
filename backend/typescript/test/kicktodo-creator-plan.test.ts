/**
 * ADR 0415 P2 — Challenge Plan gates + decomposition:
 *
 *  - the registered `kicktodo.challenge-plan` schema is DRIFT-PINNED to the
 *    producer contract (a real valid plan validates)
 *  - `validatePlan` catches every deterministic defect class (orphan
 *    achievements, unserved outcomes, untraceable days, stacked workload,
 *    missing recovery) and reports ALL of them (error-fed repair input)
 *  - `draftFromPlan` transforms a VALIDATED plan into a kicktodo-core draft
 *    (the ONE challenge owner) and refuses invalid plans with the typed
 *    defect list — never a partial draft
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { validateArtifact } from '../src/host/artifactTypes.js';
import { registerKicktodoCreatorArtifactTypes, CHALLENGE_PLAN_TYPE } from '../src/features/kicktodo-creator/artifactSchemas.js';
import { validatePlan, draftFromPlan, PlanInvalidError, type ChallengePlan } from '../src/features/kicktodo-creator/planService.js';
import { getChallenge, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { createCandidate, getCandidate, setCandidateDraft, setCandidatePublished, __setCandidateWithdrawn } from '../src/features/kicktodo-creator/creatorService.js';
import { publicationView, submitForPublication, PublicationGateError } from '../src/features/kicktodo-creator/publishService.js';

const TENANT = 'tenant-plan';

const VALID: ChallengePlan = {
  title: 'Two-Week Focus Reset',
  promise: 'Reliable daily focus blocks without burnout',
  audience: 'busy professionals',
  durationDays: 7,
  dailyMinutesBudget: 20,
  outcomes: [{ outcomeId: 'o1', measurableOutcome: 'Five 25-minute focus blocks completed per week', method: 'completed check-ins' }],
  achievements: [{ achievementId: 'a1', observableEvidence: 'A completed 25-minute block with a note', outcomeIds: ['o1'] }],
  days: [
    { day: 1, stableActivityId: 'd1-first-block', title: 'One small block', actionInstruction: 'Run one 10-minute focus block.', userFacingWhy: 'A small win proves the system.', estimatedMinutes: 10, achievementIds: ['a1'], evidencePolicy: 'attestation' },
    { day: 2, stableActivityId: 'd2-full-block', title: 'One full block', actionInstruction: 'Run one 25-minute block.', userFacingWhy: 'Full length builds the muscle.', estimatedMinutes: 25 * 0 + 20, achievementIds: ['a1'], evidencePolicy: 'note' },
    { day: 7, stableActivityId: 'd7-review', title: 'Review the week', actionInstruction: 'Review which blocks worked.', userFacingWhy: 'Consolidation locks in the habit.', estimatedMinutes: 10, achievementIds: ['a1'], evidencePolicy: 'note', isRecovery: true },
  ],
};

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerKicktodoCreatorArtifactTypes();
});

describe('schema ↔ producer parity', () => {
  it('a real valid plan validates against the registered artifact schema', () => {
    const v = validateArtifact(CHALLENGE_PLAN_TYPE, VALID as unknown as Record<string, unknown>);
    expect(v.registered).toBe(true);
    expect(v.valid, JSON.stringify(v.errors)).toBe(true);
  });
});

describe('validatePlan — every defect class reported', () => {
  it('a valid plan has zero defects', () => {
    expect(validatePlan(VALID)).toEqual([]);
  });

  it('orphan achievements, unserved outcomes, untraceable days, stacked load, missing recovery — ALL reported at once', () => {
    const bad: ChallengePlan = {
      ...VALID,
      outcomes: [...VALID.outcomes, { outcomeId: 'o2', measurableOutcome: 'Unserved outcome', method: 'x' }],
      achievements: [
        ...VALID.achievements,
        { achievementId: 'a-orphan', observableEvidence: 'x', outcomeIds: ['o-missing'] },
      ],
      days: [
        { ...VALID.days[0], achievementIds: ['a-missing'] },
        { ...VALID.days[1], stableActivityId: 'd2-x', estimatedMinutes: 90 }, // stacked vs 20min budget
      ],
    };
    const codes = validatePlan(bad).map((d) => d.code);
    expect(codes).toContain('achievement-orphaned');
    expect(codes).toContain('outcome-unserved');
    expect(codes).toContain('day-untraceable');
    expect(codes).toContain('workload-stacked');
    expect(codes).toContain('no-recovery');
  });
});

describe('ADR 0458 §2.2 correction — claimRefs are closed-world provenance', () => {
  const withRefs: ChallengePlan = { ...VALID, days: [{ ...VALID.days[0], claimRefs: ['c-1'] }, ...VALID.days.slice(1)] };

  it('refs are unchecked when no dossier world is given (a plan with no research in scope keeps its meaning)', () => {
    expect(validatePlan(withRefs)).toEqual([]);
  });

  it('a ref the dossier never recorded is a typed defect naming the id; a listed ref passes', () => {
    expect(validatePlan(withRefs, { knownClaimIds: ['c-1', 'c-2'] })).toEqual([]);
    const defects = validatePlan(withRefs, { knownClaimIds: ['c-2'] });
    expect(defects.map((d) => d.code)).toEqual(['claim-ref-unknown']);
    expect(defects[0].message).toContain('c-1');
    expect(defects[0].ref).toBe('d1-first-block');
  });

  it('malformed refs are a structural defect, never a crash', () => {
    const bad = { ...withRefs, days: [{ ...withRefs.days[0], claimRefs: ['', 3] }, ...withRefs.days.slice(1)] } as unknown as ChallengePlan;
    expect(validatePlan(bad, { knownClaimIds: ['c-1'] }).map((d) => d.code)).toEqual(['claim-refs-malformed']);
  });

  it('re-grade KTF-EV-1 — the closed world is the SUPPORTED claim ids only', async () => {
    const { supportedClaimIds } = await import('../src/features/kicktodo-creator/creatorService.js');
    const dossier = {
      questions: [], engines: ['brave'], recordedAt: new Date().toISOString(),
      sources: [{ url: 'https://example.org/a', domain: 'example.org', title: 'A', hash: 'h-a', engine: 'brave' }],
      claims: [
        { claimId: 'c-ok', text: 'supported', sourceHashes: ['h-a'] },
        { claimId: 'c-unsup', text: 'recorded but unsupported', sourceHashes: ['h-missing'] },
        { claimId: 'c-contra', text: 'verdict contradicts', sourceHashes: ['h-a'], support: [{ sourceHash: 'h-a', verdict: 'contradicts' }] },
      ],
      unsupportedClaimIds: ['c-unsup'],
    } as unknown as Parameters<typeof supportedClaimIds>[0];
    expect(supportedClaimIds(dossier)).toEqual(['c-ok']);
    const plan: ChallengePlan = { ...VALID, days: [{ ...VALID.days[0], claimRefs: ['c-unsup'] }, ...VALID.days.slice(1)] };
    expect(validatePlan(plan, { knownClaimIds: supportedClaimIds(dossier) }).map((d) => d.code)).toEqual(['claim-ref-unknown']);
  });

  it('the artifact schema admits claimRefs (schema ↔ producer parity holds for the new field)', () => {
    const v = validateArtifact(CHALLENGE_PLAN_TYPE, withRefs as unknown as Record<string, unknown>);
    expect(v.valid, JSON.stringify(v.errors)).toBe(true);
  });

  it('draftFromPlan carries claimRefs onto the activity verbatim, and refuses an unknown ref typed', async () => {
    const draft = await draftFromPlan(TENANT, 'u1', withRefs);
    expect(draft.activities[0].claimRefs).toEqual(['c-1']);
    expect(draft.activities[1].claimRefs).toBeUndefined();
    await expect(draftFromPlan(TENANT, 'u1', withRefs, undefined, { knownClaimIds: ['c-2'] })).rejects.toBeInstanceOf(PlanInvalidError);
  });
});

describe('setCandidateDraft — TD1 candidate→draft binding (ADR 0441)', () => {
  it('stamps the draft ref + moves to planned; latest-wins; terminal states refuse a rebind', async () => {
    const c = await createCandidate({
      tenantId: TENANT, createdBy: 'user:planner', topic: 'productivity basics',
      audience: 'busy professionals', transformation: 'more focus', durationDaysTarget: 7, dailyMinutesTarget: 20,
    });
    // bind → ref stamped, state advances to planned
    const bound = await setCandidateDraft(TENANT, c.id, 'chal:abc', 1);
    expect(bound?.draft).toEqual({ challengeId: 'chal:abc', challengeVersion: 1 });
    expect(bound?.state).toBe('planned');
    expect((await getCandidate(TENANT, c.id))?.draft?.challengeId).toBe('chal:abc');
    // re-decompose repoints to the newest draft (idempotent latest-wins)
    const rebound = await setCandidateDraft(TENANT, c.id, 'chal:def', 1);
    expect(rebound?.draft?.challengeId).toBe('chal:def');
    // a withdrawn candidate refuses a rebind — the retired candidate is never re-pointed
    await __setCandidateWithdrawn(TENANT, c.id, 'test', 'user:op');
    const afterWithdraw = await setCandidateDraft(TENANT, c.id, 'chal:xyz', 1);
    expect(afterWithdraw?.state).toBe('withdrawn');
    expect(afterWithdraw?.draft?.challengeId).toBe('chal:def'); // unchanged
  });
  it('returns null for an unknown candidate', async () => {
    expect(await setCandidateDraft(TENANT, 'cand:nope', 'chal:x', 1)).toBeNull();
  });
});

describe('publication grade fixes (KT-EXP-7/9 + KTEXP2-1)', () => {
  it('publicationView derives state — submitted until completedAt, then completed (KT-EXP-7)', () => {
    const base = { approvalId: 'a', challengeId: 'chal:1', challengeVersion: 1, submittedBy: 'u1', rightsDecisions: [] };
    expect(publicationView(base).state).toBe('submitted');
    expect(publicationView({ ...base, completedBy: 'u2', completedAt: '2026-07-19T00:00:00Z' }).state).toBe('completed');
  });

  it('setCandidatePublished advances planned→published; withdrawn refuses (KT-EXP-9)', async () => {
    const c = await createCandidate({ tenantId: TENANT, createdBy: 'u1', topic: 'productivity basics', audience: 'a', transformation: 't', durationDaysTarget: 7, dailyMinutesTarget: 20 });
    await setCandidateDraft(TENANT, c.id, 'chal:p', 1);
    expect((await setCandidatePublished(TENANT, c.id))?.state).toBe('published');
    const w = await createCandidate({ tenantId: TENANT, createdBy: 'u1', topic: 'productivity basics', audience: 'a', transformation: 't', durationDaysTarget: 7, dailyMinutesTarget: 20 });
    await __setCandidateWithdrawn(TENANT, w.id, 'test', 'op');
    expect((await setCandidatePublished(TENANT, w.id))?.state).toBe('withdrawn');
  });

  it('submitForPublication refuses a challenge that is not the candidate’s bound draft (KTEXP2-1)', async () => {
    const c = await createCandidate({ tenantId: TENANT, createdBy: 'u1', topic: 'productivity basics', audience: 'a', transformation: 't', durationDaysTarget: 7, dailyMinutesTarget: 20 });
    await setCandidateDraft(TENANT, c.id, 'chal:bound', 1);
    // a mismatched challenge is rejected BEFORE any gate — the binding is authoritative
    await expect(submitForPublication(TENANT, c.id, 'chal:OTHER', 1, 'u1')).rejects.toBeInstanceOf(PublicationGateError);
  });
});

describe('KT-EXP-8 — deterministic decompose draft id (ADR 0441 §4)', () => {
  it('same candidate → same draft id (overwrite, not orphan); ktc- prefix', async () => {
    const c = await createCandidate({ tenantId: TENANT, createdBy: 'u1', topic: 'productivity basics', audience: 'a', transformation: 't', durationDaysTarget: 7, dailyMinutesTarget: 20 });
    const d1 = await draftFromPlan(TENANT, 'u1', VALID, c.id);
    const d2 = await draftFromPlan(TENANT, 'u1', VALID, c.id);
    expect(d1.id).toBe(d2.id);
    expect(d1.id).toMatch(/^chal:ktc-/);
  });

  it('a bare decompose (no candidateId) keeps a fresh random id', async () => {
    const a = await draftFromPlan(TENANT, 'u1', VALID);
    const b = await draftFromPlan(TENANT, 'u1', VALID);
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^chal:[0-9a-f-]{36}$/);
  });

  it('re-decompose after publish does NOT overwrite the frozen published version', async () => {
    const c = await createCandidate({ tenantId: TENANT, createdBy: 'u1', topic: 'productivity basics', audience: 'a', transformation: 't', durationDaysTarget: 7, dailyMinutesTarget: 20 });
    const d = await draftFromPlan(TENANT, 'u1', VALID, c.id);
    await publishChallenge(TENANT, d.id, 1);
    const again = await draftFromPlan(TENANT, 'u1', VALID, c.id);
    expect(again.id).toBe(d.id);
    expect(again.status).toBe('published'); // the guard returned the frozen row, not a new draft
  });
});

describe('draftFromPlan — the deterministic decomposition', () => {
  it('a validated plan becomes a kicktodo-core draft (the single owner)', async () => {
    const draft = await draftFromPlan(TENANT, 'user:planner', VALID);
    expect(draft.status).toBe('draft');
    expect(draft.durationDays).toBe(7);
    expect(draft.activities).toHaveLength(3);
    // The draft lives in the kicktodo-core owner — readable through it.
    const found = await getChallenge(TENANT, draft.id, 1);
    expect(found?.title).toBe('Two-Week Focus Reset');
  });

  it('an invalid plan is refused with the full typed defect list — no partial draft', async () => {
    const bad = { ...VALID, days: [] };
    await expect(draftFromPlan(TENANT, 'user:planner', bad)).rejects.toBeInstanceOf(PlanInvalidError);
    try {
      await draftFromPlan(TENANT, 'user:planner', bad);
    } catch (err) {
      expect((err as PlanInvalidError).defects.map((d) => d.code)).toContain('no-days');
    }
  });
});

/**
 * GC-4 — `validatePlan` must be TOTAL over untrusted input: a malformed plan
 * (the workflow node forwards `args.plan` as `unknown`) must yield a defect
 * list, NEVER an uncaught TypeError that becomes a raw 500 instead of the typed
 * `plan_invalid` the repair loop needs. Each shape below crashed the old code,
 * which the `as unknown as ChallengePlan` cast concealed from the compiler.
 */
describe('GC-4 — validatePlan is total over malformed model output', () => {
  const cases: Array<[string, unknown]> = [
    ['null', null],
    ['a string', 'not a plan'],
    ['an array', []],
    ['missing everything', {}],
    ['outcomes as a non-array string', { title: 't', durationDays: 7, dailyMinutesBudget: 20, outcomes: 'x', achievements: [], days: [] }],
    ['a day missing achievementIds', { title: 't', durationDays: 7, dailyMinutesBudget: 20, outcomes: [], achievements: [], days: [{ stableActivityId: 'a', day: 1 }] }],
    ['achievements as a number', { title: 't', durationDays: 7, dailyMinutesBudget: 20, outcomes: [], achievements: 3, days: [] }],
    // Element-level malformation the structural gate does not name — caught by
    // the totality backstop (these threw a TypeError before the backstop existed).
    ['a null outcome element', { title: 't', durationDays: 7, dailyMinutesBudget: 20, outcomes: [null], achievements: [], days: [] }],
    ['a numeric measurableOutcome', { title: 't', durationDays: 7, dailyMinutesBudget: 20, outcomes: [{ outcomeId: 'o1', measurableOutcome: 5, method: 'm' }], achievements: [], days: [] }],
    ['a null achievement element', { title: 't', durationDays: 7, dailyMinutesBudget: 20, outcomes: [], achievements: [null], days: [] }],
    ['a non-array alternatives', { title: 't', durationDays: 7, dailyMinutesBudget: 20, outcomes: [], achievements: [], days: [{ stableActivityId: 'a', day: 1, achievementIds: [], alternatives: 5 }] }],
  ];

  for (const [label, input] of cases) {
    it(`returns defects (never throws) for ${label}`, () => {
      let defects: ReturnType<typeof validatePlan>;
      expect(() => { defects = validatePlan(input); }).not.toThrow();
      expect(defects!.length).toBeGreaterThan(0);
    });
  }

  it('draftFromPlan refuses malformed input with the typed error, not a crash', async () => {
    await expect(draftFromPlan(TENANT, 'user:a', { outcomes: 'x' }))
      .rejects.toBeInstanceOf(PlanInvalidError);
    await expect(draftFromPlan(TENANT, 'user:a', null))
      .rejects.toBeInstanceOf(PlanInvalidError);
  });

  it('names element-shape malformation with a SPECIFIC structural code (not just the backstop)', () => {
    // The structural gate verifies element records, so isChallengePlan is honest
    // and the repair loop gets an actionable code rather than a generic one.
    expect(validatePlan({ title: 't', durationDays: 7, dailyMinutesBudget: 20, outcomes: [null], achievements: [], days: [] }).map((d) => d.code))
      .toContain('outcomes-malformed');
    expect(validatePlan({ title: 't', durationDays: 7, dailyMinutesBudget: 20, outcomes: [], achievements: [3], days: [] }).map((d) => d.code))
      .toContain('achievements-malformed');
    expect(validatePlan({ title: 't', durationDays: 7, dailyMinutesBudget: 20, outcomes: [], achievements: [], days: [{ stableActivityId: 'a', day: 1, achievementIds: [], alternatives: 5 }] }).map((d) => d.code))
      .toContain('day-malformed');
  });

  it('GC-9 — a day without a title is a defect (not an empty-titled activity)', () => {
    const noTitle = {
      ...VALID,
      days: VALID.days.map((d, i) => (i === 0 ? { ...d, title: '' } : d)),
    };
    expect(validatePlan(noTitle).map((x) => x.code)).toContain('day-incomplete');
  });

  it('still validates a well-formed plan (no false structural defect)', () => {
    expect(validatePlan(VALID)).toEqual([]);
  });
});

describe('depth facet flows plan → draft (ADR 0443 R4)', () => {
  it('a plan depthLevel lands on the draft; absent stays absent (unlabeled)', async () => {
    const withDepth = await draftFromPlan(TENANT, 'user:planner', { ...VALID, depthLevel: 'beginner' as const });
    expect(withDepth.depthLevel).toBe('beginner');
    const without = await draftFromPlan(TENANT, 'user:planner', VALID);
    expect(without.depthLevel).toBeUndefined();
  });
});
