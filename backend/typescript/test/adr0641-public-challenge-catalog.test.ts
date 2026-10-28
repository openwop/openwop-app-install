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
 *
 * Tracker TST-BG3-16. Red when: a toggle-store error opens the catalog
 * (`.catch(() => true)`), "feature off" answers a different message or status than
 * "no such org", the data read or the toggle gate is keyed on the org id instead of
 * the org's tenant, the projection spreads the stored row (authoring state leaks) or
 * drops `evidencePolicy`, `depthLevel` gains a default, or Accept-Language is read as
 * the raw first segment.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Organization } from '../src/host/accessControlService.js';
import type { ResolvedAssignment, ToggleSubject } from '../src/host/featureToggles/types.js';
import type { NegotiatedChallenge } from '../src/features/kicktodo-core/challengeService.js';
import type { ChallengeActivity } from '../src/features/kicktodo-core/types.js';

const getOrg = vi.fn<(orgId: string) => Promise<Organization | null>>();
const resolveOne = vi.fn<(id: string, subject: ToggleSubject) => Promise<ResolvedAssignment | null>>();
const listPublishedForLocale = vi.fn<(tenantId: string, locale: string) => Promise<NegotiatedChallenge[]>>();

vi.mock('../src/host/accessControlService.js', () => ({ getOrg: (orgId: string) => getOrg(orgId) }));
vi.mock('../src/host/featureToggles/service.js', () => ({ resolveOne: (id: string, subject: ToggleSubject) => resolveOne(id, subject) }));
vi.mock('../src/features/kicktodo-core/challengeService.js', () => ({
  listPublishedForLocale: (tenantId: string, locale: string) => listPublishedForLocale(tenantId, locale),
}));

const { publicChallengeCatalog } = await import('../src/features/kicktodo-core/publicCatalogService.js');

// The fixture carries every authoring field the leak case names (author,
// translation lineage, activity alternatives), so a spread of the stored row
// would put each of them on the wire and the leak case would see it.
const activity = (day: number): ChallengeActivity => ({
  stableActivityId: `a${day}`, day, title: `Day ${day}`, instructions: `Do the day-${day} thing`,
  estimatedMinutes: 10, evidencePolicy: 'note',
  alternatives: [{ stableActivityId: `a${day}-alt`, title: 'Lighter', instructions: 'Do less', evidencePolicy: 'note' }],
});
const published = (id: string): NegotiatedChallenge => ({
  challenge: {
    id, version: 2, status: 'published', tenantId: 't1',
    authorSubject: 'user:author', translationOf: { challengeId: 'c0', version: 1 },
    title: 'Sleep', summary: 'Sleep better', outcome: 'Rested', durationDays: 7,
    activities: [activity(1), activity(2)],
    createdAt: '2026-09-01T00:00:00.000Z',
  },
  servedLocale: 'en', exactLocale: true,
});
const ACME: Organization = { orgId: 'acme', tenantId: 't1', name: 'Acme', slug: 'acme', createdBy: 'user:owner', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' };
const assignment = (enabled: boolean): ResolvedAssignment => ({ id: 'kicktodo-core', status: enabled ? 'on' : 'off', enabled, variant: null });

beforeEach(() => {
  getOrg.mockReset(); resolveOne.mockReset(); listPublishedForLocale.mockReset();
  getOrg.mockResolvedValue(ACME);
  resolveOne.mockResolvedValue(assignment(true));
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
    const c = (await publicChallengeCatalog('acme', 'en')).challenges[0]!;
    // Spelled-out projection, not a spread of the stored row: otherwise every
    // future internal field becomes a public one by default. An exact key set, so
    // `status`, `tenantId`, `authorSubject`, `translationOf` or any field added to
    // the row later cannot reach the wire unnoticed.
    expect(Object.keys(c).sort()).toEqual([
      'activities', 'challengeId', 'durationDays', 'exactLocale', 'outcome', 'servedLocale', 'summary', 'title', 'version',
    ]);
    for (const a of c.activities) {
      expect(Object.keys(a).sort()).toEqual(['day', 'estimatedMinutes', 'evidencePolicy', 'instructions', 'title']);
    }
  });

  it('carries the served locale AND whether it was exact', async () => {
    listPublishedForLocale.mockResolvedValue([{ ...published('c1'), servedLocale: 'en', exactLocale: false }]);
    const c = (await publicChallengeCatalog('acme', 'fr')).challenges[0]!;
    // A crawler must not be told a fallback is canonical.
    expect(c.servedLocale).toBe('en');
    expect(c.exactLocale).toBe(false);
  });

  it('reads Accept-Language by q-rank, never as the raw first segment (KT-I18N-ALANG-1)', async () => {
    // A browser sends `fr;q=0.9,en`. The old split-on-comma read requested the
    // literal `fr;q=0.9`, matched no row, and served every source silently,
    // then echoed the unparsed tag back as `locale`.
    const requestedFor = async (header: string | undefined): Promise<string> => {
      listPublishedForLocale.mockClear();
      const out = await publicChallengeCatalog('acme', header);
      expect(listPublishedForLocale).toHaveBeenCalledWith('t1', out.locale);
      return out.locale;
    };
    expect(await requestedFor('fr;q=0.9,en;q=0.8')).toBe('fr');
    expect(await requestedFor('de;q=0.2, pt-BR')).toBe('pt-BR');
    expect(await requestedFor('*')).toBe('en');
    expect(await requestedFor('')).toBe('en');
    expect(await requestedFor(undefined)).toBe('en');
  });

  it('drafts never resolve — the read delegates to the published-only lister', async () => {
    // `listPublishedForLocale` is the choke (challengeService filters
    // status === 'published'). Asserting the DELEGATION rather than re-filtering
    // here: a second filter in this service would be a second owner of "what is
    // public", and the two would drift.
    // What the lister returns is ALL that is served: one lister row in, one
    // catalog row out, no second source merged in beside it.
    const out = await publicChallengeCatalog('acme', 'en');
    expect(listPublishedForLocale).toHaveBeenCalledTimes(1);
    expect(listPublishedForLocale).toHaveBeenCalledWith('t1', 'en');
    expect(out.challenges.map((c) => c.challengeId)).toEqual(['c1']);
  });
});

describe('ADR 0641 p3 — off and absent are INDISTINGUISHABLE', () => {
  it('404s an unknown org', async () => {
    getOrg.mockResolvedValue(null);
    await expect(publicChallengeCatalog('nope', 'en')).rejects.toMatchObject({ code: 'not_found', httpStatus: 404 });
  });

  it('404s — not 403 — when the feature is OFF for that org', async () => {
    resolveOne.mockResolvedValue(assignment(false));
    await expect(publicChallengeCatalog('acme', 'en')).rejects.toMatchObject({ code: 'not_found', httpStatus: 404 });
  });

  it('the two answers are byte-identical, so the endpoint is not an oracle', async () => {
    getOrg.mockResolvedValue(null);
    const absent = await publicChallengeCatalog('nope', 'en').catch((e) => e);
    getOrg.mockResolvedValue(ACME);
    resolveOne.mockResolvedValue(assignment(false));
    const off = await publicChallengeCatalog('acme', 'en').catch((e) => e);
    expect(off.code).toBe(absent.code);
    expect(off.httpStatus).toBe(absent.httpStatus);
    expect(off.message).toBe(absent.message);
    // Same detail SHAPE too (only the echoed orgId value differs).
    expect(Object.keys(off.details ?? {}).sort()).toEqual(Object.keys(absent.details ?? {}).sort());
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
