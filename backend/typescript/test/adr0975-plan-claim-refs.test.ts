/**
 * ADR 0975 D7 — a Factory plan says what evidence each day cites, and a plan
 * that cites none of the supported evidence is a typed defect, not a publication
 * block at the end of the run.
 *
 * MEASURED on kicktodo.com (2026-10-25), Challenge Factory run 6fc86dd1: with 13
 * supported claims in the dossier, gemini-3.8-flash returned a 21-day plan with
 * NO `claimRefs` on any day (the field was optional in the response schema),
 * `validatePlan` skipped the missing field, every lesson batch was built and
 * approved, and the skeptic simulation then blocked publication: "the plan fails
 * to cite any of the provided evidence claims across all 21 days".
 *
 * Pins: `claimRefs` is REQUIRED in the schema the model is prompted with (an
 * empty array stays legal); with supported evidence in scope, a day without the
 * field is `claim-refs-missing` and a plan citing nothing is
 * `plan-cites-no-evidence`; with no evidence in scope neither applies; the
 * plan-generate node feeds the defect to its one repair and succeeds on a cited
 * answer.
 *
 * Red when (sabotage-witnessed): `claimRefs` leaves the schema's `required`; the
 * missing-field defect is removed; the no-evidence defect is removed; either
 * fires without evidence in scope.
 */
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { validatePlan, CHALLENGE_PLAN_JSON_SCHEMA, type ChallengePlan } from '../src/features/kicktodo-creator/planService.js';

const packUrl = new URL('../../../packs/feature.kicktodo.nodes/index.mjs', import.meta.url).href;
type NodeResult = { status: string; outputs?: Record<string, unknown>; error?: { code: string } };
type Ctx = Record<string, unknown>;

const KNOWN = ['c-1', 'c-2', 'c-13'];

/** The production shape: three days, no `claimRefs` anywhere (what Gemini returned). */
function plan(claimRefs: ((day: number) => string[]) | null): ChallengePlan {
  return {
    title: 'Gentle 21-Day Habit: Sustainable Daily Walking',
    promise: 'A daily walking habit at a fixed, safe duration.',
    audience: 'Adults who do not currently walk regularly',
    durationDays: 3,
    dailyMinutesBudget: 15,
    outcomes: [{ outcomeId: 'o1', measurableOutcome: 'Walk on 3 of 3 days', method: 'Daily photo check-in' }],
    achievements: [{ achievementId: 'a1', observableEvidence: 'Three logged walks', outcomeIds: ['o1'] }],
    days: [1, 2, 3].map((day) => ({
      day,
      stableActivityId: `day-0${day}`,
      title: `Walk, day ${day}`,
      actionInstruction: 'Walk at your chosen baseline for 10 to 15 minutes.',
      userFacingWhy: 'A brisk 10-minute daily walk counts toward the weekly guideline.',
      estimatedMinutes: 15,
      achievementIds: ['a1'],
      evidencePolicy: 'photo' as const,
      ...(claimRefs ? { claimRefs: claimRefs(day) } : {}),
    })),
  };
}

describe('ADR 0975 D7 — the response schema requires claimRefs', () => {
  const validate = new Ajv2020({ strict: false }).compile(CHALLENGE_PLAN_JSON_SCHEMA);

  it('a day without claimRefs fails the schema the model is prompted with', () => {
    expect(validate(plan(null))).toBe(false);
    expect(validate.errors?.some((e) => e.keyword === 'required' && (e.params as { missingProperty?: string }).missingProperty === 'claimRefs')).toBe(true);
  });

  it('an empty array is still a legal answer for a day that states no fact', () => {
    expect(validate(plan(() => []))).toBe(true);
  });
});

describe('ADR 0975 D7 — validatePlan with supported evidence in scope', () => {
  it('the kicktodo.com shape: every day missing claimRefs ⇒ claim-refs-missing per day', () => {
    const defects = validatePlan(plan(null), { knownClaimIds: KNOWN });
    expect(defects.map((d) => d.code)).toEqual(['claim-refs-missing', 'claim-refs-missing', 'claim-refs-missing']);
    expect(defects.map((d) => d.ref)).toEqual(['day-01', 'day-02', 'day-03']);
  });

  it('every day present but empty ⇒ plan-cites-no-evidence, once', () => {
    expect(validatePlan(plan(() => []), { knownClaimIds: KNOWN }).map((d) => d.code)).toEqual(['plan-cites-no-evidence']);
  });

  it('one supported citation anywhere is enough', () => {
    expect(validatePlan(plan((d) => (d === 2 ? ['c-1'] : [])), { knownClaimIds: KNOWN })).toEqual([]);
  });

  it('an unknown citation reports claim-ref-unknown alone, not also no-evidence', () => {
    expect(validatePlan(plan((d) => (d === 1 ? ['c-99'] : [])), { knownClaimIds: KNOWN }).map((d) => d.code)).toEqual(['claim-ref-unknown']);
  });

  it('no evidence in scope (no dossier, or no supported claim) ⇒ neither rule applies', () => {
    expect(validatePlan(plan(null))).toEqual([]);
    expect(validatePlan(plan(null), { knownClaimIds: [] })).toEqual([]);
    expect(validatePlan(plan(() => []), { knownClaimIds: [] })).toEqual([]);
  });
});

describe('ADR 0975 D7 — plan-generate repairs an uncited plan instead of shipping it', () => {
  it('the uncited first answer is fed back as defects; the cited second answer succeeds', async () => {
    const m: { nodes: Record<string, (ctx: Ctx) => Promise<NodeResult>> } = await import(packUrl);
    const run = m.nodes['feature.kicktodo.nodes.plan-generate'];
    const answers = [plan(null), plan((d) => (d === 1 ? ['c-1', 'c-13'] : []))];
    const turns: Array<Array<{ role: string; content: string }>> = [];
    const out = await run({
      inputs: { topic: 'Daily walking habit for beginners', candidateId: 'cand:x', evidenceClaims: [] },
      features: {
        'kicktodo-creator': {
          frameResearch: async () => ({}),
          planSchema: async () => ({ schema: CHALLENGE_PLAN_JSON_SCHEMA }),
          validatePlan: async (args: { plan: unknown }) => ({ defects: validatePlan(args.plan, { knownClaimIds: KNOWN }) }),
        },
      },
      callAI: async (req: { messages: Array<{ role: string; content: string }> }) => {
        turns.push(req.messages);
        return { data: answers[turns.length - 1] };
      },
    });
    expect(out.status).toBe('success');
    expect(turns).toHaveLength(2);
    expect(turns[1]!.at(-1)!.content).toContain('Every day needs `claimRefs`');
    expect((out.outputs?.plan as ChallengePlan).days[0]!.claimRefs).toEqual(['c-1', 'c-13']);
  });
});
