/**
 * ADR 0430 P1–P3 — challenge content localization.
 *
 *  - a translation is its OWN challenge id pointing at a PUBLISHED source in
 *    the SAME tenant; cross-tenant / unpublished / translation-of-translation
 *    / same-locale links are refused (uniform message — no existence oracle)
 *  - Discover negotiates CONTENT locale independently of the UI locale:
 *    exact → same-language → source, with the served locale disclosed
 *  - retirement cascades DOWN a lineage only
 *  - the source's contentHash is untouched by localization (the enrollment
 *    stamps it; changing hash coverage would desync stamped values)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createDraft, publishChallenge, retireChallenge, retireLineage,
  listPublishedForLocale, getChallenge, ChallengeValidationError,
} from '../src/features/kicktodo-core/challengeService.js';
import { negotiateLocale, contentLocaleOf } from '../src/features/kicktodo-core/types.js';

const T = 'tenant-locale';
const OTHER = 'tenant-locale-other';

const ACT = [{ stableActivityId: 'a1', day: 1, title: 'A', instructions: 'i', evidencePolicy: 'attestation' as const }];

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
    })).rejects.toBeInstanceOf(ChallengeValidationError);

    // Foreign tenant — refused, and with the SAME message as "missing" (no oracle).
    const foreignId = await publish(OTHER, 'Foreign');
    await expect(createDraft({
      tenantId: T, title: 'T', summary: 's', outcome: 'o', durationDays: 2, activities: ACT,
      contentLocale: 'pt-BR', translationOf: { challengeId: foreignId, version: 1 },
    })).rejects.toThrow(/published challenge version/);

    // Same locale as the source.
    await expect(createDraft({
      tenantId: T, title: 'T', summary: 's', outcome: 'o', durationDays: 2, activities: ACT,
      contentLocale: 'en', translationOf: { challengeId: sourceId, version: 1 },
    })).rejects.toBeInstanceOf(ChallengeValidationError);

    // Missing locale on a translation, and a malformed tag.
    await expect(createDraft({
      tenantId: T, title: 'T', summary: 's', outcome: 'o', durationDays: 2, activities: ACT,
      translationOf: { challengeId: sourceId, version: 1 },
    })).rejects.toBeInstanceOf(ChallengeValidationError);
    await expect(createDraft({
      tenantId: T, title: 'T', summary: 's', outcome: 'o', durationDays: 2, activities: ACT, contentLocale: 'not a locale',
    })).rejects.toBeInstanceOf(ChallengeValidationError);

    // A valid translation, then a translation OF that translation — refused.
    const ptId = await publish(T, 'Fonte', { contentLocale: 'pt-BR', translationOf: { challengeId: sourceId, version: 1 } });
    await expect(createDraft({
      tenantId: T, title: 'T2', summary: 's', outcome: 'o', durationDays: 2, activities: ACT,
      contentLocale: 'es', translationOf: { challengeId: ptId, version: 1 },
    })).rejects.toBeInstanceOf(ChallengeValidationError);
  });

  it('localization does NOT change the source contentHash (enrollments stamp it)', async () => {
    const sourceId = await publish(T, 'Hashed');
    const before = (await getChallenge(T, sourceId, 1))!.contentHash;
    await publish(T, 'Hashed pt', { contentLocale: 'pt-BR', translationOf: { challengeId: sourceId, version: 1 } });
    expect((await getChallenge(T, sourceId, 1))!.contentHash).toBe(before);
  });
});

describe('content-locale negotiation (P2)', () => {
  it('is a pure exact → same-language → source fallback', () => {
    const en = { contentLocale: undefined, translationOf: undefined };            // legacy row ⇒ 'en'
    const pt = { contentLocale: 'pt-BR', translationOf: { challengeId: 'x', version: 1 } };
    expect(contentLocaleOf(en)).toBe('en');
    expect(negotiateLocale([en, pt], 'pt-BR')!.exact).toBe(true);
    expect(negotiateLocale([en, pt], 'pt-PT')!.row).toBe(pt);      // same language
    expect(negotiateLocale([en, pt], 'pt-PT')!.exact).toBe(false); // …but disclosed as a fallback
    expect(negotiateLocale([en, pt], 'de')!.row).toBe(en);         // falls back to the SOURCE
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

    // Down-only: retire the translation alone.
    await retireChallenge(T, ptId, 1);
    expect((await getChallenge(T, sourceId, 1))!.status).toBe('published');

    const sourceId2 = await publish(T, 'Cascade2');
    const pt2 = await publish(T, 'Cascata2', { contentLocale: 'pt-BR', translationOf: { challengeId: sourceId2, version: 1 } });
    expect(await retireLineage(T, sourceId2, 1)).toBe(2);
    expect((await getChallenge(T, pt2, 1))!.status).toBe('retired');
  });
});
