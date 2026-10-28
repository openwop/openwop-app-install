/**
 * ADR 0946 P2 (D5) — the creative rule sets in the content-rules library.
 *
 * Exit criteria: a positive and a negative fixture per rule; removing a rule
 * reddens a test.
 *
 * - `CLEAN` is the negative fixture for every rule at once: a member that
 *   satisfies all five rule sets produces no findings.
 * - `POSITIVE` holds one mutation of `CLEAN` per rule id, asserting that rule
 *   (and its action) fires. Deleting a rule's code reddens its row.
 * - "every rule id in the source has a fixture" reads the rule modules and
 *   fails when a rule id appears there with no row here, so a new rule cannot
 *   ship untested.
 *
 * Sabotage witnessed: removing the contrast check, the CTA preset check or
 * the cluster finding each reddens its row.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCreative, CREATIVE_RULES_VERSION } from '../src/host/contentRules/creative/index.js';
import { contrastRatio } from '../src/host/contentRules/creative/accessibility.js';
import type { CreativeLocks, CreativeMemberInput, CreativeRulesInput } from '../src/host/contentRules/creative/types.js';

const ASOF = '2026-10-20T00:00:00.000Z';
const LOCKS: CreativeLocks = {
  logo: { required: true, zones: [{ x: 0, y: 0, w: 30, h: 20 }], minPx: 48 },
  textColours: ['#ffffff'],
  backgroundColours: ['#000000'],
  fonts: ['Inter'],
  overrideBounds: { maxScale: 1.2, maxOffsetPct: 5 },
  requiredDisclaimer: 'Terms apply.',
};
const CONCEPTS = [
  { conceptId: 'c1', axes: { angle: 'Saves an hour', hook: 'benefit', visual: 'product_hero', format: 'static' } },
  { conceptId: 'c2', axes: { angle: 'Teams switched', hook: 'social_proof', visual: 'ugc', format: 'video' } },
];
const clean = (): CreativeMemberInput => ({
  memberId: 'm1', conceptId: 'c1', channel: 'meta.feed', kind: 'image',
  copy: { headline: 'Save an hour a day', description: 'Try it free for 14 days.', bodyText: 'The planner your team will use.', ctaText: 'Learn More' },
  media: { contentType: 'image/png', width: 1080, height: 1080, sizeBytes: 200_000, altText: 'A person planning their week on a laptop' },
  render: {
    textLayers: [{ layerId: 'headline', fg: '#ffffff', bg: '#000000', sizePx: 40, weight: 700 }],
    lockFacts: { logoPresent: true, logoBox: { x: 2, y: 2, w: 10, h: 8 }, logoPx: 96, textColours: ['#FFFFFF'], backgroundColours: ['#000000'], fonts: ['Inter'], nudges: { headline: { scale: 1.1, dxPct: 2 } }, disclaimerPresent: true },
  },
});
const input = (members: CreativeMemberInput[], extra: Partial<CreativeRulesInput> = {}): CreativeRulesInput => ({ asOf: ASOF, concepts: CONCEPTS, members, brandLocks: LOCKS, ...extra });
const ruleIds = (members: CreativeMemberInput[], extra?: Partial<CreativeRulesInput>): Array<[string, string]> =>
  checkCreative(input(members, extra)).findings.map((f) => [f.ruleId, f.action]);

type Mutate = (m: CreativeMemberInput) => CreativeMemberInput;
const withMedia = (patch: Partial<NonNullable<CreativeMemberInput['media']>>): Mutate => (m) => ({ ...m, media: { contentType: 'image/png', ...m.media, ...patch } });
const withFacts = (patch: Record<string, unknown>): Mutate => (m) => ({ ...m, render: { textLayers: m.render?.textLayers ?? [], lockFacts: { ...m.render!.lockFacts!, ...patch } } });
const video: Mutate = (m) => ({ ...m, kind: 'video', media: { contentType: 'video/mp4', width: 1080, height: 1080, sizeBytes: 1_000_000, durationSec: 15, hasCaptions: true } });

/** One mutation of the clean member per rule: [ruleId, expected action, mutation]. */
const POSITIVE: Array<[string, 'block' | 'needs_review' | 'info', Mutate]> = [
  ['channel-policy.unknown_channel', 'block', (m) => ({ ...m, channel: 'myspace.feed' })],
  ['channel-policy.text_max', 'block', (m) => ({ ...m, channel: 'linkedin.feed', copy: { headline: 'x'.repeat(201) } })],
  ['channel-policy.text_unverified', 'needs_review', (m) => ({ ...m, copy: { ...m.copy, description: 'x'.repeat(126) } })],
  ['channel-policy.text_recommended', 'info', (m) => ({ ...m, copy: { ...m.copy, headline: 'x'.repeat(30) } })],
  ['channel-policy.text_min', 'block', (m) => ({ ...m, copy: { ...m.copy, headline: ' ' } })],
  ['channel-policy.cta_preset', 'block', (m) => ({ ...m, copy: { ...m.copy, ctaText: 'Click Here Now' } })],
  ['channel-policy.media_type', 'block', (m) => ({ ...m, channel: 'meta.reels' })],
  ['channel-policy.format', 'block', withMedia({ contentType: 'image/gif' })],
  ['channel-policy.aspect_ratio', 'block', withMedia({ width: 1000, height: 300 })],
  ['channel-policy.min_size', 'block', withMedia({ width: 300, height: 300 })],
  ['channel-policy.file_size', 'block', withMedia({ sizeBytes: 40_000_000 })],
  ['channel-policy.duration', 'block', (m) => { const v = video(m); return { ...v, media: { ...v.media!, durationSec: 600 } }; }],
  ['channel-policy.size', 'block', (m) => ({ ...m, channel: 'google.display-banner', copy: undefined, media: { ...m.media!, width: 301, height: 250 } })],
  ['accessibility.alt_missing', 'block', withMedia({ altText: '' })],
  ['accessibility.alt_placeholder', 'block', withMedia({ altText: 'hero.png' })],
  ['accessibility.text_size', 'needs_review', (m) => ({ ...m, render: { ...m.render!, textLayers: [{ layerId: 'legal', fg: '#ffffff', bg: '#000000', sizePx: 9 }] } })],
  ['accessibility.contrast', 'block', (m) => ({ ...m, render: { ...m.render!, textLayers: [{ layerId: 'headline', fg: '#777777', bg: '#888888', sizePx: 16 }] } })],
  ['accessibility.contrast_unmeasured', 'info', (m) => ({ ...m, render: { ...m.render!, textLayers: [{ layerId: 'headline', fg: '#ffffff', bg: null, sizePx: 40 }] } })],
  ['accessibility.captions_missing', 'block', (m) => { const v = video(m); return { ...v, media: { ...v.media!, hasCaptions: false } }; }],
  ['accessibility.captions_unverified', 'needs_review', (m) => { const v = video(m); return { ...v, media: { ...v.media!, hasCaptions: undefined } }; }],
  ['fidelity.fail', 'block', (m) => ({ ...m, productRef: { productId: 'p1' }, fidelity: { verdictId: 'f1', status: 'fail', reason: 'wrong colourway' } })],
  ['fidelity.needs_review', 'needs_review', (m) => ({ ...m, productRef: { productId: 'p1' }, fidelity: { verdictId: 'f1', status: 'needs_review' } })],
  ['fidelity.unverified', 'needs_review', (m) => ({ ...m, productRef: { productId: 'p1' } })],
  ['brand-lock.unverified', 'needs_review', (m) => ({ ...m, render: { textLayers: m.render!.textLayers } })],
  ['brand-lock.logo_missing', 'block', withFacts({ logoPresent: false })],
  ['brand-lock.logo_zone', 'block', withFacts({ logoBox: { x: 80, y: 80, w: 10, h: 10 } })],
  ['brand-lock.logo_size', 'block', withFacts({ logoPx: 20 })],
  ['brand-lock.text_colour', 'block', withFacts({ textColours: ['#ff00ff'] })],
  ['brand-lock.background_colour', 'block', withFacts({ backgroundColours: ['#123456'] })],
  ['brand-lock.font', 'block', withFacts({ fonts: ['Comic Sans'] })],
  ['brand-lock.override_bounds', 'block', withFacts({ nudges: { logo: { scale: 3 } } })],
  ['brand-lock.disclaimer', 'block', withFacts({ disclaimerPresent: false })],
];

describe('ADR 0946 P2 — creative rule sets', () => {
  it('the clean member is the negative fixture for every rule', () => {
    expect(ruleIds([clean()])).toEqual([]);
    const v = video(clean());
    expect(ruleIds([v])).toEqual([]);
  });

  it.each(POSITIVE)('%s fires (%s)', (ruleId, action, mutate) => {
    const got = ruleIds([mutate(clean())]);
    expect(got, JSON.stringify(got)).toContainEqual([ruleId, action]);
  });

  it('diversity.cluster: near-duplicate copy in one ad set is needs_review; distinct concepts are not', () => {
    const a = clean();
    const b = { ...clean(), memberId: 'm2', copy: { ...clean().copy, headline: 'Save an hour each day' } };
    const report = checkCreative(input([a, b]));
    expect(report.findings.map((f) => [f.ruleId, f.action])).toEqual([['diversity.cluster', 'needs_review']]);
    expect(report.diversity.clusters).toEqual([{ adSet: 'meta.feed', memberIds: ['m1', 'm2'] }]);
    expect(report.diversity.copyMeasure).toBe('jaccard');
    expect(report.diversity.imageMeasure).toBe('not_measured');
    // Negative: the second member executes a different concept.
    const c = { ...b, conceptId: 'c2', copy: { ...b.copy, headline: 'Teams like yours switched' } };
    expect(checkCreative(input([a, c])).findings).toEqual([]);
    // Negative: same copy, but in another ad set.
    expect(checkCreative(input([a, { ...b, adSet: 'prospecting' }])).findings).toEqual([]);
  });

  it('diversity uses supplied embeddings and perceptual hashes, and records the model', () => {
    const a = { ...clean(), media: { ...clean().media!, perceptualHash: 'ffffffff00000000' } };
    const b = { ...clean(), memberId: 'm2', copy: { headline: 'Completely different words here', description: 'Other text.', bodyText: 'Nothing shared.', ctaText: 'Sign Up' }, media: { ...clean().media!, perceptualHash: 'ffffffff00000001' } };
    const report = checkCreative(input([a, b], { embeddings: { model: 'text-embed-x', vectors: { m1: [1, 0], m2: [0, 1] } } }));
    // Copy is far (cosine 0) but the images are 1 bit apart: still a cluster.
    expect(report.diversity.clusters).toHaveLength(1);
    expect(report.diversity).toMatchObject({ copyMeasure: 'embedding', imageMeasure: 'perceptual_hash', embeddingModel: 'text-embed-x', scoredAt: ASOF });
    expect(report.diversity.conceptDistance).toEqual({ mean: 0.8, min: 0.8, axisCoverage: { angle: 2, personaId: 1, hook: 2, visual: 2, format: 2 } });
  });

  it('is deterministic: same input, same ids and digest; a rule version change moves the digest', () => {
    const one = checkCreative(input([POSITIVE[3][2](clean())]));
    const two = checkCreative(input([POSITIVE[3][2](clean())]));
    expect(two).toEqual(one);
    expect(one.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(one.rulesetVersion).toBe(`creative@${CREATIVE_RULES_VERSION}`);
    expect(one.findings.every((f) => f.introduced)).toBe(true);
  });

  it('the contrast ratio is WCAG', () => {
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('red', '#fff')).toBeNull();
  });

  it('every rule id in the source has a fixture here', () => {
    const dir = join(import.meta.dirname, '../src/host/contentRules/creative');
    const inSource = new Set<string>();
    for (const f of readdirSync(dir)) {
      for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/'((?:channel-policy|accessibility|fidelity|brand-lock|diversity)\.[a-z_]+)'/g)) inSource.add(m[1]);
    }
    const covered = new Set([...POSITIVE.map((p) => p[0]), 'diversity.cluster']);
    expect([...inSource].filter((id) => !covered.has(id)).sort()).toEqual([]);
    expect(inSource.size).toBeGreaterThanOrEqual(33);
  });
});
