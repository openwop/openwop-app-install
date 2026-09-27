/**
 * ADR 0355 — generation QA enforcement. Pins:
 *  - the limits table + validators (per-platform per-field, exact numbers,
 *    findings carry the SET index — QA-CODE-1);
 *  - table↔schema parity: the ad_variants schema maxLengths ARE
 *    AD_FIELD_SCHEMA_MAX, which IS the per-field max over PLATFORM_LIMITS
 *    (QA-CODE-5);
 *  - truncateAt word-boundary + flag; near-dup Jaccard; readability banding;
 *    unsupported-claim extraction (per text FIELD — QA-CODE-2);
 *  - the generate node ENFORCES limits (over-limit draft → regen once → the
 *    survivor is truncated + flagged BY SET INDEX, never shipped over-limit);
 *  - A/B pair shape is validated when pairing metadata is present (QA-CODE-4);
 *  - the prompt solicits every PLATFORM_LIMITS platform incl. TikTok (QA-CODE-6);
 *  - strict grounding floors kb.rag at STRICT_MIN_SCORE (KB-CODE-2 mirror);
 *  - managed creative-brief creation is idempotent + counts failures (CB-CODE-5);
 *  - iteration ops (unknown op fails; a valid op transforms the prompt);
 *  - persona lens + competitor block reach the prompt;
 *  - QA v2 findings ride the quality report.
 */
import { describe, expect, it } from 'vitest';
import {
  PLATFORM_LIMITS, AD_FIELD_SCHEMA_MAX, validateAdVariants, validateSocialPosts, truncateAt,
  findNearDuplicates, readabilityBand, findUnsupportedClaims, verifyClaims,
} from '../../../packs/feature.campaign-channels.nodes/platformLimits.mjs';
import { nodes as channelNodes, CHANNEL_SPEC } from '../../../packs/feature.campaign-channels.nodes/index.mjs';

// FU-CODE-1 — the fields the REAL assembleContext projection carries (pinned by
// the projection-contract test in campaign-brief-kb-integration.test.ts). The
// mock REJECTS anything else, so a test can never go green on a field the real
// surface silently omits (exactly how the missing-competitors seam hid).
const PROJECTION_FIELDS = new Set(['id', 'orgId', 'brandId', 'kbCollectionId', 'productName', 'industryVertical', 'groundingPolicy', 'competitors', 'personaIds']);
function briefFeature(extra: Record<string, unknown> = {}) {
  for (const k of Object.keys(extra)) {
    if (!PROJECTION_FIELDS.has(k)) throw new Error(`briefFeature mock: '${k}' is not a field the real assembleContext projection carries`);
  }
  return {
    assembleContext: async () => ({ found: true, brief: { id: 'b1', orgId: 'o1', productName: 'FlashPick', ...extra }, contextText: 'CONTEXT', valid: true, enabledChannels: ['ad_variants'], kernel: { headline: 'H', primaryCta: 'C', proofPoints: [] } }),
    getKernel: async () => ({ found: true, kernel: { headline: 'H', primaryCta: 'C', proofPoints: [] } }),
  };
}

describe('limits table + validators', () => {
  it('exact per-platform caps; findings carry the set index (QA-CODE-1)', () => {
    expect(PLATFORM_LIMITS.google).toEqual({ headline: 30, description: 90 });
    const findings = validateAdVariants({ platformSets: [{ platform: 'Google', variants: [{ headline: 'x'.repeat(31), description: 'ok' }] }] });
    expect(findings).toEqual([{ platform: 'google', set: 0, index: 0, field: 'headline', length: 31, limit: 30 }]);
    expect(validateSocialPosts({ posts: [{ platform: 'twitter', content: 'x'.repeat(281) }] })).toHaveLength(1);
  });

  it('duplicate same-platform sets: each finding names ITS set (QA-CODE-1)', () => {
    const findings = validateAdVariants({ platformSets: [
      { platform: 'google', variants: [{ headline: 'ok', description: 'ok' }] },
      { platform: ' Google ', variants: [{ headline: 'y'.repeat(31), description: 'ok' }] }, // norm() trims + lowercases
    ] });
    expect(findings).toEqual([{ platform: 'google', set: 1, index: 0, field: 'headline', length: 31, limit: 30 }]);
  });

  it('table↔schema parity: schema maxLengths ARE AD_FIELD_SCHEMA_MAX, which IS the per-field max over PLATFORM_LIMITS (QA-CODE-5)', () => {
    const limits = PLATFORM_LIMITS as Record<string, Record<string, number>>;
    for (const field of ['headline', 'description']) {
      const widest = Math.max(...Object.values(limits).map((l) => l[field]!));
      expect(AD_FIELD_SCHEMA_MAX[field]).toBe(widest);
    }
    // The schema numbers are BUILT from the constant — assert the built shape.
    const schemaJson = JSON.stringify(CHANNEL_SPEC.ad_variants!.schema);
    expect(schemaJson).toContain(`"headline":{"type":"string","maxLength":${AD_FIELD_SCHEMA_MAX.headline}}`);
    expect(schemaJson).toContain(`"description":{"type":"string","maxLength":${AD_FIELD_SCHEMA_MAX.description}}`);
    expect(schemaJson).toContain(`"cta":{"type":"string","maxLength":${AD_FIELD_SCHEMA_MAX.cta}}`);
  });

  it('the ad prompt solicits every PLATFORM_LIMITS platform incl. TikTok (QA-CODE-6)', () => {
    const system = CHANNEL_SPEC.ad_variants!.system;
    expect(system).toContain('TikTok');
    for (const p of Object.keys(PLATFORM_LIMITS)) expect(system.toLowerCase()).toContain(p);
  });

  it('truncateAt cuts at a word boundary + flags', () => {
    const r = truncateAt('alpha beta gamma delta', 12);
    expect(r.truncated).toBe(true);
    expect(r.text).toBe('alpha beta');
    expect(truncateAt('short', 30)).toEqual({ text: 'short', truncated: false });
  });

  it('near-dups, readability, unsupported claims', () => {
    expect(findNearDuplicates(['pick faster with robots', 'pick faster with robots now'], 0.7)).toHaveLength(1);
    expect(findNearDuplicates(['alpha beta', 'gamma delta'])).toHaveLength(0);
    expect(readabilityBand('See spot run. See spot go.').band).toBe('easy');
    expect(findUnsupportedClaims('We are 40% faster. Cited: 2x throughput [src_1].')).toEqual(['We are 40% faster.']);
  });
});

describe('generate node enforcement', () => {
  const mkCallAI = (first: Record<string, unknown>, second?: Record<string, unknown>) => {
    let calls = 0;
    const fn = async (): Promise<{ data: Record<string, unknown> }> => {
      calls += 1;
      return { data: calls === 1 ? first : (second ?? first) };
    };
    return { fn, count: () => calls };
  };

  it('over-limit draft: regen once; still over → truncated + flagged', async () => {
    const over = { platformSets: [{ platform: 'google', variants: [{ headline: 'A very long headline well beyond thirty characters', description: 'ok' }] }], citations: [] };
    const ai = mkCallAI(over, over); // regen returns the same over-limit draft
    const out = await channelNodes['feature.campaign-channels.nodes.generate']({
      features: { 'campaign-brief': briefFeature() }, callAI: ai.fn, inputs: { briefId: 'b1', channel: 'ad_variants' },
    });
    expect(out.status).toBe('success');
    expect(ai.count()).toBe(2); // one regen attempt
    const v = (out.outputs!.draft as { platformSets: Array<{ variants: Array<{ headline: string }> }> }).platformSets[0]!.variants[0]!;
    expect(v.headline.length).toBeLessThanOrEqual(30);
    expect(out.outputs!.draft).toMatchObject({ truncated: [{ platform: 'google', field: 'headline', index: 0 }] });
    // QA report carries no surviving charLimit ERRORs (post-truncation).
    const report = out.outputs!.qualityReport as { issues: Array<{ dimension: string }> };
    expect(report.issues.filter((i) => i.dimension === 'charLimit')).toHaveLength(0);
  });

  it('unknown refineOp fails; valid op + persona + competitors reach the prompt', async () => {
    const bad = await channelNodes['feature.campaign-channels.nodes.generate']({
      features: { 'campaign-brief': briefFeature() }, callAI: async () => ({ data: {} }), inputs: { briefId: 'b1', channel: 'ad_variants', refineOp: 'make-it-pop' },
    });
    expect(bad.status).toBe('failed');
    expect(bad.error?.code).toBe('unknown_refine_op');

    let prompt = '';
    const ok = await channelNodes['feature.campaign-channels.nodes.generate']({
      features: { 'campaign-brief': briefFeature({ competitors: ['AcmePick'] }) },
      callAI: async (req: { messages: Array<{ content: string }> }) => { prompt = req.messages[0]!.content; return { data: { platformSets: [{ platform: 'google', variants: [{ headline: 'ok', description: 'ok' }] }] } }; },
      inputs: { briefId: 'b1', channel: 'ad_variants', refineOp: 'add-urgency', personaId: 'cfo-1' },
    });
    expect(ok.status).toBe('success');
    expect(prompt).toContain('REFINE INSTRUCTION');
    expect(prompt).toContain('urgency');
    expect(prompt).toContain('FOCUS PERSONA: generate specifically for persona cfo-1');
    expect(prompt).toContain('COMPETITORS: differentiate against AcmePick');
  });

  it('QA v2: unsupported claims + near-dups ride the report', async () => {
    const draft = {
      platformSets: [{ platform: 'google', variants: [
        { headline: 'We are 40% faster', description: 'pick faster with robots' },
        { headline: 'We are 40% faster!', description: 'pick faster with robots now' },
      ] }],
    };
    const out = await channelNodes['feature.campaign-channels.nodes.generate']({
      features: { 'campaign-brief': briefFeature() }, callAI: async () => ({ data: draft }), inputs: { briefId: 'b1', channel: 'ad_variants' },
    });
    const report = out.outputs!.qualityReport as { issues: Array<{ dimension: string }>; readability: { band: string } };
    expect(report.issues.some((i) => i.dimension === 'factCheck')).toBe(true);
    expect(report.issues.some((i) => i.dimension === 'variety')).toBe(true);
    expect(['easy', 'standard', 'technical']).toContain(report.readability.band);
  });

  it('QA-CODE-2: a [src_N] in ONE field does not suppress uncited claims in ANOTHER', async () => {
    const draft = {
      platformSets: [{ platform: 'google', variants: [
        { headline: '2x throughput [src_1]', description: 'ok' },        // cited claim
        { headline: 'We are 40% faster', description: 'totally different words' }, // UNCITED claim
      ] }],
    };
    const out = await channelNodes['feature.campaign-channels.nodes.generate']({
      features: { 'campaign-brief': briefFeature() }, callAI: async () => ({ data: draft }), inputs: { briefId: 'b1', channel: 'ad_variants' },
    });
    const report = out.outputs!.qualityReport as { issues: Array<{ dimension: string; description: string; claims?: string[] }> };
    const claim = report.issues.find((i) => i.dimension === 'factCheck' && Array.isArray(i.claims));
    expect(claim).toBeTruthy();
    expect(claim!.claims!.some((c) => c.includes('40% faster'))).toBe(true);
  });

  it('QA-CODE-1: duplicate same-platform sets — truncation hits the finding\'s OWN set, not the first match', async () => {
    const longHeadline = 'A very long headline well beyond thirty characters';
    const dup = { platformSets: [
      { platform: 'google', variants: [{ headline: 'short and fine', description: 'ok' }] },
      { platform: 'google', variants: [{ headline: longHeadline, description: 'ok' }] },
    ], citations: [] };
    const ai = mkCallAI(dup, dup); // regen returns the same draft
    const out = await channelNodes['feature.campaign-channels.nodes.generate']({
      features: { 'campaign-brief': briefFeature() }, callAI: ai.fn, inputs: { briefId: 'b1', channel: 'ad_variants' },
    });
    expect(out.status).toBe('success');
    const sets = (out.outputs!.draft as { platformSets: Array<{ variants: Array<{ headline: string }> }> }).platformSets;
    expect(sets[0]!.variants[0]!.headline).toBe('short and fine'); // untouched
    expect(sets[1]!.variants[0]!.headline.length).toBeLessThanOrEqual(30); // the REAL offender was cut
  });

  it('QA-CODE-4: A/B metadata without proper pairs/hypothesis → WARNING finding, node still succeeds', async () => {
    const draft = {
      platformSets: [{ platform: 'google', hypothesis: 'benefit-led vs fear-of-loss', variants: [
        { headline: 'alpha one', description: 'first idea here', abLabel: 'A' },
        { headline: 'beta two', description: 'second idea here', abLabel: 'A' }, // mislabeled — should be B
        { headline: 'gamma three', description: 'third idea entirely', abLabel: 'B' }, // odd count
      ] }],
    };
    const out = await channelNodes['feature.campaign-channels.nodes.generate']({
      features: { 'campaign-brief': briefFeature() }, callAI: async () => ({ data: draft }), inputs: { briefId: 'b1', channel: 'ad_variants' },
    });
    expect(out.status).toBe('success'); // never fails the node
    const report = out.outputs!.qualityReport as { issues: Array<{ dimension: string; severity: string }> };
    const ab = report.issues.find((i) => i.dimension === 'abPairing');
    expect(ab).toBeTruthy();
    expect(ab!.severity).toBe('warning');

    // Well-formed pairs + hypothesis → NO finding.
    const good = {
      platformSets: [{ platform: 'google', hypothesis: 'benefit-led vs fear-of-loss', variants: [
        { headline: 'alpha one', description: 'first idea here', abLabel: 'A' },
        { headline: 'beta two', description: 'second idea entirely', abLabel: 'B' },
      ] }],
    };
    const ok = await channelNodes['feature.campaign-channels.nodes.generate']({
      features: { 'campaign-brief': briefFeature() }, callAI: async () => ({ data: good }), inputs: { briefId: 'b1', channel: 'ad_variants' },
    });
    const okReport = ok.outputs!.qualityReport as { issues: Array<{ dimension: string }> };
    expect(okReport.issues.some((i) => i.dimension === 'abPairing')).toBe(false);
  });

  it('KB-CODE-2: strict grounding passes the STRICT_MIN_SCORE floor to kb.rag; best-effort does not', async () => {
    const ragArgs: Array<Record<string, unknown>> = [];
    const kb = { rag: async (args: Record<string, unknown>) => { ragArgs.push(args); return { augmentedPrompt: 'GROUNDED', coverage: 'ok' }; } };
    const draft = { platformSets: [{ platform: 'google', variants: [{ headline: 'ok', description: 'ok' }] }] };

    const strict = await channelNodes['feature.campaign-channels.nodes.generate']({
      features: { 'campaign-brief': briefFeature({ groundingPolicy: 'strict', kbCollectionId: 'kc1' }), kb },
      callAI: async () => ({ data: draft }), inputs: { briefId: 'b1', channel: 'ad_variants' },
    });
    expect(strict.status).toBe('success');
    expect(ragArgs[0]!.minScore).toBe(0.25);

    await channelNodes['feature.campaign-channels.nodes.generate']({
      features: { 'campaign-brief': briefFeature({ kbCollectionId: 'kc1' }), kb },
      callAI: async () => ({ data: draft }), inputs: { briefId: 'b1', channel: 'ad_variants' },
    });
    expect(ragArgs[1]!.minScore).toBeUndefined(); // best-effort keeps the service default
  });

  it('CB-CODE-5: creative-brief creation is idempotent on (campaignBriefId, title) and counts failures', async () => {
    const draft = { briefs: [
      { format: 'hero-image', sceneDescription: 'A warehouse at dawn' },
      { format: 'social-card', sceneDescription: 'A robot picking' },
    ] };
    const created: Array<Record<string, unknown>> = [];
    const existing: Array<Record<string, unknown>> = [{ briefId: 'cb-existing', campaignBriefId: 'b1', title: 'FlashPick — hero-image' }];
    const cbSurface = {
      list: async () => ({ briefs: existing }),
      create: async (args: Record<string, unknown>) => {
        if (args.title === 'FlashPick — social-card') { created.push(args); return { brief: { briefId: 'cb-new' } }; }
        throw new Error('should not re-create an existing brief');
      },
    };
    const out = await channelNodes['feature.campaign-channels.nodes.generate']({
      features: { 'campaign-brief': briefFeature(), 'creative-briefs': cbSurface },
      callAI: async () => ({ data: draft }), inputs: { briefId: 'b1', channel: 'creative_briefs' },
    });
    expect(out.status).toBe('success');
    expect(created).toHaveLength(1); // only the missing one was created
    expect(out.outputs!.createdBriefIds).toEqual(['cb-existing', 'cb-new']); // existing id reused, no duplicate entity
    expect(out.outputs!.briefCreateErrors).toBeUndefined(); // no failures

    // A failing create is COUNTED, not swallowed.
    const failing = {
      list: async () => ({ briefs: [] }),
      create: async () => { throw new Error('boom'); },
    };
    const bad = await channelNodes['feature.campaign-channels.nodes.generate']({
      features: { 'campaign-brief': briefFeature(), 'creative-briefs': failing },
      callAI: async () => ({ data: draft }), inputs: { briefId: 'b1', channel: 'creative_briefs' },
    });
    expect(bad.status).toBe('success'); // entity creation stays additive
    expect(bad.outputs!.briefCreateErrors).toBe(2);
  });
});

// ── ADR 0355 decision 2 (Option A) — per-claim claim-verdict verification ──────
// verifyClaims scores each claim against the ALREADY-RETRIEVED grounding contexts
// (no second retrieval); strict grounding fails CLOSED on any `unsupported` claim.
describe('per-claim claim-verdict verification (ADR 0355 decision 2)', () => {
  const kbWith = (contexts: Array<{ text: string }>, coverage = 'ok') => ({
    rag: async () => ({ augmentedPrompt: 'GROUNDED', coverage, contexts }),
  });

  it('verifyClaims: cited+matched → supported; cited+bogus number → unsupported; uncited → uncited; non-claim → ignored', () => {
    const contexts = [{ text: 'Independent benchmarks show 2x throughput and 40% faster picking.' }];
    expect(verifyClaims(['Our robots deliver 2x throughput [src_1].'], contexts))
      .toEqual([{ claim: 'Our robots deliver 2x throughput [src_1].', verdict: 'supported' }]);
    expect(verifyClaims(['We are 99% faster [src_1].'], contexts))
      .toEqual([{ claim: 'We are 99% faster [src_1].', verdict: 'unsupported' }]);
    expect(verifyClaims(['We are 40% faster.'], contexts))
      .toEqual([{ claim: 'We are 40% faster.', verdict: 'uncited' }]);
    expect(verifyClaims(['A plain sentence with no quantified claim.'], contexts)).toEqual([]);
  });

  it('(a) a cited claim matching a context is supported → strict passes', async () => {
    const contexts = [{ text: 'Benchmarks show 2x throughput improvement in the warehouse.' }];
    const draft = { platformSets: [{ platform: 'google', variants: [{ headline: '2x throughput [src_1]', description: 'ok' }] }], citations: [{ marker: '[src_1]' }] };
    const strict = await channelNodes['feature.campaign-channels.nodes.generate']({
      features: { 'campaign-brief': briefFeature({ groundingPolicy: 'strict', kbCollectionId: 'kc1' }), kb: kbWith(contexts) },
      callAI: async () => ({ data: draft }), inputs: { briefId: 'b1', channel: 'ad_variants' },
    });
    expect(strict.status).toBe('success');
    const report = strict.outputs!.qualityReport as { claimVerdicts: Array<{ claim: string; verdict: string }> };
    expect(report.claimVerdicts).toEqual([{ claim: '2x throughput [src_1]', verdict: 'supported' }]);
  });

  it('(b) a cited claim (bogus number) matching NO context → unsupported → strict fails closed; best-effort passes with a warning', async () => {
    const contexts = [{ text: 'Benchmarks show 2x throughput improvement in the warehouse.' }];
    const draft = { platformSets: [{ platform: 'google', variants: [{ headline: 'Now 99% faster [src_1]', description: 'ok' }] }], citations: [{ marker: '[src_1]' }] };
    // strict — unsupported claim fails the node closed
    const strict = await channelNodes['feature.campaign-channels.nodes.generate']({
      features: { 'campaign-brief': briefFeature({ groundingPolicy: 'strict', kbCollectionId: 'kc1' }), kb: kbWith(contexts) },
      callAI: async () => ({ data: draft }), inputs: { briefId: 'b1', channel: 'ad_variants' },
    });
    expect(strict.status).toBe('failed');
    expect(strict.error?.code).toBe('grounding_insufficient');
    expect(strict.error?.message).toContain('unsupported');
    // best-effort — passes; the unsupported verdict rides as a WARNING
    const be = await channelNodes['feature.campaign-channels.nodes.generate']({
      features: { 'campaign-brief': briefFeature({ kbCollectionId: 'kc1' }), kb: kbWith(contexts) },
      callAI: async () => ({ data: draft }), inputs: { briefId: 'b1', channel: 'ad_variants' },
    });
    expect(be.status).toBe('success');
    const report = be.outputs!.qualityReport as { issues: Array<{ dimension: string; severity: string }>; claimVerdicts: Array<{ verdict: string }> };
    expect(report.claimVerdicts.some((v) => v.verdict === 'unsupported')).toBe(true);
    expect(report.issues.some((i) => i.dimension === 'factCheck' && i.severity === 'warning')).toBe(true);
  });

  it('(c) an uncited claim rides as an uncited warning even with contexts present (never a strict failure)', async () => {
    const contexts = [{ text: 'Benchmarks show 2x throughput improvement in the warehouse.' }];
    const draft = { platformSets: [{ platform: 'google', variants: [{ headline: 'We are 40% faster', description: 'ok' }] }] };
    const out = await channelNodes['feature.campaign-channels.nodes.generate']({
      features: { 'campaign-brief': briefFeature({ groundingPolicy: 'strict', kbCollectionId: 'kc1' }), kb: kbWith(contexts) },
      callAI: async () => ({ data: draft }), inputs: { briefId: 'b1', channel: 'ad_variants' },
    });
    expect(out.status).toBe('success'); // uncited alone never fails strict
    const report = out.outputs!.qualityReport as { issues: Array<{ dimension: string; description: string }>; claimVerdicts: Array<{ verdict: string }> };
    expect(report.claimVerdicts.some((v) => v.verdict === 'uncited')).toBe(true);
    expect(report.issues.some((i) => i.dimension === 'factCheck' && i.description.includes('no [src_N] citation'))).toBe(true);
  });
});
