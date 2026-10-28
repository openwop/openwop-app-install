/**
 * ADR 0946 P1 (D3) — one channel spec table.
 *
 * Exit criteria: one table, pinned by test; the duplicate rule list in
 * ads-creative-validate removed.
 *
 * - Every pack's `contentRules.generated.mjs` is exactly what the generator
 *   writes from the host table (a hand edit, or a table edit without a
 *   regenerate, reds "generated copies are current").
 * - The packs read the generated copy: campaign-channels' caps and
 *   near-duplicate check, ads-platforms' specs, and both ad-policy packs'
 *   rule list are the host's values (identity, not just equality, where the
 *   pack re-exports).
 * - Every text field cites its source (retrieved 2026-10-20): `hardMax` only
 *   from the platform's own page, `recommended` labelled official or
 *   third-party, unsourced fields carry no limit. Only hard limits block or
 *   truncate; recommendations warn.
 * - Each render template names the spec row it satisfies, and its size is
 *   checked against that row.
 *
 * Sabotage: editing a value in a generated copy reds the first case; changing
 *   `copyDefaults.linkedin` reds the LinkedIn pin; pointing a template at a row
 *   its size does not satisfy reds the template case.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expectedOutputs } from '../../../scripts/gen-content-rules.mjs';
import {
  CHANNEL_SPEC_IDS, adCopyCaps, adCopyRecommendations, channelSpec, isChannelSpecId, postBodyCaps, postBodyRecommendations, sizeSatisfies,
} from '../src/host/contentRules/channelSpecs.js';
import { AD_POLICY_RULES } from '../src/host/contentRules/adPolicyRules.js';
import { findNearDuplicates as hostFindNearDuplicates } from '../src/host/contentRules/similarity.js';
import { AD_LAYOUT_TEMPLATES as TEMPLATES } from '../src/features/creative-briefs/render/templates.js';
import * as channelLimits from '../../../packs/feature.campaign-channels.nodes/platformLimits.mjs';
import { platformSpecs } from '../../../packs/vendor.myndhyve.ads-platforms/index.mjs';
import { policyCheck } from '../../../packs/vendor.myndhyve.ads-policy/index.mjs';
import { creativeValidate } from '../../../packs/vendor.myndhyve.ads-creative-validate/index.mjs';

const REPO = join(import.meta.dirname, '..', '..', '..');

describe('ADR 0946 P1 — the channel spec table', () => {
  it('generated copies are current (one table, every pack reads the generated copy)', () => {
    const outputs = expectedOutputs();
    expect(Object.keys(outputs).sort()).toEqual([
      'packs/feature.campaign-channels.nodes/contentRules.generated.mjs',
      'packs/vendor.myndhyve.ads-creative-validate/contentRules.generated.mjs',
      'packs/vendor.myndhyve.ads-platforms/contentRules.generated.mjs',
      'packs/vendor.myndhyve.ads-policy/contentRules.generated.mjs',
    ]);
    for (const [rel, content] of Object.entries(outputs)) {
      expect(readFileSync(join(REPO, rel), 'utf8'), rel).toBe(content);
    }
  });

  it('no pack carries its own copy of the table or the rule list', () => {
    const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');
    expect(read('packs/vendor.myndhyve.ads-creative-validate/index.mjs')).not.toMatch(/const BUILT_IN_RULES = \[/);
    expect(read('packs/vendor.myndhyve.ads-policy/index.mjs')).not.toMatch(/const BUILT_IN_RULES = \[/);
    expect(read('packs/vendor.myndhyve.ads-platforms/index.mjs')).not.toMatch(/_SPECS = \[/);
    const limits = read('packs/feature.campaign-channels.nodes/platformLimits.mjs');
    expect(limits).not.toMatch(/PLATFORM_LIMITS = \{|SOCIAL_LIMITS = \{|function findNearDuplicates/);
  });

  it('every text field is sourced: hard limits cite an official page, every field is dated', () => {
    const counts: Record<string, number> = {};
    for (const id of CHANNEL_SPEC_IDS) {
      for (const [field, l] of Object.entries(channelSpec(id)?.text ?? {})) {
        counts[l.source.type] = (counts[l.source.type] ?? 0) + 1;
        expect(l.source.retrieved, `${id}.${field}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        if (l.hardMax !== undefined) expect([l.source.type, l.source.url?.startsWith('https://')], `${id}.${field}`).toEqual(['official', true]);
        if (l.source.type === 'unsourced') expect([l.hardMax, l.recommended], `${id}.${field}`).toEqual([undefined, undefined]);
        else expect(l.source.url ?? l.source.sites, `${id}.${field}`).toBeTruthy();
      }
    }
    // The 2026-10-20 research: 39 official, 10 third-party, 37 unsourced.
    expect(counts).toEqual({ official: 39, 'third-party': 10, unsourced: 37 });
  });

  it('campaign-channels enforces only official hard limits and warns on recommendations', () => {
    const caps = adCopyCaps();
    expect(channelLimits.PLATFORM_LIMITS).toEqual(caps);
    expect(channelLimits.PLATFORM_RECOMMENDED).toEqual(adCopyRecommendations());
    expect(channelLimits.SOCIAL_LIMITS).toEqual(postBodyCaps());
    expect(channelLimits.SOCIAL_RECOMMENDED).toEqual(postBodyRecommendations());
    // Google publishes hard maxima; LinkedIn publishes both; Meta and TikTok
    // publish no maximum, so nothing of theirs is truncated.
    expect(caps).toEqual({ google: { headline: 30, description: 90 }, linkedin: { headline: 200, description: 300 } });
    expect(adCopyRecommendations()).toEqual({ meta: { headline: 27 }, linkedin: { headline: 70, description: 100 }, tiktok: { headline: 100 } });
    expect(channelLimits.AD_FIELD_SCHEMA_MAX).toEqual({ headline: 200, description: 300, cta: 30 });
    expect(postBodyCaps()).toEqual({ linkedin: 3000, x: 280, twitter: 280, instagram: 2200 });
    // A 120-character LinkedIn headline is legal (warned), never truncated.
    const draft = { platformSets: [{ platform: 'linkedin', variants: [{ headline: 'x'.repeat(120), description: 'ok' }] }] };
    expect(channelLimits.validateAdVariants(draft)).toEqual([]);
    expect(channelLimits.adVariantRecommendations(draft)).toEqual([{ platform: 'linkedin', set: 0, index: 0, field: 'headline', length: 120, limit: 70 }]);
    // Over Google's published 30 is a hard finding.
    expect(channelLimits.validateAdVariants({ platformSets: [{ platform: 'google', variants: [{ headline: 'y'.repeat(31) }] }] })).toHaveLength(1);
  });

  it('near-duplicate detection is the host implementation', () => {
    const texts = ['Save an hour every day', 'save an hour every single day', 'Totally different copy here'];
    expect(channelLimits.findNearDuplicates(texts, 0.7)).toEqual(hostFindNearDuplicates(texts, 0.7));
    expect(hostFindNearDuplicates(texts, 0.7)).toEqual([{ a: 0, b: 1, similarity: 0.83 }]);
  });

  it('ads-platforms returns the table\'s rows, verbatim and in order', async () => {
    const r = await platformSpecs({ inputs: { platforms: ['meta', 'google'] }, config: {} });
    const rows = CHANNEL_SPEC_IDS.map((id) => channelSpec(id)).filter((row) => row?.spec && ['meta', 'google'].includes(row.platform ?? ''));
    expect(r.outputs.specSet.specs.map((s: { placement: string }) => s.placement).sort()).toEqual(rows.map((row) => row?.spec?.placement).sort());
    // The vendor shape: facets verbatim; textLimits.max is the official hard
    // limit where one is published, else the labelled legacy value.
    const li = r.outputs.specSet.specs.find((s: { placement: string }) => s.placement === 'linkedin-feed');
    expect(li).toBeUndefined(); // not requested
    const feed = r.outputs.specSet.specs.find((s: { placement: string }) => s.placement === 'meta-feed');
    const { textLimits, ...facets } = feed;
    expect(facets).toEqual(channelSpec('meta.feed')?.spec);
    expect(textLimits.headline).toEqual({ min: 1, max: 40, recommended: 27 });
    const all = await platformSpecs({ inputs: { platforms: ['linkedin'] }, config: {} });
    const liFeed = all.outputs.specSet.specs.find((s: { placement: string }) => s.placement === 'linkedin-feed');
    expect(liFeed.textLimits.headline).toEqual({ min: 1, max: 200, recommended: 70 });
  });

  it('both ad-policy packs evaluate the ONE rule list', async () => {
    expect(AD_POLICY_RULES.map((r) => r.id)).toEqual([
      'claims-guarantee', 'claims-income', 'claims-superlative', 'trademark-competitor',
      'prohibited-before-after', 'prohibited-urgency-scam', 'targeting-discrimination',
    ]);
    const inputs = { copyText: { headline: '100% guaranteed results', description: 'Earn $5000 a month' }, platforms: ['meta'] };
    const a = await policyCheck({ inputs, config: {} });
    const b = await creativeValidate({ inputs, config: {} });
    const ids = (checks: Array<{ rule?: string; status?: string }>): string[] => checks.filter((c) => c.status === 'fail' && c.rule).map((c) => c.rule ?? '').sort();
    const policyRules = ids(a.outputs.riskFlags);
    const validateRules = ids(b.outputs.report.checks);
    expect(policyRules).toEqual(['claims-guarantee', 'claims-income']);
    expect(policyRules.length).toBeGreaterThan(0);
    expect(validateRules).toEqual(policyRules);
  });

  it('every render template names a spec row its size satisfies', () => {
    expect(TEMPLATES.length).toBeGreaterThan(0);
    for (const t of TEMPLATES) {
      expect(isChannelSpecId(t.channelSpecId), `${t.templateId} → ${t.channelSpecId}`).toBe(true);
      expect(sizeSatisfies(t.channelSpecId, t.width, t.height), `${t.templateId} ${t.width}x${t.height} vs ${t.channelSpecId}`).toBe(true);
    }
    // The check is not vacuous: a banner size does not satisfy a 9:16 row.
    expect(sizeSatisfies('meta.stories', 728, 90)).toBe(false);
    expect(sizeSatisfies('google.display-banner', 300, 251)).toBe(false);
  });

  it('every channel spec id is a well-formed, unique dotted id', () => {
    expect(new Set(CHANNEL_SPEC_IDS).size).toBe(CHANNEL_SPEC_IDS.length);
    for (const id of CHANNEL_SPEC_IDS) expect(id).toMatch(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
    for (const id of ['meta.feed', 'google.search', 'tiktok.feed', 'linkedin.feed', 'x.post', 'email', 'landing']) expect(isChannelSpecId(id)).toBe(true);
  });
});
