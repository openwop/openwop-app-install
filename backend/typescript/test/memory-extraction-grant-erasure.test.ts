/**
 * AGMEM-4 (ADR 0587 §3) — a DSAR must not leave a live consent grant authorising
 * future writes to the memory it just erased.
 *
 * THE DEFECT. `memextract:grant` holds a person's userId in the KEY
 * (`${tenantId}:${subject}`), in `subject` (the person whose memory may be
 * written) and in `grantedBy` (the actor). `features/memory-auto-extract/`
 * registered ZERO erasers, so `eraseSubjectMemory` destroyed the notes and left a
 * standing authorisation behind — a residue that is not merely stale but
 * ACTIVELY DANGEROUS: the next conversation re-populates the erased scope.
 *
 * It went unnoticed because the store entered NO denominator — not covered, not
 * debt, not exempt. The host gate reads `src/host/**` only; the feature-store
 * gate's matchers bound every DECORATED spelling of "subject" (`subjectKey`,
 * `subjectId`, `managerSubjectId`) and NOT the bare field name `subject`, which
 * is the spelling this whole lane standardised on. The matcher widening is a
 * separate commit (the class); this file pins the instance.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  setExtractionGrant,
  getExtractionGrant,
  isExtractionGranted,
  eraseExtractionGrants,
} from '../src/features/memory-auto-extract/grantService.js';
import { extractConversationMemory } from '../src/features/memory-auto-extract/extractionBinding.js';
import { countSubjectNotes, eraseSubjectMemory } from '../src/host/subjectMemory.js';
import { personSubject } from '../src/host/subject.js';

const T = 'grant-erase-tenant';
const T2 = 'grant-erase-other-tenant';

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-mge-')) });
  initHostExtPersistence(await openStorage('memory://'));
});

beforeEach(async () => {
  // Clear anything a previous case left behind (the store is process-global).
  for (const t of [T, T2]) for (const u of ['alice', 'bob', 'carol']) await eraseExtractionGrants(t, `user:${u}`);
});

describe('AGMEM-4 — eraseExtractionGrants', () => {
  it('THE DEFECT, end to end: erasure no longer leaves a live authorisation to re-learn', async () => {
    // ADR 0666 D1 — the GRANT is filed at the subject the binding reads (verbatim). The eraser
    // legs below deliberately keep the `user:<id>` spelling: the ERASER is form-tolerant by
    // design (`subjectKeyForms`), which is the safe direction for a destructive op, while this
    // authorizing read is exact.
    await setExtractionGrant(T, 'alice', true, 'alice');
    await extractConversationMemory(T, 'alice', 'transcript', async () => ['alice lives in Berlin']);
    expect(await countSubjectNotes(T, personSubject('alice'))).toBe(1);

    // A DSAR: the host eraser fan-out reaches BOTH the memory and the grant.
    await eraseSubjectMemory(T, 'user:alice');
    await eraseExtractionGrants(T, 'user:alice');

    expect(await countSubjectNotes(T, personSubject('alice'))).toBe(0);
    // The load-bearing assertion: without the grant eraser this was `true`, and the
    // very next conversation would have re-populated the scope the DSAR cleared.
    // Assert on the key the grant was actually FILED at ('alice' — see the D1 note above),
    // not the prefixed spelling. Asserting `'user:alice'` here would be VACUOUS after the
    // fixture correction: nothing is filed there, so it reads false whether the eraser ran or
    // not. (The leg's load-bearing assertion is the re-extraction attempt below; these two are
    // the direct ones, and they should be real too.)
    expect(await isExtractionGranted(T, 'alice')).toBe(false);
    expect(await getExtractionGrant(T, 'alice')).toBeNull();

    // …and the fix is real: a fresh extraction attempt now writes nothing.
    const r = await extractConversationMemory(T, 'alice', 'transcript', async () => ['alice lives in Berlin']);
    expect(r.skipped).toBe('no-consent');
    expect(await countSubjectNotes(T, personSubject('alice'))).toBe(0);
  });

  it('matches every spelling of the subject key (`user:<id>` and the bare id)', async () => {
    await setExtractionGrant(T, 'user:bob', true, 'bob');
    await eraseExtractionGrants(T, 'bob'); // a DSAR arriving with the BARE id
    expect(await getExtractionGrant(T, 'user:bob')).toBeNull();
  });

  it('ACTOR half: another person\'s grant is re-attributed, never deleted', async () => {
    // Symmetric-pair rule: `subject` is the topic, `grantedBy` is the actor. An
    // admin who set someone else\'s grant is erased FROM it; the grant itself is
    // not the DSAR subject\'s data to destroy.
    await setExtractionGrant(T, 'user:carol', true, 'alice');
    await eraseExtractionGrants(T, 'user:alice');
    const g = await getExtractionGrant(T, 'user:carol');
    expect(g).not.toBeNull();
    expect(g!.granted).toBe(true); // carol\'s consent survives
    expect(g!.grantedBy).toBe('erased:subject'); // alice\'s id does not
  });

  it('ANTI-ROT: it is not "delete everything" — other subjects and other tenants are untouched', async () => {
    await setExtractionGrant(T, 'user:alice', true, 'alice');
    await setExtractionGrant(T, 'user:bob', true, 'bob');
    await setExtractionGrant(T2, 'user:alice', true, 'alice');

    await eraseExtractionGrants(T, 'user:alice');

    expect(await isExtractionGranted(T, 'user:alice')).toBe(false);
    expect(await isExtractionGranted(T, 'user:bob')).toBe(true); // other subject
    expect(await isExtractionGranted(T2, 'user:alice')).toBe(true); // CTI-1: other tenant
  });

  /**
   * MECHANISM vs WIRING — the lesson that cost a live prod defect past 9605 green
   * tests. Every case above calls `eraseExtractionGrants` DIRECTLY, so all of them
   * stay green if the `registerSubjectEraser(...)` line is deleted. MEASURED: the
   * sabotage probe that removed the registration came back green over 30 tests.
   * This case drives the real `eraseSubject` fan-out instead.
   */
  it('WIRING: the host eraseSubject fan-out actually reaches this store', async () => {
    // Importing the feature is what arms the module-scope registration on the real
    // boot path (`features/index.ts` → `feature.ts` → `routes.ts` → `grantService.ts`).
    await import('../src/features/memory-auto-extract/feature.js');
    const { eraseSubject } = await import('../src/host/subjectErasure.js');

    await setExtractionGrant(T, 'user:alice', true, 'alice');
    expect(await isExtractionGranted(T, 'user:alice')).toBe(true);

    const res = await eraseSubject(T, 'user:alice');
    // Other features' erasers are transitively registered by that import and fail
    // without their own fixtures, so `res.failed` is not a usable assertion here.
    // OURS must not be among them, and the grant must actually be gone.
    expect(res.failedFeatures).not.toContain('eraseExtractionGrants');
    expect(await isExtractionGranted(T, 'user:alice')).toBe(false);
    expect(await getExtractionGrant(T, 'user:alice')).toBeNull();
  });

  it('is idempotent and fail-closed on falsy input', async () => {
    await setExtractionGrant(T, 'user:alice', true, 'alice');
    await eraseExtractionGrants(T, 'user:alice');
    await eraseExtractionGrants(T, 'user:alice');
    await eraseExtractionGrants('', 'user:alice');
    await eraseExtractionGrants(T, '');
    expect(await getExtractionGrant(T, 'user:alice')).toBeNull();
  });
});
