/**
 * ADR 0430 P1–P3 — challenge content localization.
 *
 *  - a translation is its OWN challenge id pointing at a PUBLISHED source in
 *    the SAME tenant; cross-tenant / unpublished / translation-of-translation
 *    / same-locale links are refused (uniform message — no existence oracle)
 *  - Discover negotiates CONTENT locale independently of the UI locale:
 *    exact → same-language → source, with the served locale disclosed
 *  - retirement cascades DOWN a lineage only
 *
 * Sabotage witnesses (w41 /grade-tests): each lineage guard (asserted by its OWN
 * message — several share the class), the locale regex, the same-language
 * fallback, the lineage grouping, and the down-cascade.
 * Honest ceilings: (1) the foreign-tenant refusal is enforced by the
 * tenant-KEYED store read itself; the uniform message is the claim. (2) the
 * contentHash case below is a TRIPWIRE, not a probed guard — see its comment.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createDraft, publishChallenge, retireChallenge, retireLineage,
  listPublishedForLocale, getChallenge, ChallengeValidationError,
} from '../src/features/kicktodo-core/challengeService.js';
import { negotiateLocale, contentLocaleOf, challengeContentHash } from '../src/features/kicktodo-core/types.js';

const T = 'tenant-locale';
const OTHER = 'tenant-locale-other';

const ACT = [{ stableActivityId: 'a1', day: 1, title: 'A', instructions: 'i', evidencePolicy: 'attestation' as const }];

/** The lineage gate's typed refusal WITH its own message. */
const refusedWith = (message: RegExp) => (err: unknown): boolean =>
  err instanceof ChallengeValidationError && message.test(err.message);

async function publish(tenantId: string, title: string, extra: Record<string, unknown> = {}) {
  const d = await createDraft({ tenantId, title, summary: 's', outcome: 'o', durationDays: 2, activities: ACT, ...extra });
  await publishChallenge(tenantId, d.id, 1);
  return d.id;
}

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

describe('lineage integrity (P1)', () => {
  it('refuses a translation of an unpublished, foreign-tenant, chained, or same-locale source', async () => {
    const sourceId = await publish(T, 'Source');

    // Unpublished source.
    const draft = await createDraft({ tenantId: T, title: 'Draft', summary: 's', outcome: 'o', durationDays: 2, activities: ACT });
    await expect(createDraft({
      tenantId: T, title: 'T', summary: 's', outcome: 'o', durationDays: 2, activities: ACT,
      contentLocale: 'pt-BR', translationOf: { challengeId: draft.id, version: 1 },
    })).rejects.toSatisfy(refusedWith(/must reference a published challenge version/));

    // Foreign tenant — refused, and with the SAME message as "missing" (no oracle).
    const foreignId = await publish(OTHER, 'Foreign');
    await expect(createDraft({
      tenantId: T, title: 'T', summary: 's', outcome: 'o', durationDays: 2, activities: ACT,
      contentLocale: 'pt-BR', translationOf: { challengeId: foreignId, version: 1 },
    })).rejects.toSatisfy(refusedWith(/must reference a published challenge version/));

    // Same locale as the source.
    await expect(createDraft({
      tenantId: T, title: 'T', summary: 's', outcome: 'o', durationDays: 2, activities: ACT,
      contentLocale: 'en', translationOf: { challengeId: sourceId, version: 1 },
    })).rejects.toSatisfy(refusedWith(/locale different from its source/));

    // Missing locale on a translation, and a malformed tag.
    await expect(createDraft({
      tenantId: T, title: 'T', summary: 's', outcome: 'o', durationDays: 2, activities: ACT,
      translationOf: { challengeId: sourceId, version: 1 },
    })).rejects.toSatisfy(refusedWith(/must declare its `contentLocale`/));
    await expect(createDraft({
      tenantId: T, title: 'T', summary: 's', outcome: 'o', durationDays: 2, activities: ACT, contentLocale: 'not a locale',
    })).rejects.toSatisfy(refusedWith(/BCP-47/));

    // A valid translation, then a translation OF that translation — refused.
    const ptId = await publish(T, 'Fonte', { contentLocale: 'pt-BR', translationOf: { challengeId: sourceId, version: 1 } });
    await expect(createDraft({
      tenantId: T, title: 'T2', summary: 's', outcome: 'o', durationDays: 2, activities: ACT,
      contentLocale: 'es', translationOf: { challengeId: ptId, version: 1 },
    })).rejects.toSatisfy(refusedWith(/may not point at another translation/));
  });

});

describe('source contentHash stability (tripwire)', () => {
  // HONEST CEILING (w41 probe w41g3-cl-hash: vacuous). A translation is its OWN
  // row and nothing in the localization path writes the source, and
  // `challengeContentHash` is a pure function of the source's own body — so no
  // edit to today's code makes this fail. It stays as a tripwire for a future
  // change that folds lineage into the source row or its hash, which would
  // desync every enrollment's stamped `challengeContentHash`.
  it('localization does NOT change the source contentHash (enrollments stamp it)', async () => {
    const sourceId = await publish(T, 'Hashed');
    const before = (await getChallenge(T, sourceId, 1))!.contentHash;
    await publish(T, 'Hashed pt', { contentLocale: 'pt-BR', translationOf: { challengeId: sourceId, version: 1 } });
    expect((await getChallenge(T, sourceId, 1))!.contentHash).toBe(before);
  });

  // What the tripwire above leans on, pinned directly: the stamped hash is the PURE
  // hash of the published body, so it can be recomputed and re-verified later (the
  // `contentLocale` comment in types.ts reasons about freshly computed hashes agreeing
  // with stamped ones). Witness: w41g3-cl-hash (a per-publish salt in the stamp).
  it('the published contentHash is recomputable from the published body', async () => {
    const sourceId = await publish(T, 'Recomputable');
    const row = (await getChallenge(T, sourceId, 1))!;
    expect(row.contentHash).toBe(challengeContentHash(row));
  });
});

describe('content-locale negotiation (P2)', () => {
  it('is a pure exact → same-language → source fallback', () => {
    const en = { contentLocale: undefined, translationOf: undefined };            // legacy row ⇒ 'en'
    const pt = { contentLocale: 'pt-BR', translationOf: { challengeId: 'x', version: 1 } };
    expect(contentLocaleOf(en)).toBe('en');
    // The translation is listed FIRST, so "the source" must be found, not defaulted to lineage[0].
    expect(negotiateLocale([pt, en], 'pt-BR')).toMatchObject({ exact: true, servedLocale: 'pt-BR' });
    expect(negotiateLocale([pt, en], 'pt-PT')!.row).toBe(pt);      // same language
    expect(negotiateLocale([pt, en], 'pt-PT')!.exact).toBe(false); // …but disclosed as a fallback
    expect(negotiateLocale([pt, en], 'de')!.row).toBe(en);         // falls back to the SOURCE
    expect(negotiateLocale([], 'en')).toBeNull();
  });

  it('Discover returns ONE row per lineage with the served locale disclosed', async () => {
    const sourceId = await publish(T, 'Sleep');
    await publish(T, 'Sono', { contentLocale: 'pt-BR', translationOf: { challengeId: sourceId, version: 1 } });
    await publish(T, 'Standalone');

    const pt = await listPublishedForLocale(T, 'pt-BR');
    expect(pt).toHaveLength(2);                                   // 2 lineages, not 3 rows
    const sleep = pt.find((c) => c.challenge.translationOf)!;
    expect(sleep.servedLocale).toBe('pt-BR');
    expect(sleep.exactLocale).toBe(true);

    const de = await listPublishedForLocale(T, 'de');
    expect(de.every((c) => c.exactLocale === false)).toBe(true);   // honest fallback, not an empty catalog
    expect(de.find((c) => c.challenge.id === sourceId)).toBeTruthy();
  });
});

describe('retirement cascade (P3)', () => {
  it('retiring a SOURCE retires its translations; retiring a translation does not touch the source', async () => {
    const sourceId = await publish(T, 'Cascade');
    const ptId = await publish(T, 'Cascata', { contentLocale: 'pt-BR', translationOf: { challengeId: sourceId, version: 1 } });

    // Down-only: retiring the translation through the LINEAGE entry retires just it.
    // DOUBLE GUARD (w41 probe w41g3-cl-lineage-down-r2: vacuous): `retireLineage`'s
    // early return for a translation is a shortcut — without it the child scan finds
    // nothing, because a translation can never HAVE translations (validateLineage
    // refuses translation-of-translation at createDraft; witnessed by cl-chained).
    // Retirement never walks up, so the source stays published either way.
    expect(await retireLineage(T, ptId, 1)).toBe(1);
    expect((await getChallenge(T, ptId, 1))!.status).toBe('retired');
    expect((await getChallenge(T, sourceId, 1))!.status).toBe('published');

    const sourceId2 = await publish(T, 'Cascade2');
    const pt2 = await publish(T, 'Cascata2', { contentLocale: 'pt-BR', translationOf: { challengeId: sourceId2, version: 1 } });
    expect(await retireLineage(T, sourceId2, 1)).toBe(2);
    expect((await getChallenge(T, pt2, 1))!.status).toBe('retired');
  });

  // Grade-data KTCORE-D1 — the authoring retire route and the Factory kill switch call
  // `retireChallenge`, not `retireLineage`; the cascade must hold on THAT entry too, or
  // a challenge withdrawn for safety stays enrollable in every other locale.
  it('retireChallenge on a SOURCE cascades to its translations', async () => {
    const sourceId = await publish(T, 'Cascade3');
    const pt = await publish(T, 'Cascata3', { contentLocale: 'pt-BR', translationOf: { challengeId: sourceId, version: 1 } });
    const es = await publish(T, 'Cascada3', { contentLocale: 'es', translationOf: { challengeId: sourceId, version: 1 } });

    expect((await retireChallenge(T, sourceId, 1))!.status).toBe('retired');
    expect((await getChallenge(T, pt, 1))!.status).toBe('retired');
    expect((await getChallenge(T, es, 1))!.status).toBe('retired');
    expect((await listPublishedForLocale(T, 'pt-BR')).some((c) => c.challenge.id === pt)).toBe(false);

    // Re-retiring an already-retired source still walks its lineage (idempotent), which
    // is the repair for translations stranded published before this fix.
    expect((await retireChallenge(T, sourceId, 1))!.status).toBe('retired');
  });
});
