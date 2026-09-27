/**
 * KB-3 — the ADR 0464 eraser + ADR 0077 retention purger KB never had, and the
 * DERIVED artifacts they must reach.
 *
 * The exemption that stood in for coverage ("kb is deliberately NOT in scope… not
 * data-subject PII") was written when ingest meant pasted text. KB now ingests
 * uploaded PDF/DOCX/Office, image OCR and audio transcripts through a live
 * provider, fetched URLs, whole media collections, and scheduled Drive/OneDrive
 * folders. And the erasure-coverage ratchet could not see any of it, because its
 * matcher bound `userId`/`subjectKey`/`subjectId`/`contactId`/email while KB rows
 * carry only `createdBy` (widened in `subject-erasure-feature-stores.test.ts`).
 *
 * ADR 0643 R3 review (Blocker 1) — this file has NO `boundSubject` fixture, which is
 * why it stayed green while the eraser silently SKIPPED every project/notebook-bound
 * collection (an omitted KBC-1 caller is refused). The bound-collection legs — on
 * `eraseSubjectKb` and through the real ADR 0464 `eraseSubject` fan-out — live in
 * `kb-subject-gate-doors.test.ts`, because a collection is only really bound once the
 * project access resolver is registered, i.e. on the booted app.
 *
 * The point these tests make, that a document-row delete would not: erasure has to
 * reach the DERIVATIVES. A deleted document whose chunk vectors survive is still
 * retrievable, and a purged vector whose per-chunk CACHE row survives is
 * re-assemblable without the provider ever being called again.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces, buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence, DurableCollection, hostExtStorage } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { isPiiField } from '../src/host/dataClassification.js';
import {
  ERASED_ACTOR,
  _holdUpsertInFlightForTest,
  _kbUpsertsInFlightForTest,
  collectionNamespace,
  createCollection,
  deleteDocument,
  eraseSubjectKb,
  getDocument,
  ingestDocument,
  listCollections,
  purgeOrphanKbDerivedRows,
  upsertDocument,
} from '../src/features/kb/kbService.js';

const SUBJECT = 'user:leaver-9001';
const OTHER = 'user:stays-2';
const ORG = 'org-a';

describe('KB-3 — subject erasure reaches the document AND its derivatives', () => {
  beforeAll(async () => {
    initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kberase-')) });
    initHostExtPersistence(await openStorage('memory://'));
  });

  it('declares its subject-identifier fields as PII', () => {
    expect(isPiiField('kb.document', 'createdBy')).toBe(true);
    expect(isPiiField('kb.collection', 'createdBy')).toBe(true);
    expect(isPiiField('kb.collection', 'updatedBy')).toBe(true);
  });

  it('a SUBJECT-KEYED document is deleted, and its vectors go with it', async () => {
    const tenantId = `kberase-${Date.now()}`;
    const col = await createCollection(tenantId, ORG, SUBJECT, { name: 'People' });
    await ingestDocument(tenantId, ORG, SUBJECT, col.collectionId, {
      title: 'Profile', text: 'Leaver 9001 personal dossier, home reference LMN-3321.',
    }, { documentId: `profile:${SUBJECT}` });

    const ns = collectionNamespace({ collectionId: col.collectionId, orgId: ORG } as never);
    const vector = buildHostSurfaceBundle({ tenantId }).db.vector;
    const seeded = await vector.query({ namespace: ns, vector: new Array(256).fill(0.01), topK: 50 });
    expect((seeded.matches as unknown[]).length, 'non-vacuity: the vectors must exist first').toBeGreaterThan(0);

    const result = await eraseSubjectKb(tenantId, SUBJECT);
    expect(result.documentsDeleted).toBe(1);

    expect(await getDocument(tenantId, ORG, col.collectionId, `profile:${SUBJECT}`)).toBeNull();
    const after = await vector.query({ namespace: ns, vector: new Array(256).fill(0.01), topK: 50 });
    const texts = (after.matches as Array<{ metadata?: { text?: string } }>).map((m) => m.metadata?.text ?? '').join(' ');
    expect(texts, 'a deleted document whose embedding survives is still retrievable').not.toContain('LMN-3321');
  });

  it('ORG knowledge is RETAINED with the attribution anonymized (not destroyed)', async () => {
    // The same anonymize-don't-delete decision features/crm/erasure.ts records: a
    // company policy document does not stop being the company's because the person
    // who uploaded it left. Asserted explicitly so the decision is visible rather
    // than inferred from an absence.
    const tenantId = `kberase-keep-${Date.now()}`;
    const col = await createCollection(tenantId, ORG, SUBJECT, { name: 'Policies' });
    const doc = await ingestDocument(tenantId, ORG, SUBJECT, col.collectionId, { title: 'Expenses policy', text: 'Receipts within 30 days.' });

    const result = await eraseSubjectKb(tenantId, SUBJECT);
    expect(result.documentsDeleted).toBe(0);
    expect(result.attributionsAnonymized).toBeGreaterThanOrEqual(2); // the doc and the collection

    const kept = await getDocument(tenantId, ORG, col.collectionId, doc.documentId);
    expect(kept, 'the org keeps its knowledge').not.toBeNull();
    expect(kept!.text).toContain('Receipts within 30 days');
    expect(kept!.createdBy, 'but not the erased subject\'s id').toBe(ERASED_ACTOR);
    const cols = await listCollections(tenantId, ORG);
    expect(cols[0]!.createdBy).toBe(ERASED_ACTOR);
    expect(cols[0]!.updatedBy).toBe(ERASED_ACTOR);
  });

  it('another subject\'s attribution is untouched (the erasure is scoped)', async () => {
    const tenantId = `kberase-scope-${Date.now()}`;
    const col = await createCollection(tenantId, ORG, OTHER, { name: 'Policies' });
    const doc = await ingestDocument(tenantId, ORG, OTHER, col.collectionId, { title: 'Travel', text: 'Book early.' });
    await eraseSubjectKb(tenantId, SUBJECT);
    expect((await getDocument(tenantId, ORG, col.collectionId, doc.documentId))!.createdBy).toBe(OTHER);
  });

  it('a falsy tenant or subject is fail-closed (never a wildcard erase)', async () => {
    expect(await eraseSubjectKb('', SUBJECT)).toEqual({ documentsDeleted: 0, attributionsAnonymized: 0 });
    expect(await eraseSubjectKb('t', '')).toEqual({ documentsDeleted: 0, attributionsAnonymized: 0 });
  });

  it('KB-4 R2: erasure during the MIGRATION WINDOW reaches the pre-org namespace too', async () => {
    // THE DEFECT. `gcLegacyNamespace` was called only from `doHydrate`, which enumerates
    // from CURRENTLY-LIVE documents. So a tenant whose collection had vectors under the
    // pre-KB-1 namespace (the bare `collectionId`) and who ERASED before that collection
    // was next searched left those rows — carrying the subject's full chunk text in
    // `metadata` — unreachable by any later rebuild. `eraseSubjectKb` reported a COMPLETE
    // erasure over surviving content: the exact failure ADR 0581 names as its rationale.
    const tenantId = `kberase-legacy-${Date.now()}`;
    const col = await createCollection(tenantId, ORG, SUBJECT, { name: 'People' });
    const SECRET = 'Leaver 9001 dossier, legacy-namespace reference PQR-8814.';
    const doc = await ingestDocument(tenantId, ORG, SUBJECT, col.collectionId, { title: 'Profile', text: SECRET }, { documentId: `profile:${SUBJECT}` });

    // Plant the residue a pre-deploy write left behind: the SAME chunk ids under the
    // pre-org namespace, which is the bare collectionId (no org, no signature).
    const legacyNs = col.collectionId;
    const vector = buildHostSurfaceBundle({ tenantId }).db.vector;
    await vector.upsert({
      namespace: legacyNs,
      items: [{ id: `${doc.documentId}:0`, vector: new Array(256).fill(0.02), metadata: { documentId: doc.documentId, chunkIndex: 0, title: 'Profile', text: SECRET, contentTrust: 'trusted', headingPath: [] } }],
    });
    const planted = await vector.query({ namespace: legacyNs, vector: new Array(256).fill(0.02), topK: 50 });
    expect((planted.matches as unknown[]).length, 'non-vacuity: the legacy residue must exist first').toBeGreaterThan(0);

    const result = await eraseSubjectKb(tenantId, SUBJECT);
    expect(result.documentsDeleted).toBe(1);

    const after = await vector.query({ namespace: legacyNs, vector: new Array(256).fill(0.02), topK: 50 });
    const texts = (after.matches as Array<{ metadata?: { text?: string } }>).map((m) => m.metadata?.text ?? '').join(' ');
    expect(texts, 'the erased subject\'s chunk text survived in the pre-org namespace').not.toContain('PQR-8814');
    expect(after.matches as unknown[]).toEqual([]);
  });

  it('KB-4 R2: deleting a COLLECTION reclaims its pre-org namespace too', async () => {
    // Same window, the other delete path. `deleteCollection` targeted only the new
    // namespace, so a collection dropped before its first post-deploy search left its
    // whole legacy corpus with nothing left in the system able to name it.
    const { deleteCollection } = await import('../src/features/kb/kbService.js');
    const tenantId = `kberase-legacy-col-${Date.now()}`;
    const col = await createCollection(tenantId, ORG, 'actor', { name: 'Docs' });
    const SECRET = 'Collection-scope residue token STU-4417.';
    const doc = await ingestDocument(tenantId, ORG, 'actor', col.collectionId, { title: 'Doc', text: SECRET });
    const vector = buildHostSurfaceBundle({ tenantId }).db.vector;
    await vector.upsert({
      namespace: col.collectionId,
      items: [{ id: `${doc.documentId}:0`, vector: new Array(256).fill(0.02), metadata: { documentId: doc.documentId, chunkIndex: 0, title: 'Doc', text: SECRET, contentTrust: 'trusted', headingPath: [] } }],
    });
    expect(((await vector.query({ namespace: col.collectionId, vector: new Array(256).fill(0.02), topK: 50 })).matches as unknown[]).length).toBeGreaterThan(0);

    await deleteCollection(tenantId, ORG, col.collectionId);

    const after = await vector.query({ namespace: col.collectionId, vector: new Array(256).fill(0.02), topK: 50 });
    expect(after.matches as unknown[]).toEqual([]);
  });

  it('KB-4 R2: a plain document delete reclaims the pre-org namespace (the shared core)', async () => {
    const tenantId = `kberase-legacy-doc-${Date.now()}`;
    const col = await createCollection(tenantId, ORG, 'actor', { name: 'Docs' });
    const SECRET = 'Document-scope residue token VWX-2298.';
    const doc = await ingestDocument(tenantId, ORG, 'actor', col.collectionId, { title: 'Doc', text: SECRET });
    const vector = buildHostSurfaceBundle({ tenantId }).db.vector;
    await vector.upsert({
      namespace: col.collectionId,
      items: [{ id: `${doc.documentId}:0`, vector: new Array(256).fill(0.02), metadata: { documentId: doc.documentId, chunkIndex: 0, title: 'Doc', text: SECRET, contentTrust: 'trusted', headingPath: [] } }],
    });
    await deleteDocument(tenantId, ORG, col.collectionId, doc.documentId);
    const after = await vector.query({ namespace: col.collectionId, vector: new Array(256).fill(0.02), topK: 50 });
    expect(after.matches as unknown[]).toEqual([]);
  });
});

describe('KB-3 — the retention purger reclaims DERIVED residue, never live knowledge', () => {
  beforeAll(async () => {
    initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kbpurge-')) });
    initHostExtPersistence(await openStorage('memory://'));
  });

  const cutoffIso = new Date(Date.UTC(2026, 0, 1)).toISOString();

  it('orphaned vector-cache and revision rows are purged; live ones are not', async () => {
    const tenantId = `kbpurge-${Date.now()}`;
    const col = await createCollection(tenantId, ORG, 'actor', { name: 'Docs' });
    const live = await ingestDocument(tenantId, ORG, 'actor', col.collectionId, { title: 'Live', text: 'Still here.' });

    // Seed derived rows for BOTH a live document and a vanished one, through the
    // real collections the service uses (no cast, no private reach-in).
    const vecCache = new DurableCollection<{ key: string; tenantId: string; model: string; textHash: string; vector: number[] }>('kb:veccache', (r) => r.key);
    const docRev = new DurableCollection<{ key: string; tenantId: string; documentId: string; revision: number; textHash: string; title: string; changedAt: string }>('kb:docrev', (r) => r.key);
    await vecCache.put({ key: `${tenantId}:ghost-doc:0`, tenantId, model: 'm', textHash: 'h', vector: [0.1] });
    await vecCache.put({ key: `${tenantId}:${live.documentId}:0`, tenantId, model: 'm', textHash: 'h', vector: [0.1] });
    await docRev.put({ key: `${tenantId}:ghost-doc:000001`, tenantId, documentId: 'ghost-doc', revision: 1, textHash: 'h', title: 'Terminated employee letter', changedAt: new Date(Date.UTC(2020, 0, 1)).toISOString() });
    await docRev.put({ key: `${tenantId}:${live.documentId}:000001`, tenantId, documentId: live.documentId, revision: 1, textHash: 'h', title: 'Live', changedAt: new Date(Date.UTC(2020, 0, 1)).toISOString() });

    const purged = await purgeOrphanKbDerivedRows(tenantId, cutoffIso);
    expect(purged).toBe(2); // the two ghost rows, and only those

    const storage = hostExtStorage();
    expect(await storage.kvGet(`hostext:kb:veccache:${tenantId}:ghost-doc:0`)).toBeNull();
    expect(await storage.kvGet(`hostext:kb:docrev:${tenantId}:ghost-doc:000001`)).toBeNull();
    // The live document's derived rows survive — a purger that reclaimed those would
    // silently re-bill the next hydrate and destroy the revision log.
    expect(await storage.kvGet(`hostext:kb:veccache:${tenantId}:${live.documentId}:0`)).not.toBeNull();
    expect(await storage.kvGet(`hostext:kb:docrev:${tenantId}:${live.documentId}:000001`)).not.toBeNull();
    // And the DOCUMENT itself is untouched: KB content has no age semantics.
    expect(await getDocument(tenantId, ORG, col.collectionId, live.documentId)).not.toBeNull();
  });

  it('a falsy tenant is fail-closed (never a global purge)', async () => {
    expect(await purgeOrphanKbDerivedRows('', cutoffIso)).toBe(0);
  });

  it('KB-7: a colon-bearing SIBLING tenant is not swept by the prefix scan', async () => {
    // Tenant ids in this host are colon-bearing (`ws:…`, `anon:…`, `org:…`), so
    // `listByPrefix('kbpfx:')` also returns every row of `kbpfx:sub`. The `live` set was
    // already re-checked against `row.tenantId`; the two DELETE loops were not — which is
    // the direction that loses data. Every sibling scan in kbService carries the same
    // belt-and-braces guard for exactly this reason.
    const victim = `kbpfx-${Date.now()}:sub`;
    const attacker = victim.slice(0, victim.indexOf(':sub'));
    const col = await createCollection(victim, ORG, 'actor', { name: 'Docs' });
    const live = await ingestDocument(victim, ORG, 'actor', col.collectionId, { title: 'Live', text: 'Still here.' });

    const vecCache = new DurableCollection<{ key: string; tenantId: string; model: string; textHash: string; vector: number[] }>('kb:veccache', (r) => r.key);
    const docRev = new DurableCollection<{ key: string; tenantId: string; documentId: string; revision: number; textHash: string; title: string; changedAt: string }>('kb:docrev', (r) => r.key);
    await vecCache.put({ key: `${victim}:${live.documentId}:0`, tenantId: victim, model: 'm', textHash: 'h', vector: [0.1] });
    await docRev.put({ key: `${victim}:${live.documentId}:000001`, tenantId: victim, documentId: live.documentId, revision: 1, textHash: 'h', title: 'Live', changedAt: new Date(Date.UTC(2020, 0, 1)).toISOString() });

    const storage = hostExtStorage();
    // Non-vacuity: the prefix scan really does reach across the boundary, so the guard
    // is the only thing standing between the sweep and another tenant's rows.
    expect(`${victim}:${live.documentId}:0`.startsWith(`${attacker}:`)).toBe(true);

    // The sibling tenant owns no documents at all, so without the guard every one of
    // the victim's rows reads as an orphan.
    const purged = await purgeOrphanKbDerivedRows(attacker, cutoffIso);
    expect(purged, 'the sibling tenant owns nothing to reclaim').toBe(0);
    expect(await storage.kvGet(`hostext:kb:veccache:${victim}:${live.documentId}:0`)).not.toBeNull();
    expect(await storage.kvGet(`hostext:kb:docrev:${victim}:${live.documentId}:000001`)).not.toBeNull();
  });

  it('KB-8: a sweep during an in-flight upsert does not reclaim the doc\'s cache rows', async () => {
    // `upsertDocument` is a delete-then-re-ingest. Between the two the document row is
    // GONE, which to an orphan scan is indistinguishable from "deleted" — so a sweep
    // landing in that window reclaimed every cache row and the next hydrate re-embedded
    // the whole document at provider cost, the outcome the purger's docblock claims to
    // avoid. The marker is asserted with the hold seam rather than by racing microtasks
    // against a real upsert, so the window is deterministic; the WIRING of the marker
    // into `upsertDocument` is the separate assertion below.
    const tenantId = `kbpurge-inflight-${Date.now()}`;
    const col = await createCollection(tenantId, ORG, 'actor', { name: 'Docs' });
    const doc = await ingestDocument(tenantId, ORG, 'actor', col.collectionId, { title: 'Live', text: 'Still here.' });
    const vecCache = new DurableCollection<{ key: string; tenantId: string; model: string; textHash: string; vector: number[] }>('kb:veccache', (r) => r.key);
    const cacheKey = `${tenantId}:${doc.documentId}:0`;
    await vecCache.put({ key: cacheKey, tenantId, model: 'm', textHash: 'h', vector: [0.1] });

    // Reproduce the window: the document row absent while its cache rows are not.
    await hostExtStorage().kvDelete(`hostext:kb:document:${tenantId}:${ORG}:${doc.documentId}`);

    const held = await _holdUpsertInFlightForTest(tenantId, doc.documentId, async () => purgeOrphanKbDerivedRows(tenantId, cutoffIso));
    expect(held, 'an in-flight replace is not an orphan').toBe(0);
    expect(await hostExtStorage().kvGet(`hostext:kb:veccache:${cacheKey}`)).not.toBeNull();

    // NON-VACUITY: the same row, the same purge, WITHOUT the marker — reclaimed. Without
    // this the assertion above would also pass against a purger that never ran.
    expect(await purgeOrphanKbDerivedRows(tenantId, cutoffIso)).toBe(1);
    expect(await hostExtStorage().kvGet(`hostext:kb:veccache:${cacheKey}`)).toBeNull();
  });

  it('KB-8: `upsertDocument` actually TAKES the marker, and releases it', async () => {
    // The wiring half. A guard the purger honours but nothing ever sets would be a
    // no-op dressed as a fix, so the marker is observed while a real upsert is mid-flight.
    const tenantId = `kbpurge-wiring-${Date.now()}`;
    const col = await createCollection(tenantId, ORG, 'actor', { name: 'Docs' });
    await upsertDocument(tenantId, ORG, col.collectionId, 'stable-1', 'actor', { title: 'v1', text: 'first revision text' });

    const key = `${tenantId}:stable-1`;
    const pending = upsertDocument(tenantId, ORG, col.collectionId, 'stable-1', 'actor', { title: 'v2', text: 'second revision text' });
    let seen = false;
    for (let i = 0; i < 500 && !seen; i += 1) {
      await Promise.resolve();
      if (_kbUpsertsInFlightForTest().includes(key)) seen = true;
    }
    await pending;
    expect(seen, 'the replace window must be marked — otherwise the purger guard is dead code').toBe(true);
    expect(_kbUpsertsInFlightForTest(), 'and released once the re-ingest lands').not.toContain(key);
  });

  it('an orphaned revision NEWER than the cutoff is retained (age IS applied where a timestamp exists)', async () => {
    const tenantId = `kbpurge-age-${Date.now()}`;
    const docRev = new DurableCollection<{ key: string; tenantId: string; documentId: string; revision: number; textHash: string; title: string; changedAt: string }>('kb:docrev', (r) => r.key);
    await docRev.put({ key: `${tenantId}:ghost:000001`, tenantId, documentId: 'ghost', revision: 1, textHash: 'h', title: 'T', changedAt: new Date(Date.UTC(2026, 6, 1)).toISOString() });
    expect(await purgeOrphanKbDerivedRows(tenantId, cutoffIso)).toBe(0);
  });
});
