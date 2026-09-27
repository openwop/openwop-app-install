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
 */
import { describe, expect, it } from 'vitest';
import { validatePlan, type ChallengePlan } from '../src/features/kicktodo-creator/planService.js';

const packUrl = new URL('../../../packs/feature.kicktodo.nodes/index.mjs', import.meta.url).href;

type NodeResult = { status: string; outputs?: Record<string, unknown>; error?: { code: string; defects?: unknown[] } };
type Ctx = Record<string, unknown>;

async function node(): Promise<(ctx: Ctx) => Promise<NodeResult>> {
  const m = (await import(packUrl)) as { nodes: Record<string, (ctx: Ctx) => Promise<NodeResult>> };
  return m.nodes['feature.kicktodo.nodes.plan-generate'];
}

/** The REAL creator surface shape the host exposes — no canned defects. */
const realCreatorSurface = {
  frameResearch: async () => ({}),
  validatePlan: async (args: { plan: unknown }) => ({ defects: validatePlan(args.plan as ChallengePlan) }),
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
    expect(validatePlan(legacyShape as unknown as ChallengePlan).length).toBeGreaterThan(0);
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
    const out = await run({
      inputs: { topic: 'sleep' },
      features: { 'kicktodo-creator': realCreatorSurface },
      callAI: async (req: { messages: Array<{ role: string; content: string }> }) => {
        calls.push(req.messages);
        // First answer uses the legacy shape the old prompt asked for.
        return { data: calls.length === 1 ? { title: 't', summary: 's', outcome: 'o', durationDays: 3, activities: [] } : VALID_PLAN };
      },
    });
    expect(out.status).toBe('success');
    expect(calls).toHaveLength(2);
    // The repair names defects produced by the REAL validator, not canned text.
    const repair = calls[1]!.map((m) => m.content).join('\n');
    expect(repair).toContain('FAILED validation');
    expect(repair.length).toBeGreaterThan(50);
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
  it('the VALID_PLAN fixture passes the JSON schema AND the validator — one shape, two enforcers', async () => {
    const { CHALLENGE_PLAN_JSON_SCHEMA } = await import('../src/features/kicktodo-creator/planService.js');
    const { default: Ajv2020 } = (await import('ajv/dist/2020.js')) as unknown as { default: new (o?: unknown) => { compile: (s: unknown) => ((v: unknown) => boolean) & { errors?: unknown } } };
    const check = new Ajv2020({ strict: false }).compile(CHALLENGE_PLAN_JSON_SCHEMA);
    expect(check(VALID_PLAN), JSON.stringify(check.errors)).toBe(true);
    expect(validatePlan(VALID_PLAN)).toEqual([]);
  });

  it('bound violations fail BOTH the schema and the validator (shared constants)', async () => {
    const { CHALLENGE_PLAN_JSON_SCHEMA, PLAN_DURATION_DAYS, PLAN_DAILY_MINUTES } = await import('../src/features/kicktodo-creator/planService.js');
    const { default: Ajv2020 } = (await import('ajv/dist/2020.js')) as unknown as { default: new (o?: unknown) => { compile: (s: unknown) => (v: unknown) => boolean } };
    const check = new Ajv2020({ strict: false }).compile(CHALLENGE_PLAN_JSON_SCHEMA);
    const overDuration = { ...VALID_PLAN, durationDays: PLAN_DURATION_DAYS.max + 1 };
    const underBudget = { ...VALID_PLAN, dailyMinutesBudget: PLAN_DAILY_MINUTES.min - 1 };
    for (const bad of [overDuration, underBudget]) {
      expect(check(bad)).toBe(false);
      expect(validatePlan(bad as unknown as ChallengePlan).length).toBeGreaterThan(0);
    }
  });

  it('the schema evidence-policy enum IS the validator vocabulary const', async () => {
    const { CHALLENGE_PLAN_JSON_SCHEMA, PLAN_EVIDENCE_POLICIES } = await import('../src/features/kicktodo-creator/planService.js');
    const dayProps = (CHALLENGE_PLAN_JSON_SCHEMA as unknown as { properties: { days: { items: { properties: Record<string, { enum?: string[] }> } } } }).properties.days.items.properties;
    expect(dayProps.evidencePolicy.enum).toEqual([...PLAN_EVIDENCE_POLICIES]);
  });

  it('the node hands the LIVE surface schema to the model as responseSchema + prompt grounding', async () => {
    const { CHALLENGE_PLAN_JSON_SCHEMA } = await import('../src/features/kicktodo-creator/planService.js');
    const run = await node();
    const seen: { responseSchema?: unknown; systemPrompt?: string } = {};
    const out = await run({
      inputs: { topic: 'sleep' },
      features: {
        'kicktodo-creator': {
          ...realCreatorSurface,
          planSchema: async () => ({ schema: CHALLENGE_PLAN_JSON_SCHEMA as unknown as Record<string, unknown> }),
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

  it('falls back to the pinned prose shape on an older host without planSchema', async () => {
    const run = await node();
    const seen: { responseSchema?: { type?: string; properties?: unknown }; systemPrompt?: string } = {};
    const out = await run({
      inputs: { topic: 'sleep' },
      features: { 'kicktodo-creator': realCreatorSurface },
      callAI: async (args: { responseSchema?: { type?: string; properties?: unknown }; systemPrompt?: string }) => {
        seen.responseSchema = args.responseSchema;
        seen.systemPrompt = args.systemPrompt;
        return { data: VALID_PLAN };
      },
    });
    expect(out.status).toBe('success');
    expect(seen.systemPrompt).toContain('EXACTLY these fields');
    expect(seen.responseSchema?.type).toBe('object');
    expect(seen.responseSchema?.properties).toBeUndefined(); // the stub, not a half-schema
  });
});
