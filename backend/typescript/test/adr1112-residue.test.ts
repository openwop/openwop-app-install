/**
 * ADR 1112 grade residue (2026-11-13): the byte limits' reasons, the page as readers get it,
 * the cost of delay's currency, and erasure over a page past the limits.
 *
 * Pins:
 *  - a section or page over its byte limit is refused with `details.reason`
 *    (`section_too_large`, `page_too_large`), which the editor keys its message on (UXG-1112-12);
 *  - a page whose shared sections resolve past the page limit is refused at publish with the
 *    `publish_blocked` reason every publish lane handles, rule `too_large`; one that fits
 *    publishes (DG-1112-5);
 *  - `currency` is kept when ISO 4217, dropped otherwise, and never kept on an overlay (UXG-1112-7);
 *  - an erasure pass over a tenant holding a stored scheduleSim past the section limit
 *    completes, and reaches the tenant's other page too (DG-1112-9).
 *
 * Sabotage, each restored, each red: drop `assertResolvedPageFits` from `transitionPage`;
 * drop either `reason`; drop `currency(d)` from the scheduleSim builder; run the byte check in
 * the kernel's structure check (baseLocale '').
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { OpenwopError } from '../src/types.js';
import { createPage, createSharedSection, eraseCmsSubject, getPage, migratePagesToKernel, transitionPage, validateSection, validateSections } from '../src/features/cms/cmsService.js';

type Raw = Record<string, unknown>;
const milestones = Array.from({ length: 12 }, (_, i) => ({ id: `m${i + 1}`, label: `Milestone ${i + 1}`, startWeek: i * 4, weeks: 4, floatDays: 3 }));
/** The P2 generator's shape (adr1112-schedulesim-scale.test.ts), without the grouping keys. */
const decisions = (n: number): Raw[] => Array.from({ length: n }, (_, i) => ({
  id: `DEC-${String(i).padStart(5, '0')}`,
  title: `What finish and size does item ${i} need for t`.slice(0, 39),
  element: `Kitchen layout and work zones ${i}`.slice(0, 33),
  milestone: `m${(i % 12) + 1}`, lockWeek: (i % 12) * 4 + 2, leadDays: (i % 7) * 7,
}));
const big = (n: number): Raw => ({ startDate: '2027-03-01', milestones, decisions: decisions(n) });
const overlayOf = (base: Raw): Raw => ({
  milestones: (base.milestones as Raw[]).map((m) => ({ ...m, label: `ES ${String(m.label)}` })),
  decisions: (base.decisions as Raw[]).map((x) => ({ ...x, title: `ES ${String(x.title)}`.slice(0, 39) })),
});
const refusal = (fn: () => unknown): OpenwopError => {
  try { fn(); } catch (e) { if (e instanceof OpenwopError) return e; throw e; }
  throw new Error('expected a refusal');
};

describe('ADR 1112 D5 — the byte refusals carry their reason (UXG-1112-12)', () => {
  it('a section past its limit: section_too_large, with bytes and limit', () => {
    const base = big(1_500);
    const e = refusal(() => validateSection({ type: 'scheduleSim', data: base, localizations: { es: overlayOf(base), fr: overlayOf(base), 'pt-BR': overlayOf(base) } }, 'en', 't1'));
    expect(e.details).toMatchObject({ reason: 'section_too_large', limit: 850_000 });
    expect(e.details?.bytes).toBeGreaterThan(850_000);
  });
  it('a page past its limit: page_too_large, with bytes and limit', () => {
    const sec = (id: string) => ({ sectionId: id, type: 'scheduleSim', data: big(1_400) });
    const e = refusal(() => validateSections([sec('sec:a'), sec('sec:b'), sec('sec:c'), sec('sec:d')], 'en', 't1'));
    expect(e.details).toMatchObject({ reason: 'page_too_large', limit: 975_000 });
  });
});

describe('UXG-1112-7 — the cost of delay currency', () => {
  const data = (currency: unknown): Raw => ({ milestones: milestones.slice(0, 1), decisions: [{ id: 'a', title: 'Tile', milestone: 'm1' }], currency });
  it('keeps an ISO 4217 code and drops anything else', () => {
    expect(validateSection({ type: 'scheduleSim', data: data('EUR') }, 'en', 't1').data.currency).toBe('EUR');
    expect(validateSection({ type: 'scheduleSim', data: data('EURO') }, 'en', 't1').data).not.toHaveProperty('currency');
    expect(validateSection({ type: 'scheduleSim', data: data(978) }, 'en', 't1').data).not.toHaveProperty('currency');
  });
  it('a locale overlay never carries it', () => {
    const s = validateSection({ type: 'scheduleSim', data: data('EUR'), localizations: { es: { currency: 'MXN', finishLabel: 'Fin' } } }, 'en', 't1');
    expect(s.localizations?.es).not.toHaveProperty('currency');
  });
});

describe('ADR 1112 D5 — the page as readers get it (DG-1112-5)', () => {
  beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
  const T = 'tenant-res';
  const ORG = 'org-res';

  it('refuses to publish a page whose shared sections resolve past the page limit; one that fits publishes', async () => {
    const base = big(1_500); // about 537 kB with one translation, so two refs pass 975 kB
    const shared = async (name: string): Promise<string> =>
      (await createSharedSection(T, ORG, { name, type: 'scheduleSim', data: base, localizations: { es: overlayOf(base) } }, 'u-author')).sharedSectionId;
    const [a, b] = [await shared('Schedule A'), await shared('Schedule B')];
    const ref = (id: string, sharedSectionId: string) => ({ sectionId: id, type: 'scheduleSim', ref: { sharedSectionId } });

    const two = await createPage({ tenantId: T, orgId: ORG, title: 'Two schedules', sections: [ref('sec:a', a), ref('sec:b', b)], createdBy: 'u-author' });
    await transitionPage(T, ORG, two.pageId, 'submit', 'u-author');
    const err = await transitionPage(T, ORG, two.pageId, 'publish', 'u-admin').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(OpenwopError);
    expect((err as OpenwopError).details).toMatchObject({ reason: 'publish_blocked', blockers: [{ rule: 'too_large', limit: 975_000 }] });
    expect((await getPage(T, ORG, two.pageId))?.status).toBe('in_review');

    const one = await createPage({ tenantId: T, orgId: ORG, title: 'One schedule', sections: [ref('sec:a', a)], createdBy: 'u-author' });
    await transitionPage(T, ORG, one.pageId, 'submit', 'u-author');
    await transitionPage(T, ORG, one.pageId, 'publish', 'u-admin');
    expect((await getPage(T, ORG, one.pageId))?.status).toBe('published');
  });

  it('an erasure pass over a stored scheduleSim past the section limit completes, for every page of the tenant (DG-1112-9)', async () => {
    const TE = 'tenant-res-erase';
    const base = big(1_500);
    const over = { sectionId: 'sec:big', type: 'scheduleSim', data: base, localizations: { es: overlayOf(base), fr: overlayOf(base), 'pt-BR': overlayOf(base) } };
    expect(() => validateSections([over], 'en', TE)).toThrow(/limit is 850 kB/); // past the limit for an author
    const row = (pageId: string, sections: unknown[]) => ({
      pageId, tenantId: TE, orgId: ORG, title: pageId, slug: pageId, status: 'draft' as const, sections, version: 1,
      createdBy: 'u-gone', updatedBy: 'u-gone', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    });
    const pages = new DurableCollection<ReturnType<typeof row>>('cms:page', (p) => p.pageId);
    await pages.put(row('page-big', [over]));
    await pages.put(row('page-plain', [{ sectionId: 'sec:t', type: 'richText', data: { html: '<p>Hello</p>' } }]));
    await migratePagesToKernel();
    await expect(eraseCmsSubject(TE, 'u-gone')).resolves.toBeDefined();
    for (const id of ['page-big', 'page-plain']) expect((await getPage(TE, ORG, id))?.createdBy).not.toBe('u-gone');
    expect(((await getPage(TE, ORG, 'page-big'))?.sections[0]?.data.decisions as Raw[]).length).toBe(1_500);
  });
});
