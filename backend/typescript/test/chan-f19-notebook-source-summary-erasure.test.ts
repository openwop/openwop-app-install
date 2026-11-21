/**
 * CHAN-F19 #8 (ADR 0464 §9) — `notebook-source-summary` holds model text derived from
 * one KB source, and it can quote the people in it.
 *
 * kb's eraser deletes the subject's OWN documents (the subject-keyed ids:
 * `<key>`, `profile:<key>`, `user:<key>`) through `deleteDocument`, which fires the
 * KB lifecycle seam; notebooks' consumer then drops that source's summary. The seam is
 * best-effort (a handler failure is logged and swallowed), so notebooks also registers
 * a strict eraser that runs after kb's and drops every summary whose source is gone.
 *
 * This boots the REAL app (the production eraser set) and erases through
 * `eraseSubject`. It pins:
 *  - S1: the summary of the subject's own document is deleted, with its level, and the
 *        summary of another document that merely mentions the subject is KEPT (kb's
 *        documented scope, the "KNOWN RESIDUAL" in `eraseSubjectKb`);
 *  - S2: with the seam consumer failing, the strict eraser still deletes it;
 *  - S3: another tenant's summary of a vanished source is untouched.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { onKnowledgeDocumentChanged } from '../src/host/knowledgeLifecycle.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { PREAUTHORIZED_CALLER } from '../src/host/subjectAccess.js';
import { ingestDocument, getDocument } from '../src/features/kb/kbService.js';
import {
  createNotebook, addSource, setSourceSummary, setSourceContextLevel, getSourceSummary, onNotebookSourceChanged,
} from '../src/features/notebooks/notebooksService.js';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  for (const id of ['notebooks', 'kb']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});

const levelStore = new DurableCollection<{ tenantId: string; notebookId: string; sourceId: string; level: string }>(
  'notebook-source-level', (r) => `${r.tenantId}:${r.notebookId}:${r.sourceId}`,
);
const summaryStore = new DurableCollection<{ tenantId: string; notebookId: string; sourceId: string; summary: string; createdAt: string }>(
  'notebook-source-summary', (r) => `${r.tenantId}:${r.notebookId}:${r.sourceId}`,
);

let n = 0;
async function fixture() {
  const tenantId = `nb-f19-${Date.now()}-${n++}`;
  const orgId = 'org-f19';
  const subject = `user:f19-subject-${n}`;
  const nb = await createNotebook(tenantId, orgId, 'actor', { name: 'Research' });
  // The subject's own record: a subject-keyed id, which kb's eraser deletes.
  const own = await ingestDocument(tenantId, orgId, 'actor', nb.collectionId,
    { title: 'Subject profile', text: 'Maria Silva leads the Lisbon office.' }, { documentId: `profile:${subject}` }, PREAUTHORIZED_CALLER);
  await setSourceSummary(tenantId, nb.id, own.documentId, 'Maria Silva leads Lisbon.');
  await setSourceContextLevel(tenantId, nb.id, own.documentId, 'summary');
  // The org's document that only mentions the subject: kb keeps it, so its summary stays.
  const org = await addSource(tenantId, nb.id, 'actor', { title: 'Q3 report', text: 'Q3 revenue grew; Maria Silva presented it.' });
  await setSourceSummary(tenantId, nb.id, org.documentId, 'Q3 grew; presented by Maria Silva.');
  return { tenantId, orgId, subject, nb, own, org };
}

describe('CHAN-F19 #8 — notebook source summaries on a DSAR', () => {
  it('S1 deletes the summary of the subject\'s own document and keeps the org document\'s', async () => {
    const f = await fixture();
    await eraseSubject(f.tenantId, f.subject);
    expect(await getDocument(f.tenantId, f.orgId, f.nb.collectionId, f.own.documentId, PREAUTHORIZED_CALLER), 'kb deleted the subject\'s document').toBeNull();
    expect(await getSourceSummary(f.tenantId, f.nb.id, f.own.documentId)).toBeNull();
    expect(await levelStore.get(`${f.tenantId}:${f.nb.id}:${f.own.documentId}`), 'its level row too').toBeNull();
    expect(await getSourceSummary(f.tenantId, f.nb.id, f.org.documentId), 'kb keeps the org document, so its summary stays').not.toBeNull();
  });

  it('S2 the strict eraser deletes it even when the seam consumer fails', async () => {
    const f = await fixture();
    onKnowledgeDocumentChanged('notebooks', async () => { throw new Error('consumer down'); });
    try {
      await eraseSubject(f.tenantId, f.subject);
    } finally {
      onKnowledgeDocumentChanged('notebooks', onNotebookSourceChanged);
    }
    expect(await getDocument(f.tenantId, f.orgId, f.nb.collectionId, f.own.documentId, PREAUTHORIZED_CALLER)).toBeNull();
    expect(await getSourceSummary(f.tenantId, f.nb.id, f.own.documentId), 'the backstop removed what the failed seam left').toBeNull();
    expect(await getSourceSummary(f.tenantId, f.nb.id, f.org.documentId)).not.toBeNull();
  });

  it('S3 another tenant\'s summary under the SAME notebook and source ids is untouched', async () => {
    const f = await fixture();
    const otherTenant = `${f.tenantId}-other`;
    // Tenant B holds a summary keyed by exactly the ids being erased in tenant A, for a
    // source tenant B does not have: only tenant scope keeps it out of this erasure.
    await summaryStore.put({ tenantId: otherTenant, notebookId: f.nb.id, sourceId: f.own.documentId, summary: 'B keeps this', createdAt: new Date().toISOString() });
    await levelStore.put({ tenantId: otherTenant, notebookId: f.nb.id, sourceId: f.own.documentId, level: 'summary' });
    await eraseSubject(f.tenantId, f.subject);
    expect(await getSourceSummary(f.tenantId, f.nb.id, f.own.documentId), 'tenant A\'s is erased').toBeNull();
    expect(await summaryStore.get(`${otherTenant}:${f.nb.id}:${f.own.documentId}`), 'tenant B\'s summary stays').not.toBeNull();
    expect(await levelStore.get(`${otherTenant}:${f.nb.id}:${f.own.documentId}`), 'and its level').not.toBeNull();
  });
});
