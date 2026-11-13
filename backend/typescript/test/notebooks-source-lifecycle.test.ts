/**
 * ADR 1103 D7/D8 — a source's derived state (its context level and its LLM summary)
 * follows the source, and a notebook's derived state goes with the notebook.
 *
 * Before: deleting a source at the KB door left its summary in the binding's
 * `extraContext` snapshot, so every grounded chat turn kept injecting text from a
 * source the user had deleted; editing it kept the old summary as current; and
 * deleting the notebook left both stores behind with no owner (`NBK92-5`, `-7`).
 *
 * Sabotage: unregistering the `notebooks` lifecycle consumer reds L1/L2/L3; dropping
 * the ghost-skip in `deriveContextProjection` reds L4; dropping its revision match
 * reds L5b; dropping the revision check in `setSourceSummary` reds L5; unregistering the `notebookSourceState` dependent reds L6.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import {
  createNotebook, addSource, setSourceSummary, setSourceContextLevel, listSources, deleteNotebook,
  countNotebookSourceState, getSourceSummary, onNotebookSourceChanged,
} from '../src/features/notebooks/notebooksService.js';
import { deleteDocument, deleteCollection, createCollection } from '../src/features/kb/kbService.js';
import { fireKnowledgeDocumentChanged, onKnowledgeDocumentChanged } from '../src/host/knowledgeLifecycle.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { getSubjectKnowledge, setSubjectKnowledge } from '../src/host/subjectKnowledge.js';
import { projectSubject, createProject, setNotebookCollectionId } from '../src/features/projects/projectsService.js';
import { PREAUTHORIZED_CALLER } from '../src/host/subjectAccess.js';
import { __swapSubjectDependentForTest } from '../src/host/subjectDependents.js';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  // createApp composes the notebooks feature, which registers the D7 lifecycle
  // consumer and the D8 project dependent — the wiring this file exercises.
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  for (const id of ['notebooks', 'kb']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});

let n = 0;
/** The summary store, opened by name (the row shape `notebooksService` writes). */
const summaryStore = new DurableCollection<{ tenantId: string; notebookId: string; sourceId: string; summary: string; createdAt: string; revision?: number }>(
  'notebook-source-summary', (r) => `${r.tenantId}:${r.notebookId}:${r.sourceId}`,
);
const SUMMARY = 'Cats groom with their tongue and purr when content.';

async function summarized() {
  const tenantId = `nb-life-${Date.now()}-${n++}`;
  const orgId = 'org-life';
  const nb = await createNotebook(tenantId, orgId, 'actor', { name: 'Pets' });
  const src = await addSource(tenantId, nb.id, 'actor', { title: 'Cat facts', text: 'Cats groom often and purr when they are content.' });
  await setSourceSummary(tenantId, nb.id, src.documentId, SUMMARY);
  await setSourceContextLevel(tenantId, nb.id, src.documentId, 'summary');
  const injected = async (): Promise<boolean> =>
    ((await getSubjectKnowledge(tenantId, projectSubject(nb.id))).retrieval?.extraContext ?? []).some((e) => e.content === SUMMARY);
  // Precondition: the summary IS in the model's context before anything changes.
  expect(await injected()).toBe(true);
  return { tenantId, orgId, nb, src, injected };
}

describe('ADR 1103 D7 — the summary follows its source', () => {
  it('L1 deleting the source at the KB door removes its summary from the chat context and its rows', async () => {
    const f = await summarized();
    await deleteDocument(f.tenantId, f.orgId, f.nb.collectionId, f.src.documentId, PREAUTHORIZED_CALLER);
    expect(await f.injected()).toBe(false);
    expect(await getSourceSummary(f.tenantId, f.nb.id, f.src.documentId)).toBeNull();
    expect(await countNotebookSourceState(f.tenantId, f.nb.id)).toBe(0);
  });

  // The revision event is fired directly: KB's only revision path (`upsertDocument`)
  // does not forward a caller to its inner ingest, so it cannot write a subject-bound
  // collection (every notebook corpus) at all today. The consumer is what D7 owns.
  it('L2 a revision event drops the stale summary and puts its level back to full', async () => {
    const f = await summarized();
    await fireKnowledgeDocumentChanged({ tenantId: f.tenantId, orgId: f.orgId, collectionId: f.nb.collectionId, documentId: f.src.documentId, title: 'Cat facts', revision: 2 });
    expect(await f.injected()).toBe(false);
    expect(await getSourceSummary(f.tenantId, f.nb.id, f.src.documentId)).toBeNull();
    const row = (await listSources(f.tenantId, f.nb.id)).find((s) => s.documentId === f.src.documentId);
    expect(row).toMatchObject({ contextLevel: 'full', hasSummary: false });
  });

  it('L3 deleting the notebook corpus at the KB door (the collection row goes first) still clears the rows', async () => {
    const f = await summarized();
    await deleteCollection(f.tenantId, f.orgId, f.nb.collectionId, PREAUTHORIZED_CALLER);
    expect(await countNotebookSourceState(f.tenantId, f.nb.id)).toBe(0);
    // …and the summary is out of the chat context, though the corpus read now 404s
    // (code re-grade #3: the recompute used to throw on it and leave the snapshot).
    expect(await f.injected()).toBe(false);
  });

  it('L4 a missed event cannot keep a ghost in the projection', async () => {
    const f = await summarized();
    // The first source's document vanishes with the consumer swapped out (a missed
    // event); a second source's level write then recomputes the projection.
    const other = await addSource(f.tenantId, f.nb.id, 'actor', { title: 'Dog facts', text: 'Dogs wag their tails.' });
    onKnowledgeDocumentChanged('notebooks', async () => undefined);
    try {
      await deleteDocument(f.tenantId, f.orgId, f.nb.collectionId, f.src.documentId, PREAUTHORIZED_CALLER);
    } finally {
      onKnowledgeDocumentChanged('notebooks', onNotebookSourceChanged);
    }
    expect(await f.injected(), 'the event was missed, so the snapshot still holds it').toBe(true);
    await setSourceContextLevel(f.tenantId, f.nb.id, other.documentId, 'excluded');
    expect(await f.injected()).toBe(false);
  });

  it('L5b a summary stored from an older revision is never injected, even if no event cleared it', async () => {
    const f = await summarized();
    // Plant the row a revision race leaves behind: a summary written from revision 0
    // of a source whose current revision is 1 (the precedent of opening a store by name).
    await summaryStore.put({ tenantId: f.tenantId, notebookId: f.nb.id, sourceId: f.src.documentId, summary: SUMMARY, createdAt: new Date().toISOString(), revision: 0 });
    expect(await f.injected(), 'the snapshot still holds it until something recomputes').toBe(true);
    const other = await addSource(f.tenantId, f.nb.id, 'actor', { title: 'Dog facts', text: 'Dogs wag their tails.' });
    await setSourceContextLevel(f.tenantId, f.nb.id, other.documentId, 'excluded');
    expect(await f.injected()).toBe(false);
    // …and the source no longer claims a summary (round-2 code re-grade #8).
    expect((await listSources(f.tenantId, f.nb.id)).find((x) => x.documentId === f.src.documentId)?.hasSummary).toBe(false);
    expect(await getSourceSummary(f.tenantId, f.nb.id, f.src.documentId)).toBeNull();
  });

  it('L7 a corpus born before collections were stamped is still followed (the project scan)', async () => {
    const tenantId = `nb-life-legacy-${Date.now()}-${n++}`;
    const orgId = 'org-legacy';
    const project = await createProject(tenantId, orgId, { name: 'Legacy' }, 'actor');
    const col = await createCollection(tenantId, orgId, 'actor', { name: 'Sources: Legacy' }); // no boundSubject
    await setSubjectKnowledge(tenantId, projectSubject(project.id), { collectionIds: [col.collectionId] });
    await setNotebookCollectionId(tenantId, project.id, col.collectionId);
    const src = await addSource(tenantId, project.id, 'actor', { title: 'Old', text: 'An old source about otters.' });
    await setSourceSummary(tenantId, project.id, src.documentId, SUMMARY);
    expect(await countNotebookSourceState(tenantId, project.id)).toBe(1);
    await deleteDocument(tenantId, orgId, col.collectionId, src.documentId, PREAUTHORIZED_CALLER);
    expect(await countNotebookSourceState(tenantId, project.id)).toBe(0);
  });

  it('L8 a collection bound to a project that is NOT its notebook corpus is a no-op', async () => {
    const f = await summarized();
    // A second corpus bound to the same project (the Knowledge tab's lane), not the notebook's own.
    const other = await createCollection(f.tenantId, f.orgId, 'actor', { name: 'Shared' }, { boundSubject: projectSubject(f.nb.id) });
    await fireKnowledgeDocumentChanged({ tenantId: f.tenantId, orgId: f.orgId, collectionId: other.collectionId, documentId: f.src.documentId, title: 'x', revision: 1, deleted: true });
    expect(await getSourceSummary(f.tenantId, f.nb.id, f.src.documentId)).toBe(SUMMARY);
    expect(await f.injected()).toBe(true);
  });

  it('L5 a summary of a revision that is not the current one is refused, not stored', async () => {
    const f = await summarized();
    await expect(setSourceSummary(f.tenantId, f.nb.id, f.src.documentId, 'A summary of other text.', { revision: 0 }))
      .rejects.toMatchObject({ code: 'conflict', details: { reason: 'source_changed' } });
    expect(await getSourceSummary(f.tenantId, f.nb.id, f.src.documentId)).toBe(SUMMARY);
    // Control: the current revision is accepted.
    await setSourceSummary(f.tenantId, f.nb.id, f.src.documentId, 'A summary of the current text.', { revision: 1 });
    expect(await getSourceSummary(f.tenantId, f.nb.id, f.src.documentId)).toBe('A summary of the current text.');
  });
});

describe('ADR 1103 D8 — the derived state goes with the notebook', () => {
  it('L6 deleting the notebook purges its levels and summaries and reports them', async () => {
    const f = await summarized();
    expect(await countNotebookSourceState(f.tenantId, f.nb.id)).toBe(2); // one level + one summary
    const res = await deleteNotebook(f.tenantId, f.nb.id);
    expect(res.deleted).toBe(true);
    expect(res.dependentsDeleted.notebookSourceState).toBe(2);
    expect(await countNotebookSourceState(f.tenantId, f.nb.id)).toBe(0);
  });

  it('L6b control: without the registration the rows survive (the witness is not vacuous)', async () => {
    const f = await summarized();
    const prev = __swapSubjectDependentForTest('project', 'notebookSourceState', undefined);
    try {
      await deleteNotebook(f.tenantId, f.nb.id);
      expect(await countNotebookSourceState(f.tenantId, f.nb.id)).toBe(2);
    } finally {
      __swapSubjectDependentForTest('project', 'notebookSourceState', prev);
    }
  });
});
