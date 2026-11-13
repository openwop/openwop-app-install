/**
 * ADR 1112 P4 (D8) — a scheduleSim saved before a rule existed still publishes and erases.
 *
 * Pins:
 *  - the kernel's structure check of a stored row (baseLocale '') keeps duplicate milestone or
 *    decision ids, an unknown milestone, group key or dependency, as they are: no throw, and
 *    no change to the ids;
 *  - the author's save (baseLocale 'en') still refuses each of them, with the reason and,
 *    for a repeat, the id or key that repeats;
 *  - end to end: a legacy row with duplicate decision ids migrates to the kernel, is
 *    submitted, published and unpublished, and an erasure pass over it completes; the
 *    scheduled-publish sweep publishes one too.
 *
 * Sabotage, each restored, each red: make `refuse` throw whatever `stored` says; pass
 * `stored` as false from validateSection.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { eraseCmsSubject, getPage, migratePagesToKernel, setScheduledPublish, transitionPage, validateSections } from '../src/features/cms/cmsService.js';
import { processScheduledPublishes } from '../src/features/cms/publishSweep.js';

type Raw = Record<string, unknown>;
const sim = (data: Raw) => [{ sectionId: 'sec:s1', type: 'scheduleSim', data }];
const milestones = [{ id: 'm1', label: 'Design' }, { id: 'm2', label: 'Build' }];
const ok = { milestones, decisions: [{ id: 'a', title: 'Tile', milestone: 'm1' }, { id: 'b', title: 'Tap', milestone: 'm2', dependsOn: ['a'] }] };

/** Each shape a stored row can hold from before ADR 1112's rules, with the refusal it now gets. */
const legacy: [string, Raw, RegExp][] = [
  ['duplicate decision ids', { ...ok, decisions: [{ id: 'a', title: 'Tile', milestone: 'm1' }, { id: 'a', title: 'Tap', milestone: 'm2' }] }, /two decisions share an id \(a\)/],
  ['duplicate milestone ids', { ...ok, milestones: [{ id: 'm1', label: 'Design' }, { id: 'm1', label: 'Build' }], decisions: [{ id: 'a', title: 'Tile', milestone: 'm1' }] }, /two milestones share an id \(m1\)/],
  ['an explicit id colliding with an implicit one', { ...ok, milestones: [{ label: 'Design' }, { id: 'm1', label: 'Build' }], decisions: [{ id: 'a', title: 'Tile', milestone: 'm1' }] }, /two milestones share an id/],
  ['an unknown milestone', { ...ok, decisions: [{ id: 'a', title: 'Tile', milestone: 'gone' }] }, /names a milestone that does not exist/],
  ['an unknown dependency', { ...ok, decisions: [{ id: 'a', title: 'Tile', milestone: 'm1', dependsOn: ['gone'] }] }, /depends on a decision that does not exist/],
  ['an unknown role', { ...ok, roles: [{ key: 'client', label: 'Client' }], decisions: [{ id: 'a', title: 'Tile', milestone: 'm1', role: 'gone' }] }, /names a role that does not exist/],
  ['two roles sharing a key', { ...ok, roles: [{ key: 'client', label: 'Client' }, { key: 'client', label: 'Owner' }] }, /two roles share a key \(client\)/],
];

describe('ADR 1112 D8 — the structure check keeps a stored row as it is', () => {
  for (const [name, data, refusal] of legacy) {
    it(`${name}: kept by the structure check, refused for the author`, () => {
      const [stored] = validateSections(sim(data), '');
      const ids = (k: string): unknown => ((stored!.data[k] as Raw[] | undefined) ?? []).map((x) => x.id);
      expect(ids('decisions')).toEqual((data.decisions as Raw[]).map((x) => x.id));
      expect(() => validateSections(sim(data), 'en')).toThrow(refusal);
    });
  }
});

describe('ADR 1112 D8 — a legacy row publishes and erases', () => {
  beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

  it('migrates, submits, publishes, unpublishes and erases a page with duplicate decision ids', async () => {
    const T = 'tenant-d8';
    const ORG = 'org-d8';
    const row = {
      pageId: 'page-d8', tenantId: T, orgId: ORG, title: 'Schedule', slug: 'schedule', status: 'draft' as const,
      sections: sim(legacy[0]![1]), version: 1, createdBy: 'u-author', updatedBy: 'u-author',
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    };
    await new DurableCollection<typeof row>('cms:page', (p) => p.pageId).put(row);
    expect((await migratePagesToKernel()).migrated).toBe(1);
    await transitionPage(T, ORG, 'page-d8', 'submit', 'u-author');
    await transitionPage(T, ORG, 'page-d8', 'publish', 'u-admin');
    expect((await getPage(T, ORG, 'page-d8'))?.status).toBe('published');
    await transitionPage(T, ORG, 'page-d8', 'unpublish', 'u-admin');
    await expect(eraseCmsSubject(T, 'u-author')).resolves.toBeDefined();
    const page = await getPage(T, ORG, 'page-d8');
    expect(page?.createdBy).not.toBe('u-author'); // the erasure wrote the page
    expect((page?.sections[0]?.data.decisions as Raw[]).map((x) => x.id)).toEqual(['a', 'a']); // kept as stored
  });

  it('the scheduled-publish sweep publishes a legacy row, not clears it as failed (PROBE-1112-W4)', async () => {
    const T = 'tenant-d8s';
    const ORG = 'org-d8s';
    const row = {
      pageId: 'page-d8s', tenantId: T, orgId: ORG, title: 'Scheduled schedule', slug: 'scheduled-schedule', status: 'draft' as const,
      sections: sim(legacy[0]![1]), version: 1, createdBy: 'u-author', updatedBy: 'u-author',
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    };
    await new DurableCollection<typeof row>('cms:page', (p) => p.pageId).put(row);
    await migratePagesToKernel();
    await setScheduledPublish(T, ORG, 'page-d8s', new Date(Date.now() + 1000).toISOString(), 'u-admin');
    await processScheduledPublishes(Date.now() + 60_000);
    expect((await getPage(T, ORG, 'page-d8s'))?.status).toBe('published');
  });
});
