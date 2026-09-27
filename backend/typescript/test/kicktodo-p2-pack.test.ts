/**
 * ADR 0458 P2 — pack-half tests for the Challenge Factory's per-lesson iteration:
 *   1. the sim-verdict return schema (the three simulation personas' typed
 *      contract) validates the real shapes and REJECTS extras / missing required;
 *   2. the three touched pack manifests parse and carry the P2 wiring (the sim
 *      agents' returnSchemaRef, the new lesson-media node, the version bumps);
 *   3. the `lesson-media-persist` node registers and fails TYPED
 *      (host_capability_missing) when a governed surface is absent — never a
 *      silent no-op that would strand a generated image between its two writes;
 *   4. the core.openwop.ai image-generate output schema is HONEST — it declares
 *      the runtime's `images[].url`, not the phantom `contentBase64`.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '../../..');
const AGENTS_PACK = join(REPO_ROOT, 'packs/feature.kicktodo.agents');
const NODES_PACK = join(REPO_ROOT, 'packs/feature.kicktodo.nodes');
const AI_PACK = join(REPO_ROOT, 'packs/core.openwop.ai');

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

// ── 1. sim-verdict return schema ──────────────────────────────────────────
describe('sim-verdict return schema (ADR 0458 P2)', () => {
  let validate: (v: unknown) => boolean;
  beforeAll(async () => {
    const { default: Ajv2020 } = (await import('ajv/dist/2020.js')) as { default: new (o?: unknown) => { compile: (s: unknown) => (v: unknown) => boolean } };
    const schema = readJson(join(AGENTS_PACK, 'schemas/sim-verdict.schema.json'));
    validate = new Ajv2020({ strict: false }).compile(schema);
  });

  it('accepts a clean pass with an empty findings array', () => {
    expect(validate({ verdict: 'pass', findings: [], personaSummary: 'Livable as-is for a newcomer.' })).toBe(true);
  });

  it('accepts a flag with day-scoped and un-scoped findings', () => {
    expect(validate({
      verdict: 'flag',
      findings: [
        { day: 3, severity: 'flag', text: 'Day 3 assumes a term never taught.' },
        { severity: 'note', text: 'Overall pacing is a touch fast at the start.' },
      ],
      personaSummary: 'Workable, but a couple of confusions would trip a first-timer.',
    })).toBe(true);
  });

  it('accepts a block verdict', () => {
    expect(validate({
      verdict: 'block',
      findings: [{ day: 1, severity: 'block', text: 'Day 1 requires equipment never introduced.' }],
      personaSummary: 'A newcomer cannot start.',
    })).toBe(true);
  });

  it('rejects an unknown top-level property (closed world)', () => {
    expect(validate({ verdict: 'pass', findings: [], personaSummary: 'ok', extra: true })).toBe(false);
  });

  it('rejects an unknown finding property (closed world)', () => {
    expect(validate({ verdict: 'flag', findings: [{ severity: 'flag', text: 'x', bogus: 1 }], personaSummary: 'ok' })).toBe(false);
  });

  it('rejects a verdict outside the enum', () => {
    expect(validate({ verdict: 'maybe', findings: [], personaSummary: 'ok' })).toBe(false);
  });

  it('rejects a missing required field', () => {
    expect(validate({ verdict: 'pass', findings: [] })).toBe(false);
    expect(validate({ findings: [], personaSummary: 'ok' })).toBe(false);
  });

  it('rejects a finding missing severity or text', () => {
    expect(validate({ verdict: 'flag', findings: [{ text: 'no severity' }], personaSummary: 'ok' })).toBe(false);
    expect(validate({ verdict: 'flag', findings: [{ severity: 'note' }], personaSummary: 'ok' })).toBe(false);
  });
});

// ── 2. manifests parse + carry the P2 wiring ──────────────────────────────
describe('touched pack manifests (ADR 0458 P2)', () => {
  it('the three sim agents return the sim-verdict schema (agents pack ≥ P2)', () => {
    const pack = readJson(join(AGENTS_PACK, 'pack.json'));
    // Version moved forward with ADR 0459 P1 (1.6.0 — replan-composer) and ADR 0463
    // (1.7.0 — the plan-revision `clarification` arm); the P2 invariant this test
    // guards is the sim agents' schema, pinned exactly below.
    expect(pack.version).toBe('1.9.0');
    const simIds = [
      'feature.kicktodo.agents.sim-newcomer',
      'feature.kicktodo.agents.sim-time-poor',
      'feature.kicktodo.agents.sim-skeptic',
    ];
    for (const id of simIds) {
      const agent = pack.agents.find((a: { agentId: string }) => a.agentId === id);
      expect(agent, `${id} must be declared`).toBeDefined();
      expect(agent.handoff?.returnSchemaRef).toBe('schemas/sim-verdict.schema.json');
    }
  });

  it('the four P2 factory nodes are declared (nodes pack ≥ P2)', () => {
    const pack = readJson(join(NODES_PACK, 'pack.json'));
    // Version moved forward with ADR 0459 (1.19.0 P1 apply-revision-commands +
    // session-reminder; 1.20.0 grade-fix enrich-plan-revision), ADR 0463 (1.21.0
    // replan-clarify), and the NP-KT-1 parity sweep (1.22.0, 17 surface wrappers);
    // the P2 invariant here is that the four factory nodes still exist.
    expect(pack.version).toBe('1.30.0');
    for (const typeId of [
      'feature.kicktodo.nodes.lesson-media-persist',
      'feature.kicktodo.nodes.checkpoint-plan',
      'feature.kicktodo.nodes.lesson-batch-build',
      'feature.kicktodo.nodes.sim-collect',
    ]) {
      const node = pack.nodes.find((n: { typeId: string }) => n.typeId === typeId);
      expect(node, `${typeId} must be declared`).toBeDefined();
      expect(node.role).toBe('action');
    }
  });

  it('core.openwop.ai pack is bumped for the schema-honesty fix', () => {
    const pack = readJson(join(AI_PACK, 'pack.json')) as { version: string };
    // AT OR BEYOND, not exactly. The intent is "the schema-honesty bump happened",
    // and an equality pin asserts a MOMENT instead — it fails the next legitimate
    // bump and has to be chased forward by whoever trips it. (The nodes-pack pin
    // above documents being chased 1.19 -> 1.27 for exactly that reason.) This one
    // broke on 1.3.2, the input-schema contract fix.
    const asTuple = (v: string): number[] => v.split('.').map((n) => Number.parseInt(n, 10));
    const [maj, min, pat] = asTuple(pack.version);
    const [rMaj, rMin, rPat] = asTuple('1.3.1');
    const atOrBeyond = maj > rMaj
      || (maj === rMaj && min > rMin)
      || (maj === rMaj && min === rMin && pat >= rPat);
    expect(atOrBeyond, `core.openwop.ai is ${pack.version}, expected >= 1.3.1`).toBe(true);
  });
});

// ── 3. lesson-media-persist node ──────────────────────────────────────────
describe('lesson-media-persist node (ADR 0458 P2)', () => {
  type NodeResult = { status: string; outputs?: Record<string, unknown>; error?: { code: string } };
  type Ctx = Record<string, unknown>;
  const packUrl = new URL('../../../packs/feature.kicktodo.nodes/index.mjs', import.meta.url).href;

  async function node(): Promise<(ctx: Ctx) => Promise<NodeResult>> {
    const m = (await import(packUrl)) as { nodes: Record<string, (ctx: Ctx) => Promise<NodeResult>> };
    return m.nodes['feature.kicktodo.nodes.lesson-media-persist'];
  }

  const validInputs = { candidateId: 'cand-1', day: 2, url: 'media:tok-abc', kind: 'image' };

  it('is registered in the pack', async () => {
    expect(typeof (await node())).toBe('function');
  });

  it('fails typed (host_capability_missing) when the media surface is absent', async () => {
    const run = await node();
    await expect(run({ inputs: validInputs, features: {}, tenantId: 't1' }))
      .rejects.toMatchObject({ code: 'host_capability_missing' });
  });

  it('fails typed (host_capability_missing) when only media is present but the creator surface is absent', async () => {
    const run = await node();
    const features = { media: { createAssetFromServeUrl: async () => ({ assetId: 'a1' }) } };
    await expect(run({ inputs: validInputs, features, tenantId: 't1' }))
      .rejects.toMatchObject({ code: 'host_capability_missing' });
  });

  it('validates inputs (bad kind → typed validation_error)', async () => {
    const run = await node();
    const features = {
      media: { createAssetFromServeUrl: async () => ({ assetId: 'a1' }) },
      'kicktodo-creator': { frameResearch: async () => ({}), setLessonMedia: async () => ({}) },
    };
    const out = await run({ inputs: { ...validInputs, kind: 'gif' }, features, tenantId: 't1' });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('validation_error');
  });

  it('creates the asset then binds it via setLessonMedia (orgId defaults to tenantId)', async () => {
    const run = await node();
    const calls: { create?: Record<string, unknown>; bind?: Record<string, unknown> } = {};
    const features = {
      media: {
        createAssetFromServeUrl: async (args: Record<string, unknown>) => { calls.create = args; return { assetId: 'asset-77' }; },
      },
      'kicktodo-creator': {
        frameResearch: async () => ({}),
        setLessonMedia: async (args: Record<string, unknown>) => { calls.bind = args; return { candidate: { id: 'cand-1' } }; },
      },
    };
    const out = await run({ inputs: validInputs, features, tenantId: 'tenant-9' });
    expect(out.status).toBe('success');
    expect(out.outputs?.assetId).toBe('asset-77');
    expect(calls.create?.orgId).toBe('tenant-9');
    expect(calls.create?.url).toBe('media:tok-abc');
    expect(calls.bind).toEqual({ candidateId: 'cand-1', day: 2, assetId: 'asset-77', kind: 'image' });
  });
});

// ── 3b. checkpoint-plan / lesson-batch-build / sim-collect nodes ───────────
describe('P2 factory spine nodes (ADR 0458 P2)', () => {
  type NodeResult = { status: string; outputs?: Record<string, unknown>; error?: { code: string } };
  type Ctx = Record<string, unknown>;
  const packUrl = new URL('../../../packs/feature.kicktodo.nodes/index.mjs', import.meta.url).href;

  async function nodes(): Promise<Record<string, (ctx: Ctx) => Promise<NodeResult>>> {
    const m = (await import(packUrl)) as { nodes: Record<string, (ctx: Ctx) => Promise<NodeResult>> };
    return m.nodes;
  }

  // A tiny run-variable bag double (get/set), like the executor's.
  function makeBag(): { get(k: string): unknown; set(k: string, v: unknown): void; store: Record<string, unknown> } {
    const store: Record<string, unknown> = {};
    return { store, get: (k) => store[k], set: (k, v) => { store[k] = v; } };
  }

  const PLAN = {
    title: 'Sleep steadier',
    promise: 'Fall asleep faster.',
    audience: 'Adults',
    days: [
      { day: 1, title: 'Wind down', actionInstruction: 'Dim lights an hour before bed.', userFacingWhy: 'Melatonin.' },
      { day: 2, title: 'Consistent wake', actionInstruction: 'Wake at the same time.', userFacingWhy: 'Rhythm.' },
    ],
  };

  describe('checkpoint-plan', () => {
    it('typed-fails when the creator surface is absent', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.checkpoint-plan'];
      await expect(run({ inputs: { plan: PLAN, checkpointEvery: 'batched' }, features: {} }))
        .rejects.toMatchObject({ code: 'host_capability_missing' });
    });

    it('writes batch0..3 + planBrief to the bag and outputs slotNLive + noLiveSlots', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.checkpoint-plan'];
      const bag = makeBag();
      // The surface double returns a 2-batch checkpoint plan (day 1 → slot0, day 2 → slot1).
      const features = {
        'kicktodo-creator': {
          frameResearch: async () => ({}),
          checkpointPlan: async () => ({
            plan: {
              cadence: 'batched',
              batches: [{ slot: 0, days: [1] }, { slot: 1, days: [2] }],
              slotLive: [true, true, false, false],
              noLiveSlots: false,
            },
          }),
        },
      };
      const out = await run({ inputs: { plan: PLAN, checkpointEvery: 'batched' }, features, variables: bag });
      expect(out.status).toBe('success');
      expect(out.outputs).toMatchObject({ slot0Live: true, slot1Live: true, slot2Live: false, slot3Live: false, noLiveSlots: false });
      // Bag: batchN carries the plan's day OBJECTS, not bare numbers.
      expect(bag.store.batch0).toEqual([PLAN.days[0]]);
      expect(bag.store.batch1).toEqual([PLAN.days[1]]);
      expect(bag.store.batch2).toEqual([]);
      expect(typeof bag.store.planBrief).toBe('string');
      expect(bag.store.planBrief as string).toContain('Day 1:');
      // ADR 0458 §2.2 correction — with no evidence the skeptic's brief says so explicitly.
      expect(bag.store.planEvidenceBrief as string).toContain('EVIDENCE: none recorded');
    });

    it('ADR 0458 §2.2 correction — planEvidenceBrief carries the cited evidence and each day\'s claimRefs for the skeptic', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.checkpoint-plan'];
      const bag = makeBag();
      const features = {
        'kicktodo-creator': {
          frameResearch: async () => ({}),
          checkpointPlan: async () => ({ plan: { cadence: 'batched', batches: [{ slot: 0, days: [1, 2] }], slotLive: [true, false, false, false], noLiveSlots: false } }),
        },
      };
      const plan = { ...PLAN, days: [{ ...PLAN.days[0], claimRefs: ['c-1'] }, PLAN.days[1]] };
      const evidenceClaims = [{ claimId: 'c-1', text: 'Dim evening light advances melatonin onset.', supported: true, sources: [{ title: 'Light study', url: 'https://example.org/light', domain: 'example.org' }] }];
      const out = await run({ inputs: { plan, checkpointEvery: 'batched', evidenceClaims }, features, variables: bag });
      expect(out.status).toBe('success');
      const brief = bag.store.planEvidenceBrief as string;
      expect(brief).toContain('Day 1:');
      expect(brief).toContain('[c-1] Dim evening light advances melatonin onset.');
      expect(brief).toContain('https://example.org/light');
      expect(brief).toContain('Day 1: [c-1]');
      expect(brief).toContain('Day 2: (no claims cited)');
      // planBrief (the other two personas' task) is unchanged — no evidence dump.
      expect(bag.store.planBrief as string).not.toContain('EVIDENCE');
    });

    it('surfaces an outline-only plan as noLiveSlots with empty batches', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.checkpoint-plan'];
      const bag = makeBag();
      const features = {
        'kicktodo-creator': {
          frameResearch: async () => ({}),
          checkpointPlan: async () => ({ plan: { cadence: 'outline-only', batches: [], slotLive: [false, false, false, false], noLiveSlots: true } }),
        },
      };
      const out = await run({ inputs: { plan: PLAN, checkpointEvery: 'outline-only' }, features, variables: bag });
      expect(out.outputs).toMatchObject({ slot0Live: false, noLiveSlots: true });
      expect(bag.store.batch0).toEqual([]);
    });
  });

  describe('lesson-batch-build', () => {
    const rawDays = [{ day: 1, title: 'Wind down', actionInstruction: 'Dim lights.', userFacingWhy: 'Melatonin.' }];
    const goodLesson = { day: 1, title: 'Wind down', body: 'Dim the lights an hour before bed to let melatonin rise naturally.', steps: ['Dim lights', 'No screens'], claimRefs: [] };
    const EVIDENCE = [
      { claimId: 'c-1', text: 'Dim evening light advances melatonin onset.', supported: true, sources: [{ title: 'Light study', url: 'https://example.org/light', domain: 'example.org' }] },
      { claimId: 'c-2', text: 'Screens delay sleep onset.', supported: false, sources: [] },
    ];

    it('fails closed (capability_missing) without ctx.callAI', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.lesson-batch-build'];
      const out = await run({ inputs: { candidateId: 'c1', days: rawDays } });
      expect(out.status).toBe('failed');
      expect(out.error?.code).toBe('capability_missing');
    });

    it('an empty batch (dead slot) is a clean no-op success', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.lesson-batch-build'];
      const out = await run({ inputs: { candidateId: 'c1', days: [] }, callAI: async () => ({ data: goodLesson }) });
      expect(out.status).toBe('success');
      expect(out.outputs).toEqual({ lessons: [], count: 0, mediaCount: 0 });
    });

    it('enriches each day with one bounded repair and builds a validated lesson', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.lesson-batch-build'];
      let calls = 0;
      const callAI = async () => { calls += 1; return { data: calls === 1 ? { day: 1, title: '', body: 'x', steps: [] } : goodLesson }; };
      const out = await run({ inputs: { candidateId: 'c1', days: rawDays }, callAI });
      expect(out.status).toBe('success');
      expect(calls).toBe(2); // one bad shape, one repair
      expect(out.outputs?.count).toBe(1);
      expect((out.outputs?.lessons as unknown[])[0]).toMatchObject({ day: 1, title: 'Wind down' });
      expect(out.outputs?.mediaCount).toBe(0);
    });

    it('ADR 0458 §2.2 correction — a lesson citing a claim the EVIDENCE does not list is lesson_invalid after one repair', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.lesson-batch-build'];
      let calls = 0;
      const prompts: string[] = [];
      const callAI = async (req: { systemPrompt?: string; messages?: Array<{ content?: string }> }) => {
        calls += 1;
        prompts.push(String(req.messages?.[calls === 1 ? 0 : 2]?.content ?? ''));
        return { data: { ...goodLesson, claimRefs: ['c-9'] } };
      };
      const out = await run({ inputs: { candidateId: 'c1', days: rawDays, evidenceClaims: EVIDENCE }, callAI });
      expect(out.status).toBe('failed');
      expect(out.error?.code).toBe('lesson_invalid');
      expect(calls).toBe(2);
      // The repair prompt names the fabricated id verbatim, and the first prompt
      // carried the evidence with its ids — the model was told what it may cite.
      expect(prompts[0]).toContain('[c-1]');
      expect(prompts[0]).toContain('UNSUPPORTED');
      expect(prompts[1]).toContain('c-9');
    });

    it('ADR 0458 §2.2 correction — a lesson citing listed evidence passes and carries claimRefs; the schema comes from the creator surface', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.lesson-batch-build'];
      const seen: { responseSchema?: unknown } = {};
      const features = {
        'kicktodo-creator': { frameResearch: async () => ({}), lessonSchema: async () => ({ schema: { type: 'object', required: ['day', 'title', 'body', 'steps', 'claimRefs'], properties: { claimRefs: { type: 'array' } } } }) },
      };
      const out = await run({
        inputs: { candidateId: 'c1', days: [{ ...rawDays[0], claimRefs: ['c-1'] }], evidenceClaims: EVIDENCE },
        features,
        callAI: async (req: { responseSchema?: unknown }) => { seen.responseSchema = req.responseSchema; return { data: { ...goodLesson, claimRefs: ['c-1'] } }; },
      });
      expect(out.status).toBe('success');
      expect((out.outputs?.lessons as Array<{ claimRefs?: string[] }>)[0].claimRefs).toEqual(['c-1']);
      expect((seen.responseSchema as { required?: string[] }).required).toContain('claimRefs');
    });

    it('re-grade KTF-EV-1 — a lesson citing a claim the EVIDENCE lists as UNSUPPORTED is lesson_invalid', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.lesson-batch-build'];
      const out = await run({ inputs: { candidateId: 'c1', days: rawDays, evidenceClaims: EVIDENCE }, callAI: async () => ({ data: { ...goodLesson, claimRefs: ['c-2'] } }) });
      expect(out.status).toBe('failed');
      expect(out.error?.code).toBe('lesson_invalid');
      expect(JSON.stringify(out.error)).toContain('c-2');
    });

    it('ADR 0458 §2.2 correction — with no evidence in scope a lesson must cite nothing', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.lesson-batch-build'];
      const out = await run({ inputs: { candidateId: 'c1', days: rawDays }, callAI: async () => ({ data: { ...goodLesson, claimRefs: ['c-1'] } }) });
      expect(out.status).toBe('failed');
      expect(out.error?.code).toBe('lesson_invalid');
    });

    it('typed-fails (lesson_invalid) when the repair still does not validate', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.lesson-batch-build'];
      const out = await run({ inputs: { candidateId: 'c1', days: rawDays }, callAI: async () => ({ data: { day: 1, title: '', body: 'x', steps: [] } }) });
      expect(out.status).toBe('failed');
      expect(out.error?.code).toBe('lesson_invalid');
    });

    it('generates + persists per-day media through the shared leg when generateMedia', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.lesson-batch-build'];
      const bind: Record<string, unknown>[] = [];
      const features = {
        media: { createAssetFromServeUrl: async () => ({ assetId: 'asset-1' }) },
        'kicktodo-creator': { frameResearch: async () => ({}), setLessonMedia: async (a: Record<string, unknown>) => { bind.push(a); return {}; } },
      };
      const out = await run({
        inputs: { candidateId: 'c1', days: rawDays, generateMedia: true },
        tenantId: 'tenant-1',
        callAI: async () => ({ data: goodLesson }),
        callImageGenerator: async () => ({ images: [{ url: 'media:tok-1', mimeType: 'image/png' }] }),
        features,
      });
      expect(out.status).toBe('success');
      expect(out.outputs?.mediaCount).toBe(1);
      expect((out.outputs?.lessons as Record<string, unknown>[])[0].mediaAssetId).toBe('asset-1');
      expect(bind[0]).toEqual({ candidateId: 'c1', day: 1, assetId: 'asset-1', kind: 'image' });
    });
  });

  describe('sim-collect', () => {
    const verdictBody = (v: string) => ({ verdict: v, findings: [], personaSummary: `${v} summary` });

    it('typed-fails when the creator surface is absent', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.sim-collect'];
      await expect(run({ inputs: { candidateId: 'c1' }, features: {} }))
        .rejects.toMatchObject({ code: 'host_capability_missing' });
    });

    it('forwards a persona-tagged array of verbatim sim-verdict fields (never {summary,flags})', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.sim-collect'];
      let recorded: Record<string, unknown> | undefined;
      const features = {
        'kicktodo-creator': {
          frameResearch: async () => ({}),
          recordSimulationVerdicts: async (a: Record<string, unknown>) => { recorded = a; return { state: 'reviewing', verdicts: [] }; },
        },
      };
      const out = await run({
        inputs: {
          candidateId: 'c1',
          newcomer: verdictBody('pass'),
          // the un-unwrapped agent-runner output map on a port — must unwrap `.result`
          timePoor: { agentId: 'x', status: 'completed', text: '{}', result: verdictBody('flag') },
          skeptic: verdictBody('block'),
        },
        features,
      });
      expect(out.status).toBe('success');
      expect(recorded?.candidateId).toBe('c1');
      // The exact array shape the creator surface + its factory test consume:
      // { sim (kebab persona), verdict, findings, personaSummary } — no summary/flags.
      const verdicts = recorded?.verdicts as Record<string, unknown>[];
      expect(verdicts.map((v) => v.sim).sort()).toEqual(['newcomer', 'skeptic', 'time-poor']);
      expect(verdicts.find((v) => v.sim === 'newcomer')).toEqual({ sim: 'newcomer', verdict: 'pass', findings: [], personaSummary: 'pass summary' });
      expect(verdicts.find((v) => v.sim === 'time-poor')).toEqual({ sim: 'time-poor', verdict: 'flag', findings: [], personaSummary: 'flag summary' });
      for (const v of verdicts) { expect(v).not.toHaveProperty('summary'); expect(v).not.toHaveProperty('flags'); }
      expect(out.outputs?.recorded).toEqual(['newcomer', 'time-poor', 'skeptic']);
    });

    it('omits a persona that returned nothing readable (fail-closed coverage upstream)', async () => {
      const run = (await nodes())['feature.kicktodo.nodes.sim-collect'];
      let recorded: Record<string, unknown> | undefined;
      const features = {
        'kicktodo-creator': { frameResearch: async () => ({}), recordSimulationVerdicts: async (a: Record<string, unknown>) => { recorded = a; return {}; } },
      };
      await run({ inputs: { candidateId: 'c1', newcomer: verdictBody('pass'), skeptic: { garbage: true } }, features });
      expect((recorded?.verdicts as Record<string, unknown>[]).map((v) => v.sim)).toEqual(['newcomer']);
    });
  });
});

// ── 4. image-generate output schema honesty ───────────────────────────────
describe('core.openwop.ai image-generate output schema is honest (ADR 0458 P2)', () => {
  const schema = readJson(join(AI_PACK, 'schemas/image-generate.output.json'));
  const item = schema.properties.images.items;

  it('declares images[].url as required and NOT contentBase64', () => {
    expect(item.required).toContain('url');
    expect(item.properties.url).toBeDefined();
    expect(item.properties.contentBase64).toBeUndefined();
    expect(item.required).not.toContain('contentBase64');
  });

  it('accepts the real runtime shape and rejects the old base64 shape', async () => {
    const { default: Ajv2020 } = (await import('ajv/dist/2020.js')) as { default: new (o?: unknown) => { compile: (s: unknown) => (v: unknown) => boolean } };
    const validate = new Ajv2020({ strict: false }).compile(schema);
    expect(validate({ images: [{ url: 'media:tok-1', mimeType: 'image/png', metadata: { model: 'gpt-image-1' } }], usage: { images: 1 } })).toBe(true);
    expect(validate({ images: [{ contentBase64: 'aGk=' }] })).toBe(false);
  });
});
