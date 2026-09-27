/**
 * ADR 0458 §2.3 / Phase 3 — the `challenge-outline` canvas type.
 *
 * The canvas is a WORKING DRAFT for structured editing between chat turns; the
 * candidate's VALIDATED plan revision stays the ONLY truth. This suite pins:
 *
 *  - plan⇄doc is LOSSLESS (plan→doc→plan deep-equals) across representative
 *    plans incl. alternatives / recovery / empty-achievements;
 *  - the canvas `validate` hook is STRUCTURE-only — it rejects malformed docs
 *    but accepts a still-incomplete working draft (plan-law stays `validatePlan`);
 *  - the plan revision is the SSoT: `setCandidatePlan` increments monotonically,
 *    terminal candidates refuse a re-record, and `deriveAndBindCandidateDraft`
 *    stamps the revision + re-derives the draft in ONE shared path;
 *  - the ensure flow is idempotent (never reseeds an existing canvas);
 *  - apply is draft→validate→persist: an edited day flows into BOTH the SSoT
 *    revision and the re-derived draft; a plan-law violation returns defects
 *    with NO revision bump + an untouched draft; an already-published draft id
 *    is a typed conflict;
 *  - the ensure/apply routes are privileged authoring-family routes.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  planToOutlineDoc,
  outlineDocToPlan,
  validateOutlineDoc,
  outlineCanvasId,
  CHALLENGE_OUTLINE_CANVAS_TYPE,
  CHALLENGE_OUTLINE_COMPONENTS,
  type OutlineDoc,
} from '../src/features/kicktodo-creator/outlineDoc.js';
import { validatePlan, type ChallengePlan } from '../src/features/kicktodo-creator/planService.js';
import {
  createCandidate,
  getCandidatePlan,
  setCandidatePlan,
  deriveAndBindCandidateDraft,
  DraftAlreadyPublishedError,
  __setCandidateWithdrawn,
} from '../src/features/kicktodo-creator/creatorService.js';
import { getLatest, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { ensureCanvasForTenant, getCanvasForTenant, updateCanvasForTenant } from '../src/host/canvasSurface.js';
import { KICKTODO_CREATOR_ROUTES } from '../src/features/kicktodo-creator/routes.js';

const TENANT = 'tenant-outline';
const AUTHOR = 'user:author';

/** A plan that passes `validatePlan` (7-day span with a recovery day + one
 *  substitutable day) — the apply/derive paths need a legal plan. */
const VALID: ChallengePlan = {
  title: 'Two-Week Focus Reset',
  promise: 'Reliable daily focus blocks without burnout',
  audience: 'busy professionals',
  durationDays: 7,
  dailyMinutesBudget: 20,
  outcomes: [{ outcomeId: 'o1', measurableOutcome: 'Five 25-minute focus blocks completed per week', method: 'completed check-ins' }],
  achievements: [{ achievementId: 'a1', observableEvidence: 'A completed 25-minute block with a note', outcomeIds: ['o1'] }],
  days: [
    { day: 1, stableActivityId: 'd1-first-block', title: 'One small block', actionInstruction: 'Run one 10-minute focus block.', userFacingWhy: 'A small win proves the system.', estimatedMinutes: 10, achievementIds: ['a1'], evidencePolicy: 'attestation', alternatives: [{ stableActivityId: 'd1-alt', title: 'Seated block', actionInstruction: 'Run the block seated.', evidencePolicy: 'attestation' }] },
    { day: 2, stableActivityId: 'd2-full-block', title: 'One full block', actionInstruction: 'Run one 25-minute block.', userFacingWhy: 'Full length builds the muscle.', estimatedMinutes: 20, achievementIds: ['a1'], evidencePolicy: 'note' },
    { day: 7, stableActivityId: 'd7-review', title: 'Review the week', actionInstruction: 'Review which blocks worked.', userFacingWhy: 'Consolidation locks in the habit.', estimatedMinutes: 10, achievementIds: ['a1'], evidencePolicy: 'note', isRecovery: true },
  ],
};

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

/** Representative plans for the lossless round-trip — deliberately spanning the
 *  optional-field matrix (depthLevel present/absent, isRecovery true/false/absent,
 *  alternatives present/absent, achievements empty/non-empty). These are shape
 *  fixtures, NOT plan-law valid — the round trip is pure structure. */
function representativePlans(): ChallengePlan[] {
  const base = (over: Partial<ChallengePlan>): ChallengePlan => ({
    title: 'T', promise: 'P', audience: 'A', durationDays: 3, dailyMinutesBudget: 15,
    outcomes: [{ outcomeId: 'o1', measurableOutcome: 'm', method: 'x' }],
    achievements: [{ achievementId: 'a1', observableEvidence: 'e', outcomeIds: ['o1'] }],
    days: [{ day: 1, stableActivityId: 's1', title: 'D1', actionInstruction: 'do', userFacingWhy: 'why', estimatedMinutes: 10, achievementIds: ['a1'], evidencePolicy: 'attestation' }],
    ...over,
  });
  return [
    VALID,
    base({}),
    base({ depthLevel: 'beginner' }),
    base({ achievements: [] }), // empty-achievements
    base({ days: [{ day: 1, stableActivityId: 's1', title: 'D1', actionInstruction: 'do', userFacingWhy: 'why', estimatedMinutes: 10, achievementIds: [], evidencePolicy: 'photo', isRecovery: false }] }),
    base({ days: [{ day: 1, stableActivityId: 's1', title: 'D1', actionInstruction: 'do', userFacingWhy: 'why', estimatedMinutes: 10, achievementIds: ['a1'], evidencePolicy: 'note', isRecovery: true, alternatives: [{ stableActivityId: 's1-alt', title: 'Alt', actionInstruction: 'alt', evidencePolicy: 'measurement' }] }] }),
  ];
}

describe('plan⇄doc round-trip is lossless (ADR 0458 §2.3)', () => {
  it('plan → doc → plan deep-equals for representative plans', () => {
    for (const plan of representativePlans()) {
      const back = outlineDocToPlan(planToOutlineDoc(plan) as unknown as Record<string, unknown>);
      expect(back).toEqual(plan);
    }
  });

  it('the frames array carries exactly one outline frame named for the plan', () => {
    const doc = planToOutlineDoc(VALID);
    expect(doc.frames).toHaveLength(1);
    expect(doc.frames[0].id).toBe('outline');
    expect(doc.frames[0].name).toBe(VALID.title);
    expect(doc.frames[0].days).toHaveLength(VALID.days.length);
  });
});

describe('validateOutlineDoc is structure-only (ADR 0458 §2.3)', () => {
  it('accepts a plan-seeded doc AND a still-empty working draft', () => {
    expect(validateOutlineDoc(planToOutlineDoc(VALID) as unknown as Record<string, unknown>).errors).toEqual([]);
    const skeleton: OutlineDoc = { meta: { title: 'T', promise: 'P', audience: 'A', durationDays: 5, dailyMinutesBudget: 10 }, outcomes: [], achievements: [], frames: [{ id: 'outline', name: 'T', days: [] }] };
    expect(validateOutlineDoc(skeleton as unknown as Record<string, unknown>).errors).toEqual([]);
  });

  it('rejects malformed docs (missing meta, wrong frame id, extra frame, bad day node)', () => {
    expect(validateOutlineDoc({}).errors.length).toBeGreaterThan(0);
    const twoFrames = { ...planToOutlineDoc(VALID), frames: [planToOutlineDoc(VALID).frames[0], planToOutlineDoc(VALID).frames[0]] };
    expect(validateOutlineDoc(twoFrames as unknown as Record<string, unknown>).errors.some((e) => e.path === 'frames')).toBe(true);
    const badId = planToOutlineDoc(VALID) as unknown as { frames: { id: string }[] };
    badId.frames[0].id = 'nope';
    expect(validateOutlineDoc(badId as unknown as Record<string, unknown>).errors.some((e) => e.path === 'frames[0].id')).toBe(true);
    const badDay = planToOutlineDoc(VALID) as unknown as { frames: { days: { props: Record<string, unknown> }[] }[] };
    delete badDay.frames[0].days[0].props.title;
    expect(validateOutlineDoc(badDay as unknown as Record<string, unknown>).errors.some((e) => e.path.endsWith('.props.title'))).toBe(true);
  });
});

describe('the plan revision is the SSoT (ADR 0458 §2.3)', () => {
  it('setCandidatePlan increments the revision; getCandidatePlan reads it back; terminal candidates refuse', async () => {
    const c = await createCandidate({ tenantId: TENANT, createdBy: AUTHOR, topic: 'daily focus practice', audience: 'busy professionals', transformation: 'a reliable focus habit', durationDaysTarget: 7, dailyMinutesTarget: 15 });
    expect(await getCandidatePlan(TENANT, c.id)).toBeNull();
    const r1 = await setCandidatePlan(TENANT, c.id, VALID);
    expect(r1?.plan?.revision).toBe(1);
    const r2 = await setCandidatePlan(TENANT, c.id, { ...VALID, title: 'v2' });
    expect(r2?.plan?.revision).toBe(2);
    expect((await getCandidatePlan(TENANT, c.id))?.plan.title).toBe('v2');
    await __setCandidateWithdrawn(TENANT, c.id, 'test', AUTHOR);
    await setCandidatePlan(TENANT, c.id, { ...VALID, title: 'v3' });
    expect((await getCandidatePlan(TENANT, c.id))?.revision).toBe(2); // unchanged — terminal refused
  });
});

describe('ensure is idempotent — never reseeds an existing canvas', () => {
  it('a second ensure returns the same canvas and keeps an intervening edit', async () => {
    const c = await createCandidate({ tenantId: TENANT, createdBy: AUTHOR, topic: 'daily focus practice', audience: 'a', transformation: 't', durationDaysTarget: 7, dailyMinutesTarget: 15 });
    const canvasId = outlineCanvasId(TENANT, c.id);
    const skeleton: OutlineDoc = { meta: { title: c.topic, promise: c.transformation, audience: c.audience, durationDays: 7, dailyMinutesBudget: 15 }, outcomes: [], achievements: [], frames: [{ id: 'outline', name: c.topic, days: [] }] };
    const first = await ensureCanvasForTenant(TENANT, canvasId, { canvasTypeId: CHALLENGE_OUTLINE_CANVAS_TYPE, initialState: skeleton });
    expect(first.canvasId).toBe(canvasId);
    // Edit the working draft.
    const edited = { ...skeleton, meta: { ...skeleton.meta, title: 'Edited' } };
    await updateCanvasForTenant(TENANT, canvasId, edited, { merge: 'replace' });
    // A second ensure with a DIFFERENT seed must return the SAME canvas, unreseeded.
    const second = await ensureCanvasForTenant(TENANT, canvasId, { canvasTypeId: CHALLENGE_OUTLINE_CANVAS_TYPE, initialState: planToOutlineDoc(VALID) });
    expect(second.canvasId).toBe(canvasId);
    const after = await getCanvasForTenant(TENANT, canvasId);
    expect((after?.state as { meta: { title: string } }).meta.title).toBe('Edited');
  });
});

describe('apply is draft→validate→persist over the shared derive path', () => {
  async function seedCandidateWithOutline(): Promise<{ candidateId: string; challengeId: string; canvasId: string }> {
    const c = await createCandidate({ tenantId: TENANT, createdBy: AUTHOR, topic: 'daily focus practice', audience: 'busy professionals', transformation: 'a reliable focus habit', durationDaysTarget: 7, dailyMinutesTarget: 15 });
    const { challenge } = await deriveAndBindCandidateDraft(TENANT, AUTHOR, c.id, VALID);
    const canvasId = outlineCanvasId(TENANT, c.id);
    await ensureCanvasForTenant(TENANT, canvasId, { canvasTypeId: CHALLENGE_OUTLINE_CANVAS_TYPE, initialState: planToOutlineDoc((await getCandidatePlan(TENANT, c.id))!.plan) });
    return { candidateId: c.id, challengeId: challenge.id, canvasId };
  }

  it('an edited day title flows into BOTH the SSoT revision and the re-derived draft', async () => {
    const { candidateId, challengeId, canvasId } = await seedCandidateWithOutline();
    expect((await getCandidatePlan(TENANT, candidateId))!.revision).toBe(1);
    // Edit day 1's title in the canvas working draft.
    const canvas = await getCanvasForTenant(TENANT, canvasId);
    const doc = JSON.parse(JSON.stringify(canvas!.state)) as OutlineDoc;
    doc.frames[0].days[0].props.title = 'Edited Day One';
    await updateCanvasForTenant(TENANT, canvasId, doc, { merge: 'replace' });
    // Replicate the apply handler: read → docToPlan → validate → derive+bind.
    const fresh = await getCanvasForTenant(TENANT, canvasId);
    const plan = outlineDocToPlan(fresh!.state);
    expect(validatePlan(plan)).toEqual([]);
    const { candidate: bound } = await deriveAndBindCandidateDraft(TENANT, AUTHOR, candidateId, plan);
    // SSoT bumped + carries the edit; the re-derived draft carries it too.
    expect(bound?.plan?.revision).toBe(2);
    expect((await getCandidatePlan(TENANT, candidateId))!.plan.days[0].title).toBe('Edited Day One');
    const draft = await getLatest(TENANT, challengeId);
    expect(draft?.activities.find((a) => a.stableActivityId === 'd1-first-block')?.title).toBe('Edited Day One');
  });

  it('a plan-law violation returns defects with NO revision bump + an untouched draft', async () => {
    const { candidateId, challengeId, canvasId } = await seedCandidateWithOutline();
    const revBefore = (await getCandidatePlan(TENANT, candidateId))!.revision;
    const titleBefore = (await getLatest(TENANT, challengeId))?.activities[0]?.title;
    // Break the plan: empty the days tree (validatePlan will reject).
    const canvas = await getCanvasForTenant(TENANT, canvasId);
    const doc = JSON.parse(JSON.stringify(canvas!.state)) as OutlineDoc;
    doc.frames[0].days = [];
    await updateCanvasForTenant(TENANT, canvasId, doc, { merge: 'replace' });
    const plan = outlineDocToPlan((await getCanvasForTenant(TENANT, canvasId))!.state);
    const defects = validatePlan(plan);
    expect(defects.length).toBeGreaterThan(0);
    // The apply handler stops here (no derive) — SSoT + draft untouched.
    expect((await getCandidatePlan(TENANT, candidateId))!.revision).toBe(revBefore);
    expect((await getLatest(TENANT, challengeId))?.activities[0]?.title).toBe(titleBefore);
  });

  it('a re-derive onto an already-published draft id is a typed conflict, no revision bump', async () => {
    const c = await createCandidate({ tenantId: TENANT, createdBy: AUTHOR, topic: 'daily focus practice', audience: 'a', transformation: 't', durationDaysTarget: 7, dailyMinutesTarget: 15 });
    const { challenge } = await deriveAndBindCandidateDraft(TENANT, AUTHOR, c.id, VALID);
    expect((await getCandidatePlan(TENANT, c.id))!.revision).toBe(1);
    await publishChallenge(TENANT, challenge.id, challenge.version);
    await expect(deriveAndBindCandidateDraft(TENANT, AUTHOR, c.id, { ...VALID, title: 'edited' })).rejects.toBeInstanceOf(DraftAlreadyPublishedError);
    expect((await getCandidatePlan(TENANT, c.id))!.revision).toBe(1); // no phantom bump
  });
});

describe('the served component catalog is the FE contract (drift-pin)', () => {
  it('serves day + alternative with the exact props/options the FE definition reads', () => {
    const byType = new Map(CHALLENGE_OUTLINE_COMPONENTS.map((c) => [c.type, c]));
    const day = byType.get('day')!;
    const alt = byType.get('alternative')!;
    // day is the container; alternative is its only legal child.
    expect(day.category).toBe('outline');
    expect(day.acceptsChildren).toBe(true);
    expect(day.allowedChildTypes).toEqual(['alternative']);
    expect(day.props?.map((p) => p.name)).toEqual(['title', 'day', 'stableActivityId', 'actionInstruction', 'userFacingWhy', 'estimatedMinutes', 'evidencePolicy', 'isRecovery', 'achievementIds']);
    // The FE quick cluster reads these by type — evidencePolicy(enum), isRecovery(boolean), estimatedMinutes(number).
    expect(day.props?.find((p) => p.name === 'evidencePolicy')).toMatchObject({ type: 'enum', options: ['attestation', 'note', 'photo', 'measurement'] });
    expect(day.props?.find((p) => p.name === 'isRecovery')?.type).toBe('boolean');
    expect(day.props?.find((p) => p.name === 'estimatedMinutes')?.type).toBe('number');
    expect(alt.category).toBe('outline');
    expect(alt.acceptsChildren).not.toBe(true);
    expect(alt.props?.map((p) => p.name)).toEqual(['title', 'stableActivityId', 'actionInstruction', 'evidencePolicy']);
    expect(alt.props?.find((p) => p.name === 'evidencePolicy')).toMatchObject({ type: 'enum', options: ['attestation', 'note', 'photo', 'measurement'] });
  });
});

describe('the outline routes are privileged authoring-family routes (per convention)', () => {
  it('ensure + apply are in the creator route table and reach the shared gate', () => {
    const keys = KICKTODO_CREATOR_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(keys).toContain('post /v1/host/openwop-app/kicktodo/creator/candidates/:id/outline');
    expect(keys).toContain('post /v1/host/openwop-app/kicktodo/creator/candidates/:id/outline/apply');
    for (const suffix of ['/candidates/:id/outline', '/candidates/:id/outline/apply']) {
      const route = KICKTODO_CREATOR_ROUTES.find((r) => r.method === 'post' && r.path.endsWith(suffix))!;
      expect(String(route.handler), `${suffix} must reach requireKicktodoManage via gate`).toContain('gate');
    }
  });
});
