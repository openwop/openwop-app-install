/**
 * Content vs log lanes for the secret-shape scrub.
 *
 * `cleanString` (the log/label lane) rewrites any 40+ character run to
 * `[REDACTED:secret-shaped]`. On text that is PUBLISHED or SENT that silently
 * altered content: signed media URLs, long slugs, hashes, UTM values. The
 * content lane (`cleanContent` / `contentUrl`) never rewrites; a credential
 * shape is a typed refusal naming the field, and nothing is stored.
 *
 * One witness pair per migrated path: a long opaque run survives byte for byte,
 * and an `sk-…` key is a 400 `secret_shaped` that does not echo the key.
 *
 * Sabotage-witnessed: routing `cleanContent` back through `scrubSecretShaped`
 * reds every "survives" leg; dropping `refuseCredential` reds every "refused"
 * leg; reverting the export to `scrubSecretShaped` reds the export pair.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { cleanContent, cleanString, contentUrl, refuseIfScrubbed } from '../src/host/boundedStrings.js';
import { findCredentialShape, scrubSecretShaped } from '../src/host/redactSecrets.js';
import { createPage, validateSection } from '../src/features/cms/cmsService.js';
import { putSeo } from '../src/features/publishing/publishingService.js';
import { createProduct } from '../src/features/commerce/commerceService.js';
import { createBookingLink } from '../src/features/crm/entities/bookingLinks.js';
import { createShow } from '../src/features/podcasts/podcastsService.js';
import { upsertReview } from '../src/features/marketplace/reviewService.js';
import { createFunnel } from '../src/features/funnels/funnelsService.js';
import { createBrand } from '../src/features/brand/brandService.js';
import { generateScrubbed } from '../src/features/app-builder/export/exportService.js';
import { registerAppBuilderComponents } from '../src/features/app-builder/componentCatalog.js';
import { emitCandidateHooks } from '../src/features/campaign-brief/hookBankService.js';
import { createBrief } from '../src/features/creative-briefs/creativeBriefsService.js';
import { renderForBrief } from '../src/features/creative-briefs/render/renderService.js';

const HASH = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const SIGNED = `https://cdn.example.test/v/${HASH}?sig=Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg`;
const KEY = 'sk-live1234567890abcdef';
const T = 'scrub-t';
const O = 'scrub-o';

/** Expect a typed `secret_shaped` refusal that does not echo the key. */
async function refused(p: Promise<unknown> | (() => unknown), field?: string): Promise<void> {
  let err: unknown;
  try { await (typeof p === 'function' ? p() : p); } catch (e) { err = e; }
  expect(err, 'expected a refusal').toBeTruthy();
  expect(err).toMatchObject({ code: 'validation_error', httpStatus: 400, details: { reason: 'secret_shaped', ...(field ? { field } : {}) } });
  expect(JSON.stringify(err) + String((err as Error).message)).not.toContain(KEY);
}

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerAppBuilderComponents();
});

describe('the two lanes', () => {
  it('the log lane is unchanged: cleanString still rewrites both shapes', () => {
    expect(cleanString(`a ${HASH}`, 500)).toBe('a [REDACTED:secret-shaped]');
    expect(cleanString(`k ${KEY}`, 500)).toBe('k [REDACTED:secret-shaped]');
  });

  it('the content lane keeps long runs and refuses credentials, of every named kind', async () => {
    expect(cleanContent(`a ${HASH}`, 500, 'x')).toBe(`a ${HASH}`);
    expect(contentUrl(SIGNED, 2048, 'u')).toBe(SIGNED);
    expect(contentUrl('javascript:alert(1)', 2048, 'u')).toBe('');
    for (const k of [KEY, 'AKIAABCDEFGHIJKLMNOP', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'github_pat_11ABCDEFG0123456789abcd', 'xoxb-1234567890-abcdef', `AIza${'B'.repeat(35)}`]) {
      expect(findCredentialShape(`text ${k} text`), k).not.toBeNull();
      expect(() => cleanContent(`text ${k}`, 500, 'body')).toThrow(/looks like a credential/);
    }
    await refused(() => cleanContent(`hi ${KEY}`, 500, 'body'), 'body');
    // The strict internal lane (projects / team ledger) still refuses long runs too.
    expect(() => refuseIfScrubbed(`a ${HASH}`, 'goal')).toThrow(/secret-shaped/);
    expect(scrubSecretShaped(SIGNED)).not.toBe(SIGNED); // why content cannot use the log lane
  });

  it.each([KEY, `AIza${'B'.repeat(35)}`])('a credential in a field label is not echoed through a refusal', async (credential) => {
    let error: unknown;
    try { cleanContent(KEY, 500, `files.${credential}.html`); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: 'validation_error', httpStatus: 400, details: { field: '(redacted field)', reason: 'secret_shaped' } });
    expect(JSON.stringify(error) + String((error as Error).message)).not.toContain(credential);
  });
});

describe('every migrated content path: kept byte for byte, or a typed refusal', () => {
  it('CMS sections (rich text, a CTA link, a video src)', async () => {
    const rich = validateSection({ type: 'richText', data: { text: `See [the docs](${SIGNED}) or hash ${HASH}.` } });
    expect((rich.data as { text: string }).text).toBe(`See [the docs](${SIGNED}) or hash ${HASH}.`);
    const hero = validateSection({ type: 'hero', data: { heading: 'Hi', ctaLabel: 'Go', ctaUrl: SIGNED } });
    expect((hero.data as { ctaUrl: string }).ctaUrl).toBe(SIGNED);
    await refused(() => validateSection({ type: 'richText', data: { text: `key ${KEY}` } }), 'text');
    await refused(() => validateSection({ type: 'hero', data: { heading: 'Hi', ctaLabel: 'Go', ctaUrl: `https://x.test/?k=${KEY}` } }), 'link');
  });

  it('CMS page title and publishing SEO (canonical URL, meta)', async () => {
    const page = await createPage({ tenantId: T, orgId: O, title: `Release ${HASH}`, createdBy: 'u' });
    expect(page.title).toBe(`Release ${HASH}`);
    await refused(createPage({ tenantId: T, orgId: O, title: `Key ${KEY}`, createdBy: 'u' }), 'title');
    const canonical = `https://kicktodo.example/blog/plans-that-adapt-without-erasing-progress-${HASH}`;
    const seo = await putSeo(T, O, page.pageId, 'u', { canonicalUrl: canonical, metaDescription: `ref ${HASH}` });
    expect(seo).toMatchObject({ canonicalUrl: canonical, metaDescription: `ref ${HASH}` });
    await refused(putSeo(T, O, page.pageId, 'u', { ogTitle: KEY }), 'ogTitle');
  });

  it('commerce product (description, attributes)', async () => {
    const p = await createProduct({ tenantId: T, orgId: O, createdBy: 'u', type: 'physical', name: 'Box', description: `SKU ${HASH}`, price: 100, attributes: [{ label: 'Hash', value: HASH.slice(0, 60) }] });
    expect(p.description).toBe(`SKU ${HASH}`);
    await refused(createProduct({ tenantId: T, orgId: O, createdBy: 'u', type: 'physical', name: 'Box', description: KEY, price: 100 }), 'description');
  });

  it('booking link (description, video link)', async () => {
    const base = { tenantId: T, orgId: O, ownerUserId: 'u', title: 'Intro', timezone: 'UTC', weeklyHours: [{ day: 1, start: '09:00', end: '17:00' }], durations: [30], createdBy: 'u' };
    const meet = `https://zoom.example/j/${HASH.slice(0, 50)}`;
    const l = await createBookingLink({ ...base, description: `Agenda ${HASH}`, videoLink: meet });
    expect(l).toMatchObject({ description: `Agenda ${HASH}`, videoLink: meet });
    await refused(createBookingLink({ ...base, description: KEY }), 'description');
  });

  it.each(['description', 'videoLink', 'location'] as const)('a refused booking %s does not reserve its public slug', async (field) => {
    const slug = `content-refusal-${field.toLowerCase()}`;
    const base = { tenantId: T, orgId: O, ownerUserId: 'u', title: 'Intro', slug, timezone: 'UTC', weeklyHours: [{ day: 1, start: '09:00', end: '17:00' }], durations: [30], createdBy: 'u' };
    await refused(createBookingLink({ ...base, [field]: KEY }), field);
    const accepted = await createBookingLink(base);
    expect(accepted.slug).toBe(slug);
  });

  it('podcast show (RSS description)', async () => {
    const s = await createShow(T, O, 'u', { title: 'Show', author: 'A', description: `Feed ${HASH}` });
    expect(s.description).toBe(`Feed ${HASH}`);
    await refused(createShow(T, O, 'u', { title: 'Show 2', author: 'A', description: KEY }), 'description');
  });

  it('marketplace review body', async () => {
    const r = await upsertReview({ tenantId: T, orgId: O, packName: 'p', rating: 5, body: `Works with ${HASH}`, authorId: 'A' });
    expect(r.body).toBe(`Works with ${HASH}`);
    await refused(upsertReview({ tenantId: T, orgId: O, packName: 'p', rating: 5, body: KEY, authorId: 'B' }), 'body');
  });

  it('funnel UTM rule values', async () => {
    const page = await createPage({ tenantId: T, orgId: O, title: 'Step', createdBy: 'u' });
    const utm = `cmp_${HASH}`;
    const steps = (value: string) => [
      { stepId: 's1', kind: 'landing', pageId: page.pageId, routing: [{ when: { utm: { key: 'utm_campaign', value } }, goto: 's2' }] },
      { stepId: 's2', kind: 'thankyou', pageId: page.pageId },
    ];
    const f = await createFunnel({ tenantId: T, orgId: O, createdBy: 'u', name: 'F', steps: steps(utm) });
    expect(f.steps[0]!.routing![0]!.when).toMatchObject({ utm: { key: 'utm_campaign', value: utm } });
    await refused(createFunnel({ tenantId: T, orgId: O, createdBy: 'u', name: 'F2', steps: steps(KEY) }), 'utm.value');
  });

  it('brand identity (footer text, a data-URI favicon)', async () => {
    const favicon = `data:image/svg+xml;base64,${'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4'.repeat(2)}`;
    const b = await createBrand(T, O, 'u', { name: 'Acme', identity: { footerText: `Build ${HASH}`, logo: { faviconSrc: favicon } } });
    const id = (b as unknown as { identity?: { footerText?: string; logo?: { faviconSrc?: string } } }).identity;
    expect(id?.footerText).toBe(`Build ${HASH}`);
    expect(id?.logo?.faviconSrc).toBe(favicon);
    await refused(createBrand(T, O, 'u', { name: 'Acme 2', identity: { footerText: KEY } }), 'footerText');
  });

  it('campaign-brief hooks: kept, or refused per variant while the batch lands', async () => {
    const out = await emitCandidateHooks(T, O, 'angle-1', [{ text: `Try ${HASH}`, format: 'claim' }, { text: `Use ${KEY}`, format: 'claim' }], 'u');
    expect(out.emitted.map((h) => h.text)).toEqual([`Try ${HASH}`]);
    expect(out.errors).toHaveLength(1);
    expect(JSON.stringify(out.errors)).not.toContain(KEY);
  });

  it('creative render copy (headline, body)', async () => {
    const b = await createBrief(T, O, 'u', { title: 'Brief', assetType: 'image', sceneDescription: 'Scene.' });
    const r = await renderForBrief(T, O, 'u', { briefId: b.briefId, templateId: 'meta.feed.1x1', copy: { headline: 'Launch', body: `Ref ${HASH.slice(0, 48)}` } });
    expect(r.copy.body).toBe(`Ref ${HASH.slice(0, 48)}`);
    await refused(renderForBrief(T, O, 'u', { briefId: b.briefId, templateId: 'meta.feed.1x1', copy: { headline: KEY } }), 'headline');
  });

  it('app-builder export: refused naming the file, never rewritten', async () => {
    const app = (text: string) => ({ name: 'Probe', screens: [{ id: 'home', name: 'Home', isInitial: true, components: [{ type: 'text', props: { text } }] }] });
    const ok = generateScrubbed(app(`build ${HASH}`), 'html-css');
    expect(ok.files.some((f) => f.content.includes(HASH))).toBe(true);
    expect(ok.files.some((f) => f.content.includes('[REDACTED:secret-shaped]'))).toBe(false);
    await refused(() => generateScrubbed(app(`key ${KEY}`), 'html-css'));
  });
});
