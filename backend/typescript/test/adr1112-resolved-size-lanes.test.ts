/**
 * ADR 1112 Phase E (2026-11-13): the resolved page limit on the lanes that do not go through
 * `transitionPage`. DG-1112-5 checked a publish and an edit of a published page; three other
 * lanes put shared-section content in front of readers.
 *
 * Pins:
 *  - an approval decide over the limit is refused BEFORE the resolve CAS: the row stays
 *    pending and never carries a `decidedBy` (a resolve-then-reopen would leave one);
 *  - a variant snapshot whose shared sections resolve over the limit cannot start an
 *    experiment and is not promotable (a running variant is served resolved);
 *  - a shared-section edit that would take a published page over the limit is refused and
 *    names the page; the same edit is allowed when only drafts use the section.
 *
 * Sabotage, each restored, each red: drop the pre-CAS check in `contentApproval.ts`; drop
 * `assertVariantFits` from `startExperiment`; drop the published-page loop in
 * `updateSharedSection`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createOrg } from '../src/host/accessControlService.js';
import { OpenwopError } from '../src/types.js';
import { getApproval, findLatestContentApprovalForPage, getContentApprovalHandler } from '../src/host/approvalService.js';
import { createPage, createSharedSection, getPage, transitionPage, updateSharedSection } from '../src/features/cms/cmsService.js';
import { queueContentApproval, registerContentApprovalGate } from '../src/features/cms/contentApproval.js';
import { checkArmPromotable, createExperiment, startExperiment } from '../src/features/cms/pageExperimentsService.js';

type Raw = Record<string, unknown>;
const milestones = Array.from({ length: 12 }, (_, i) => ({ id: `m${i + 1}`, label: `Milestone ${i + 1}`, startWeek: i * 4, weeks: 4, floatDays: 3 }));
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
/** About 537 kB (adr1112-residue.test.ts): two of these resolve past the 975 kB page limit. */
const heavy = (): { data: Raw; localizations: Raw } => { const b = big(1_500); return { data: b, localizations: { es: overlayOf(b) } }; };
const ref = (id: string, sharedSectionId: string) => ({ sectionId: id, type: 'scheduleSim', ref: { sharedSectionId } });
const T = 'tenant-lanes';
const ORG = 'org-lanes';
const shared = async (name: string, content: { data: Raw; localizations?: Raw }): Promise<string> =>
  (await createSharedSection(T, ORG, { name, type: 'scheduleSim', ...content }, 'u-author')).sharedSectionId;
const tooLarge = (e: unknown): void => {
  expect(e).toBeInstanceOf(OpenwopError);
  expect((e as OpenwopError).details).toMatchObject({ reason: 'publish_blocked', blockers: [{ rule: 'too_large', limit: 975_000 }] });
};

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerContentApprovalGate();
  // The decide lane checks the org and the decider's `host:members:manage`.
  await createOrg({ tenantId: T, createdBy: 'u-admin', name: 'Lanes', orgId: ORG, ownerSubject: 'u-admin' });
});

describe('ADR 1112 Phase E — resolved size on the lanes beside transitionPage', () => {
  it('an approval decide over the limit is refused before the CAS: the row stays pending, undecided', async () => {
    const [a, b] = [await shared('A', heavy()), await shared('B', heavy())];
    const page = await createPage({ tenantId: T, orgId: ORG, title: 'Two schedules', sections: [ref('sec:a', a), ref('sec:b', b)], createdBy: 'u-author' });
    const submitted = await transitionPage(T, ORG, page.pageId, 'submit', 'u-author');
    await queueContentApproval(T, ORG, submitted!, undefined, { submittedBy: 'u-author', notify: false });
    const row = await findLatestContentApprovalForPage(T, page.pageId);
    expect(row?.status).toBe('pending');
    const decide = getContentApprovalHandler();
    const err = await decide!(T, row!.approvalId, 'approved', { decidedByUserId: 'u-admin' }).then(() => null, (e: unknown) => e);
    tooLarge(err);
    const after = await getApproval(row!.approvalId);
    expect(after?.status).toBe('pending');
    expect(after?.decidedBy).toBeUndefined();
    expect((await getPage(T, ORG, page.pageId))?.status).toBe('in_review');
  });

  it('a variant snapshot that resolves over the limit cannot start and is not promotable', async () => {
    const [a, b] = [await shared('VA', heavy()), await shared('VB', heavy())];
    const page = await createPage({ tenantId: T, orgId: ORG, title: 'Experiment page', sections: [ref('sec:a', a)], createdBy: 'u-author' });
    await transitionPage(T, ORG, page.pageId, 'submit', 'u-author');
    await transitionPage(T, ORG, page.pageId, 'publish', 'u-admin');
    // A reviewed capture holding both refs: stored state a running variant could serve.
    const versionId = 'pver:lanes-variant';
    await new DurableCollection<Raw>('cms:pageversion', (v) => v.versionId as string).put({
      versionId, tenantId: T, orgId: ORG, pageId: page.pageId, version: 1, origin: 'publish', seq: 1,
      publishedBy: 'u-admin', publishedAt: new Date(Date.UTC(2026, 10, 13)).toISOString(),
      snapshot: { title: 'Experiment page', slug: page.slug, sections: [ref('sec:a', a), ref('sec:b', b)] },
    });
    const exp = await createExperiment({ tenantId: T, orgId: ORG, pageId: page.pageId, name: 'Size', createdBy: 'u-admin',
      variants: [{ key: 'control', versionId: null, weight: 50 }, { key: 'b', versionId, weight: 50 }] });
    tooLarge(await startExperiment(T, ORG, page.pageId, exp.experimentId, 'u-admin').then(() => null, (e: unknown) => e));
    expect(await checkArmPromotable(T, ORG, page.pageId, versionId, 'b')).toEqual({ ok: false, reason: 'publish_blocked' });
  });

  it('a shared-section edit that would take a published page over the limit is refused, naming it', async () => {
    const a = await shared('SA', heavy());
    const small = await shared('SB', { data: big(40) });
    const live = await createPage({ tenantId: T, orgId: ORG, title: 'Live schedules', sections: [ref('sec:a', a), ref('sec:b', small)], createdBy: 'u-author' });
    await transitionPage(T, ORG, live.pageId, 'submit', 'u-author');
    await transitionPage(T, ORG, live.pageId, 'publish', 'u-admin');

    const err = await updateSharedSection(T, ORG, small, heavy(), 'u-author').then(() => null, (e: unknown) => e);
    tooLarge(err);
    expect((err as OpenwopError).details).toMatchObject({ pageId: live.pageId, pageTitle: 'Live schedules' });

    // The same growth with only a draft using the section: allowed (the draft meets the check at publish).
    const draftOnly = await shared('SC', { data: big(40) });
    await createPage({ tenantId: T, orgId: ORG, title: 'Draft', sections: [ref('sec:a', a), ref('sec:c', draftOnly)], createdBy: 'u-author' });
    await expect(updateSharedSection(T, ORG, draftOnly, heavy(), 'u-author')).resolves.toMatchObject({ sharedSectionId: draftOnly });
  });
});
