/**
 * ADR 0351 Phase 3 — source revisions + KB-change→kernel staleness. Pins:
 *  - a stable-id upsert with UNCHANGED content is a no-op (no revision bump,
 *    no lifecycle fire);
 *  - changed content bumps the revision, records a COMPACT docrev row (hash,
 *    not text), and fires the knowledge-lifecycle seam;
 *  - markKernelsStaleForDoc flags ONLY briefs whose kernel cites the doc
 *    (idempotent — already-stale briefs skipped).
 *
 * CORRECTED (grade-tests wave 6): a third bullet claimed "the registered handler
 * wires the two together end-to-end". The case behind it registered the TEST's own
 * handler and fired the seam — it asserted its own wiring, never the feature's
 * (`features/campaign-brief/feature.ts`'s `onKnowledgeDocumentChanged('campaign-brief', …)`,
 * which `beforeEach`'s hook reset would wipe anyway). Seam dispatch is witnessed by
 * the first case (`upsertDocument` → `fireKnowledgeDocumentChanged` → `fired`); the
 * feature's registration has NO witness and is a grade-code row, not a claim here.
 *
 * Sabotage witnesses: disabling the unchanged-content guard, dropping either fire,
 * dropping the revision-log purge, or dropping the cites/already-stale filters each
 * turn the matching case red.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { createCollection, upsertDocument, deleteDocument, listDocumentRevisions } from '../src/features/kb/kbService.js';
import {
  onKnowledgeDocumentChanged, __resetKnowledgeLifecycleHooks,
  type KnowledgeDocumentChangedEvent,
} from '../src/host/knowledgeLifecycle.js';
import { createBrief, setKernel, getBrief, markKernelsStaleForDoc, __clearBriefs } from '../src/features/campaign-brief/briefService.js';

const T = 'kbrev-tenant';
const ORG = 'o1';

beforeAll(() => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kbrev-')) });
});
beforeEach(async () => {
  initHostExtPersistence(openSqliteStorage(':memory:'));
  __resetKnowledgeLifecycleHooks();
  await __clearBriefs();
});

describe('kb document revisions (ADR 0351 P3)', () => {
  it('no-op upsert does not bump or fire; changed content bumps + records + fires', async () => {
    const fired: KnowledgeDocumentChangedEvent[] = [];
    onKnowledgeDocumentChanged('test', async (e) => { fired.push(e); });

    const col = await createCollection(T, ORG, 'u1', { name: 'C' });
    await upsertDocument(T, ORG, col.collectionId, 'doc-1', 'u1', { title: 'Spec', text: 'v1 body' });
    expect(fired).toEqual([]); // first ingest = revision 1, no change event

    await upsertDocument(T, ORG, col.collectionId, 'doc-1', 'u1', { title: 'Spec', text: 'v1 body' });
    expect(fired).toEqual([]); // unchanged content = free no-op

    await upsertDocument(T, ORG, col.collectionId, 'doc-1', 'u1', { title: 'Spec', text: 'v2 body — the spec changed' });
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ tenantId: T, documentId: 'doc-1', revision: 2 });

    const revs = await listDocumentRevisions(T, ORG, col.collectionId, 'doc-1');
    expect(revs[0]).toMatchObject({ revision: 2, title: 'Spec' });
    expect(revs[0]).not.toHaveProperty('text'); // compact — hash only
    expect(typeof revs[0]!.textHash).toBe('string');
  });

  it('user-facing delete purges the revision log and fires the seam with deleted:true (KB-CODE-10 / CS-DATA-1)', async () => {
    const fired: KnowledgeDocumentChangedEvent[] = [];
    onKnowledgeDocumentChanged('test', async (e) => { fired.push(e); });

    const col = await createCollection(T, ORG, 'u1', { name: 'Del' });
    await upsertDocument(T, ORG, col.collectionId, 'doc-d', 'u1', { title: 'S', text: 'v1 body' });
    await upsertDocument(T, ORG, col.collectionId, 'doc-d', 'u1', { title: 'S', text: 'v2 body — changed' });
    expect((await listDocumentRevisions(T, ORG, col.collectionId, 'doc-d')).map((r) => r.revision)).toEqual([2, 1]);
    fired.length = 0;

    await deleteDocument(T, ORG, col.collectionId, 'doc-d'); // the seam is AWAITED (ADR 0643 D6) — no drain needed
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ tenantId: T, documentId: 'doc-d', deleted: true }); // kernels citing it go stale

    // The revision log was PURGED, not orphaned: re-creating the same stable id
    // starts a FRESH log at revision 1 (stale rows would surface here otherwise).
    await upsertDocument(T, ORG, col.collectionId, 'doc-d', 'u1', { title: 'S', text: 'v3 body — recreated' });
    expect((await listDocumentRevisions(T, ORG, col.collectionId, 'doc-d')).map((r) => r.revision)).toEqual([1]);
  });
});

describe('kernel staleness propagation', () => {
  it('flags only citing briefs; idempotent', async () => {
    const citing = await createBrief(T, ORG, 'u1', { name: 'Cites', productName: 'X', messaging: { primaryValueProp: 'v' } });
    const other = await createBrief(T, ORG, 'u1', { name: 'Other', productName: 'X', messaging: { primaryValueProp: 'v' } });
    await setKernel(T, citing.id, { headline: 'H', supportingStatement: 'S', proofPoints: [], primaryCta: 'C', secondaryCta: '', tone: 't', channelTones: {}, sourceDocIds: ['doc-9'], generatedAt: new Date().toISOString() });
    await setKernel(T, other.id, { headline: 'H', supportingStatement: 'S', proofPoints: [], primaryCta: 'C', secondaryCta: '', tone: 't', channelTones: {}, sourceDocIds: ['doc-OTHER'], generatedAt: new Date().toISOString() });

    const affected = await markKernelsStaleForDoc(T, 'doc-9');
    expect(affected.map((b) => b.id)).toEqual([citing.id]);
    expect((await getBrief(T, citing.id))?.kernelStale).toBe(true);
    expect((await getBrief(T, other.id))?.kernelStale).toBe(false);

    // Idempotent — a second pass affects nothing new.
    expect(await markKernelsStaleForDoc(T, 'doc-9')).toEqual([]);
  });
});
