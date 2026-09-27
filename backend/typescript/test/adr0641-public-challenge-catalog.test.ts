/**
 * ADR 0641 phase 3 + test-plan item 5 — the anonymous challenge catalog.
 *
 * Test-plan item 5 asks two things: an anonymous GET returns published rows for
 * the named org, and drafts never resolve. Both are asserted here against the
 * SERVICE, which is where the gates live; the route is a thin `res.json` over it.
 *
 * The third group is not in the ADR's list and is the one I would not omit: the
 * toggle gate and the unknown-org path must be INDISTINGUISHABLE. If "feature
 * off" 403s while "no such org" 404s, the endpoint becomes an oracle for which
 * orgs run KickTodo — a fact nobody asked it to publish.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const getOrg = vi.fn();
const resolveOne = vi.fn();
const listPublishedForLocale = vi.fn();

vi.mock('../src/host/accessControlService.js', () => ({ getOrg: (...a: unknown[]) => getOrg(...a) }));
vi.mock('../src/host/featureToggles/service.js', () => ({ resolveOne: (...a: unknown[]) => resolveOne(...a) }));
vi.mock('../src/features/kicktodo-core/challengeService.js', () => ({
  listPublishedForLocale: (...a: unknown[]) => listPublishedForLocale(...a),
}));

const { publicChallengeCatalog } = await import('../src/features/kicktodo-core/publicCatalogService.js');

const activity = (day: number) => ({
  stableActivityId: `a${day}`, day, title: `Day ${day}`, instructions: `Do the day-${day} thing`,
  estimatedMinutes: 10, evidencePolicy: 'note' as const,
});
const published = (id: string) => ({
  challenge: {
    id, version: 2, status: 'published' as const, tenantId: 't1',
    title: 'Sleep', summary: 'Sleep better', outcome: 'Rested', durationDays: 7,
    activities: [activity(1), activity(2)],
  },
  servedLocale: 'en', exactLocale: true,
});

beforeEach(() => {
  getOrg.mockReset(); resolveOne.mockReset(); listPublishedForLocale.mockReset();
  getOrg.mockResolvedValue({ orgId: 'acme', tenantId: 't1' });
  resolveOne.mockResolvedValue({ enabled: true });
  listPublishedForLocale.mockResolvedValue([published('c1')]);
});

describe('ADR 0641 p3 — anonymous catalog returns published rows for the named org', () => {
  it('resolves the tenant SERVER-SIDE from the org path segment', async () => {
    await publicChallengeCatalog('acme', 'en');
    expect(getOrg).toHaveBeenCalledWith('acme');
    // The tenant reaching the data read is the one getOrg returned — never
    // anything derived from the request. That is the whole reason this surface
    // needs no credential.
    expect(listPublishedForLocale).toHaveBeenCalledWith('t1', 'en');
  });

  it('projects to the public shape and KEEPS activities', async () => {
    const out = await publicChallengeCatalog('acme', 'en');
    expect(out.challenges).toHaveLength(1);
    const c = out.challenges[0]!;
    expect(c).toMatchObject({ challengeId: 'c1', version: 2, title: 'Sleep', durationDays: 7 });
    // ADR 0641 decision 5 rejected routing challenges through `entityList`
    // BECAUSE a kernel projection is scalars-only and would drop the day-by-day
    // curriculum — "a catalog of stubs". Having rejected that path for exactly
    // this loss, the projection would be incoherent without it.
    expect(c.activities).toHaveLength(2);
    expect(c.activities[0]).toEqual({ day: 1, title: 'Day 1', instructions: 'Do the day-1 thing', estimatedMinutes: 10, evidencePolicy: 'note' });
  });

  it('carries the evidence policy and the depth — the commitment, not a mechanic of it (2026-09-16 correction)', async () => {
    // Measured on kicktodo.com at `302a534`: with `evidencePolicy` omitted, the
    // signed-out preview labelled every activity "just check in" while the
    // signed-in page for the same challenge said "note" — under a sentence
    // promising the preview is exactly what the visitor will commit to.
    listPublishedForLocale.mockResolvedValue([
      { ...published('c1'), challenge: { ...published('c1').challenge, depthLevel: 'intermediate' } },
      published('c2'),
    ]);
    const [withDepth, withoutDepth] = (await publicChallengeCatalog('acme', 'en')).challenges;
    expect(withDepth!.activities.map((a) => a.evidencePolicy)).toEqual(['note', 'note']);
    expect(withDepth!.depthLevel).toBe('intermediate');
    // Optional on the row stays optional on the wire — no invented default.
    expect(Object.hasOwn(withoutDepth!, 'depthLevel')).toBe(false);
    // The two fields that ARE mechanics stay off the wire.
    for (const a of withDepth!.activities as Array<Record<string, unknown>>) {
      expect(a.stableActivityId).toBeUndefined();
      expect(a.alternatives).toBeUndefined();
    }
  });

  it('never leaks authoring state onto the anonymous wire', async () => {
    const c = (await publicChallengeCatalog("acme", "en")).challenges[0]! as unknown as Record<string, unknown>;
    // Spelled-out projection, not a spread of the stored row: otherwise every
    // future internal field becomes a public one by default.
    for (const leaked of ['status', 'tenantId', 'authorSubject', 'translationOf', 'stableActivityId', 'activities.0.stableActivityId']) {
      expect(leaked.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], c)).toBeUndefined();
    }
  });

  it('carries the served locale AND whether it was exact', async () => {
    listPublishedForLocale.mockResolvedValue([{ ...published('c1'), servedLocale: 'en', exactLocale: false }]);
    const c = (await publicChallengeCatalog('acme', 'fr')).challenges[0]!;
    // A crawler must not be told a fallback is canonical.
    expect(c.servedLocale).toBe('en');
    expect(c.exactLocale).toBe(false);
  });

  it('drafts never resolve — the read delegates to the published-only lister', async () => {
    // `listPublishedForLocale` is the choke (challengeService filters
    // status === 'published'). Asserting the DELEGATION rather than re-filtering
    // here: a second filter in this service would be a second owner of "what is
    // public", and the two would drift.
    await publicChallengeCatalog('acme', 'en');
    expect(listPublishedForLocale).toHaveBeenCalledTimes(1);
    expect(listPublishedForLocale).not.toHaveBeenCalledWith('t1', expect.objectContaining({ includeDrafts: true }));
  });
});

describe('ADR 0641 p3 — off and absent are INDISTINGUISHABLE', () => {
  it('404s an unknown org', async () => {
    getOrg.mockResolvedValue(null);
    await expect(publicChallengeCatalog('nope', 'en')).rejects.toMatchObject({ code: 'not_found', httpStatus: 404 });
  });

  it('404s — not 403 — when the feature is OFF for that org', async () => {
    resolveOne.mockResolvedValue({ enabled: false });
    await expect(publicChallengeCatalog('acme', 'en')).rejects.toMatchObject({ code: 'not_found', httpStatus: 404 });
  });

  it('the two answers are byte-identical, so the endpoint is not an oracle', async () => {
    getOrg.mockResolvedValue(null);
    const absent = await publicChallengeCatalog('nope', 'en').catch((e) => e);
    getOrg.mockResolvedValue({ orgId: 'acme', tenantId: 't1' });
    resolveOne.mockResolvedValue({ enabled: false });
    const off = await publicChallengeCatalog('acme', 'en').catch((e) => e);
    expect(off.code).toBe(absent.code);
    expect(off.httpStatus).toBe(absent.httpStatus);
    expect(off.message).toBe(absent.message);
  });

  it('fails CLOSED when toggle resolution throws', async () => {
    // A toggle-store blip must not turn a public catalog into a 500, and must
    // not turn it into an open door either. Absent ⇒ off.
    resolveOne.mockRejectedValue(new Error('store down'));
    await expect(publicChallengeCatalog('acme', 'en')).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('gates on the ORG tenant, never on a caller-derived one', async () => {
    // The distinction ADR 0641 decision 12 turns on. Decision 12 bans tenant
    // overrides on a public ROUTE because the caller is `anon:<sid>`. Here the
    // subject is the tenant getOrg resolved from a path segment — stable across
    // visits and identical for every visitor of the org.
    await publicChallengeCatalog('acme', 'en');
    expect(resolveOne).toHaveBeenCalledWith('kicktodo-core', { tenantId: 't1' });
  });
});
