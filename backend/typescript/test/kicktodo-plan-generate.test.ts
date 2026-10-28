/**
 * ADR 0415 D5 / KTC-2 — the plan-generate node, tested against the REAL
 * validator (KTFULL-B3 remediation).
 *
 * The previous version of this file MOCKED `validatePlan` with canned defect
 * arrays. That made the test pass while the node's prompt requested a
 * `ChallengeDefinition`-shaped object (`{summary, outcome, activities}`) that
 * the authoritative `ChallengePlan` validator could never accept — so the node
 * could not have succeeded in production, and the test hid it. The audit was
 * right; the mock was testing my intent, not the system.
 *
 * This version wires the node to the REAL `validatePlan` through a surface
 * that mirrors the host's, so a prompt/schema divergence fails here.
 *
 * Sabotage witnesses (w41 /grade-tests): dropping the callAI guard, the ONE
 * repair, the typed `plan_invalid` failure, the live responseSchema, the schema
 * text in the prompt, or the fed-back defect list each turn a case red; the
 * bound cases assert the defect CODE, so a plan rejected for an unrelated
 * reason cannot satisfy them.
 */
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  validatePlan,
  CHALLENGE_PLAN_JSON_SCHEMA,
  PLAN_DURATION_DAYS,
  PLAN_DAILY_MINUTES,
  PLAN_EVIDENCE_POLICIES,
  type ChallengePlan,
} from '../src/features/kicktodo-creator/planService.js';

const packUrl = new URL('../../../packs/feature.kicktodo.nodes/index.mjs', import.meta.url).href;

type NodeResult = { status: string; outputs?: Record<string, unknown>; error?: { code: string; defects?: unknown[] } };
type Ctx = Record<string, unknown>;

async function node(): Promise<(ctx: Ctx) => Promise<NodeResult>> {
  const m: { nodes: Record<string, (ctx: Ctx) => Promise<NodeResult>> } = await import(packUrl);
  return m.nodes['feature.kicktodo.nodes.plan-generate'];
}

/** The REAL creator surface shape the host exposes — no canned defects. */
const realCreatorSurface = {
  frameResearch: async () => ({}),
  validatePlan: async (args: { plan: unknown }) => ({ defects: validatePlan(args.plan) }),
  planSchema: async () => ({ schema: CHALLENGE_PLAN_JSON_SCHEMA }),
};

/** A plan that genuinely satisfies the authoritative validator. */
const VALID_PLAN: ChallengePlan = {
  title: 'Sleep steadier in three weeks',
  promise: 'Fall asleep faster and wake at a consistent time.',
  audience: 'Adults with irregular schedules',
  durationDays: 3,
  dailyMinutesBudget: 20,
  outcomes: [{ outcomeId: 'o1', measurableOutcome: 'Sleep onset under 20 minutes on 5 of 7 nights', method: 'Nightly self-report log' }],
  achievements: [{ achievementId: 'a1', observableEvidence: 'Seven consecutive nightly logs', outcomeIds: ['o1'] }],
  days: [1, 2, 3].map((day) => ({
    day,
    stableActivityId: `night-${day}`,
    title: `Wind-down routine, night ${day}`,
    actionInstruction: 'Dim lights and log your sleep-onset estimate.',
    userFacingWhy: 'A consistent cue trains sleep onset.',
    estimatedMinutes: 15,
    achievementIds: ['a1'],
    evidencePolicy: 'note' as const,
    claimRefs: [] as string[],
  })),
};

describe('the authoritative validator is what the node is judged by (KTFULL-B3)', () => {
  it('the VALID_PLAN fixture really does pass validatePlan — otherwise this suite proves nothing', () => {
    expect(validatePlan(VALID_PLAN)).toEqual([]);
  });

  it('the OLD prompt shape would be REJECTED — the defect the mock used to hide', () => {
    const legacyShape = {
      title: 't', summary: 's', outcome: 'o', durationDays: 3,
      activities: [{ stableActivityId: 'a', day: 1, title: 't', instructions: 'i', evidencePolicy: 'note' }],
    };
    expect(validatePlan(legacyShape).length).toBeGreaterThan(0);
  });
});

describe('plan-generate against the real validator', () => {
  it('fails CLOSED without ctx.callAI (stub providers)', async () => {
    const run = await node();
    const out = await run({ inputs: { topic: 'sleep' }, features: { 'kicktodo-creator': realCreatorSurface } });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('capability_missing');
  });

  it('a model returning the AUTHORITATIVE shape succeeds on the first pass', async () => {
    const run = await node();
    let calls = 0;
    const out = await run({
      inputs: { topic: 'sleep', audience: 'adults' },
      features: { 'kicktodo-creator': realCreatorSurface },
      callAI: async () => { calls += 1; return { data: VALID_PLAN }; },
    });
    expect(out.status).toBe('success');
    expect(calls).toBe(1); // no repair needed
    expect(out.outputs?.plan).toEqual(VALID_PLAN);
  });

  it('an INVALID first answer is repaired ONCE with the real defects fed back, then succeeds', async () => {
    const run = await node();
    const calls: Array<Array<{ role: string; content: string }>> = [];
    // First answer uses the legacy shape the old prompt asked for.
    const firstAnswer = { title: 't', summary: 's', outcome: 'o', durationDays: 3, activities: [] };
    const out = await run({
      inputs: { topic: 'sleep' },
      features: { 'kicktodo-creator': realCreatorSurface },
      callAI: async (req: { messages: Array<{ role: string; content: string }> }) => {
        calls.push(req.messages);
        return { data: calls.length === 1 ? firstAnswer : VALID_PLAN };
      },
    });
    expect(out.status).toBe('success');
    expect(calls).toHaveLength(2);
    // The repair turn (the LAST message) lists EVERY defect the real validator
    // found in the first answer — not canned text, not a subset. The validator is
    // a dependency here; the subject is the node's repair loop.
    const firstDefects = validatePlan(firstAnswer);
    expect(firstDefects.length).toBeGreaterThan(1);
    const repairTurn = calls[1]!.at(-1)!;
    expect(repairTurn.role).toBe('user');
    expect(repairTurn.content).toContain('FAILED validation');
    for (const d of firstDefects) expect(repairTurn.content).toContain(d.message);
    expect(repairTurn.content.split('\n- ').length - 1).toBe(firstDefects.length);
  });

  it('still-invalid after ONE repair ⇒ typed plan_invalid with the real defects; exactly two calls', async () => {
    const run = await node();
    let calls = 0;
    const out = await run({
      inputs: { topic: 'sleep' },
      features: { 'kicktodo-creator': realCreatorSurface },
      callAI: async () => { calls += 1; return { data: { nonsense: true } }; },
    });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('plan_invalid');
    expect((out.error?.defects ?? []).length).toBeGreaterThan(0);
    expect(calls).toBe(2); // bounded — never a retry loop
  });
});

// ── XCH-KT-1 — the plan-shape SSoT: schema ↔ validator parity + node wiring ──
//
// The node now fetches CHALLENGE_PLAN_JSON_SCHEMA from the creator surface at
// call time and hands it to the model as responseSchema + prompt grounding.
// These pins make schema↔validator divergence and a silent fallback regression
// fail here instead of lying to the model.
describe('plan schema SSoT parity (XCH-KT-1)', () => {
  it('the VALID_PLAN fixture passes the JSON schema AND the validator — one shape, two enforcers', () => {
    const check = new Ajv2020({ strict: false }).compile(CHALLENGE_PLAN_JSON_SCHEMA);
    expect(check(VALID_PLAN), JSON.stringify(check.errors)).toBe(true);
    expect(validatePlan(VALID_PLAN)).toEqual([]);
  });

  it('bound violations fail BOTH the schema and the validator (shared constants)', () => {
    const check = new Ajv2020({ strict: false }).compile(CHALLENGE_PLAN_JSON_SCHEMA);
    const overDuration = { ...VALID_PLAN, durationDays: PLAN_DURATION_DAYS.max + 1 };
    const underBudget = { ...VALID_PLAN, dailyMinutesBudget: PLAN_DAILY_MINUTES.min - 1 };
    // Each fixture must be refused for ITS bound — a 61-day plan with 3 days is
    // also refused for coverage, which used to satisfy a bare `length > 0`.
    for (const [bad, code] of [[overDuration, 'duration-implausible'], [underBudget, 'budget-implausible']] as const) {
      expect(check(bad)).toBe(false);
      expect(validatePlan(bad).map((d) => d.code)).toContain(code);
    }
  });

  it('the schema evidence-policy enum IS the validator vocabulary const', () => {
    const dayProps = CHALLENGE_PLAN_JSON_SCHEMA.properties.days.items.properties;
    expect(dayProps.evidencePolicy.enum).toEqual([...PLAN_EVIDENCE_POLICIES]);
    expect(dayProps.alternatives.items.properties.evidencePolicy.enum).toEqual([...PLAN_EVIDENCE_POLICIES]);
  });

  it('the node hands the LIVE surface schema to the model as responseSchema + prompt grounding', async () => {
    const run = await node();
    const seen: { responseSchema?: unknown; systemPrompt?: string } = {};
    const out = await run({
      inputs: { topic: 'sleep' },
      features: {
        'kicktodo-creator': {
          ...realCreatorSurface,
          planSchema: async () => ({ schema: CHALLENGE_PLAN_JSON_SCHEMA }),
        },
      },
      callAI: async (args: { responseSchema?: unknown; systemPrompt?: string }) => {
        seen.responseSchema = args.responseSchema;
        seen.systemPrompt = args.systemPrompt;
        return { data: VALID_PLAN };
      },
    });
    expect(out.status).toBe('success');
    expect(seen.responseSchema).toEqual(CHALLENGE_PLAN_JSON_SCHEMA);
    expect(seen.systemPrompt).toContain('JSON Schema');
    expect(seen.systemPrompt).toContain('"durationDays"');
    expect(seen.systemPrompt).toContain('"evidencePolicy"');
  });

  // XCH-PG-1 — no hand-kept fallback shape: a host whose creator surface does
  // not serve `planSchema` fails closed instead of prompting from a copy.
  it('fails closed (capability_missing) on a host without planSchema — never prompts a copied shape', async () => {
    const run = await node();
    let called = false;
    const olderHost = { frameResearch: realCreatorSurface.frameResearch, validatePlan: realCreatorSurface.validatePlan };
    const out = await run({
      inputs: { topic: 'sleep' },
      features: { 'kicktodo-creator': olderHost },
      callAI: async () => { called = true; return { data: VALID_PLAN }; },
    });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('capability_missing');
    expect(called).toBe(false);
  });

  // XCH-PG-2 — the plan is authored against the intake the creator agreed,
  // read from the candidate at call time (not guessed from the topic).
  it('reads the candidate\'s agreed targets into the prompt', async () => {
    const run = await node();
    let user = '';
    const out = await run({
      inputs: { topic: 'sleep', candidateId: 'cand:1' },
      features: {
        'kicktodo-creator': {
          ...realCreatorSurface,
          getCandidate: async (args: { candidateId: string }) => ({
            candidate: args.candidateId === 'cand:1'
              ? { transformation: 'Fall asleep within 20 minutes', durationDaysTarget: 3, dailyMinutesTarget: 20 }
              : null,
          }),
        },
      },
      callAI: async (args: { messages?: Array<{ content?: string }> }) => { user = String(args.messages?.[0]?.content ?? ''); return { data: VALID_PLAN }; },
    });
    expect(out.status).toBe('success');
    expect(user).toContain('TARGETS the creator agreed');
    expect(user).toContain('Fall asleep within 20 minutes');
    expect(user).toContain('durationDays: 3');
    expect(user).toContain('dailyMinutesBudget: 20');
  });
});

// XCH-PGC-1 — a caller that passes no `evidenceClaims` (the standalone
// plan-generation chain) gets the candidate's dossier claims read from the
// creator surface, the same world `validatePlan` judges `claimRefs` against.
// Sabotage: dropping the surface read leaves the prompt saying no evidence was
// recorded while the claim below exists, and reds the first case.
describe('plan-generate reads the dossier evidence when none is passed (XCH-PGC-1)', () => {
  const DOSSIER_CLAIMS = [
    { claimId: 'claim-light', text: 'Dim evening light advances melatonin onset.', supported: true, sources: [{ title: 'Light study', url: 'https://example.org/light', domain: 'example.org' }] },
  ];

  it('with a candidateId and no evidenceClaims the prompt carries the dossier claims from the surface', async () => {
    const run = await node();
    const asked: string[] = [];
    const prompts: string[] = [];
    const out = await run({
      inputs: { topic: 'sleep', candidateId: 'cand-1' },
      features: {
        'kicktodo-creator': {
          ...realCreatorSurface,
          evidenceClaims: async (a: { candidateId: string }) => { asked.push(a.candidateId); return { claims: DOSSIER_CLAIMS }; },
        },
      },
      callAI: async (req: { messages: Array<{ content: string }> }) => { prompts.push(req.messages[0]!.content); return { data: VALID_PLAN }; },
    });
    expect(out.status).toBe('success');
    expect(asked).toEqual(['cand-1']);
    expect(prompts[0]).toContain('[claim-light]');
  });

  it('evidenceClaims passed by the caller win; the surface is not read', async () => {
    const run = await node();
    let read = false;
    const prompts: string[] = [];
    await run({
      inputs: { topic: 'sleep', candidateId: 'cand-1', evidenceClaims: [{ ...DOSSIER_CLAIMS[0], claimId: 'claim-passed' }] },
      features: { 'kicktodo-creator': { ...realCreatorSurface, evidenceClaims: async () => { read = true; return { claims: DOSSIER_CLAIMS }; } } },
      callAI: async (req: { messages: Array<{ content: string }> }) => { prompts.push(req.messages[0]!.content); return { data: VALID_PLAN }; },
    });
    expect(read).toBe(false);
    expect(prompts[0]).toContain('[claim-passed]');
    expect(prompts[0]).not.toContain('[claim-light]');
  });
});
