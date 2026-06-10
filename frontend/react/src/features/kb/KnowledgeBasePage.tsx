/**
 * Knowledge Base / RAG (host-extension product feature — ADR 0011).
 *
 * Gates on useFeatureAccess('kb'). An org picker drives a collection list; a
 * selected collection shows a semantic-search box (ranked chunks with scores +
 * citations) and an ingest form (paste text — the Media-asset-token source is
 * API-supported too). Retrieval rides the host vector store + the deterministic
 * embedder; grounded answers are a workflow step, so the UI surfaces retrieval.
 */
import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { BoxesIcon, DatabaseIcon, LockIcon, PlusIcon, SearchIcon, TrashIcon } from '../../ui/icons/index.js';
import {
  createCollection,
  deleteCollection,
  deleteDocument,
  ingestText,
  listCollections,
  listDocuments,
  listOrgs,
  search,
  type KbCollection,
  type KbDocument,
  type Org,
  type SearchHit,
} from './kbClient.js';


export function KnowledgeBasePage(): JSX.Element {
  const access = useFeatureAccess('kb');
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [collections, setCollections] = useState<KbCollection[] | null>(null);
  const [selected, setSelected] = useState<KbCollection | null>(null);
  const [docs, setDocs] = useState<KbDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [docTitle, setDocTitle] = useState('');
  const [docText, setDocText] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!access.enabled) return;
    void listOrgs().then((o) => { setOrgs(o); setOrgId((cur) => cur || (o[0]?.orgId ?? '')); }).catch(() => setOrgs([]));
  }, [access.enabled]);

  const loadCollections = useCallback((org: string) => {
    void listCollections(org).then(setCollections).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load collections.'));
  }, []);

  useEffect(() => { if (orgId) { setSelected(null); setDocs(null); setHits(null); loadCollections(orgId); } }, [orgId, loadCollections]);

  const openCollection = useCallback((c: KbCollection) => {
    setSelected(c); setHits(null); setDocs(null);
    void listDocuments(orgId, c.collectionId).then(setDocs).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load documents.'));
  }, [orgId]);

  const create = useCallback(async () => {
    if (!newName.trim()) return;
    setBusy(true);
    try { await createCollection(orgId, newName.trim()); setNewName(''); loadCollections(orgId); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Create failed.'); }
    finally { setBusy(false); }
  }, [orgId, newName, loadCollections]);

  const removeCollection = useCallback(async (collectionId: string) => {
    try { await deleteCollection(orgId, collectionId); if (selected?.collectionId === collectionId) { setSelected(null); setDocs(null); setHits(null); } loadCollections(orgId); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Delete failed.'); }
  }, [orgId, selected, loadCollections]);

  const ingest = useCallback(async () => {
    if (!selected || !docText.trim()) return;
    setBusy(true);
    try {
      await ingestText(orgId, selected.collectionId, docTitle.trim() || 'Untitled', docText.trim());
      setDocTitle(''); setDocText('');
      openCollection(selected);
      loadCollections(orgId);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Ingest failed.'); }
    finally { setBusy(false); }
  }, [orgId, selected, docTitle, docText, openCollection, loadCollections]);

  const removeDoc = useCallback(async (documentId: string) => {
    if (!selected) return;
    try { await deleteDocument(orgId, selected.collectionId, documentId); openCollection(selected); loadCollections(orgId); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Delete failed.'); }
  }, [orgId, selected, openCollection, loadCollections]);

  const runSearch = useCallback(async () => {
    if (!selected || !query.trim()) return;
    setBusy(true);
    try { setHits(await search(orgId, selected.collectionId, query.trim())); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Search failed.'); }
    finally { setBusy(false); }
  }, [orgId, selected, query]);

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title="Knowledge Base is not enabled" body="Ask an administrator to enable the Knowledge Base feature for this tenant." />;
  }

  const orgPicker = orgs && orgs.length > 0 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label="Organization">
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : undefined;

  return (
    <div>
      <PageHeader eyebrow="Platform" title="Knowledge Base" lede="Org document collections with semantic search + citations (RAG)." actions={orgPicker} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {!orgs ? <Skeleton /> : orgs.length === 0 ? (
        <StateCard icon={<BoxesIcon />} title="No organizations" body="Create an organization first — collections belong to an org." />
      ) : (
        <div className="kbase-layout">
          {/* Collection list */}
          <div className="surface-card u-gap-2">
            <strong>Collections</strong>
            {!collections ? <Skeleton /> : collections.length === 0 ? <span className="u-label-sm">No collections yet.</span> : collections.map((c) => (
              <div key={c.collectionId} className="u-flex u-gap-1 u-items-center">
                <button type="button" className={`${selected?.collectionId === c.collectionId ? 'btn-primary' : 'btn-ghost'} u-justify-start u-flex-1`} onClick={() => openCollection(c)}>
                  {c.name}
                </button>
                <span className="chip" title="documents">{c.documentCount}</span>
                <button type="button" className="btn-ghost" title="Delete collection" aria-label="Delete collection" onClick={() => void removeCollection(c.collectionId)}><TrashIcon /></button>
              </div>
            ))}
            <div className="u-flex u-gap-1 u-mt-2">
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New collection" />
              <button type="button" className="btn-ghost" disabled={busy || !newName.trim()} aria-label="Create collection" onClick={() => void create()}><PlusIcon /></button>
            </div>
          </div>

          {/* Selected collection */}
          {!selected ? (
            <StateCard icon={<DatabaseIcon />} title="Select a collection" body="Pick a collection on the left, or create one — then add documents and search." />
          ) : (
            <div className="u-grid u-gap-4">
              {/* Search */}
              <div className="surface-card u-gap-3">
                <strong>Search “{selected.name}”</strong>
                <div className="u-flex u-gap-1">
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Ask a question…" className="u-flex-1"
                    onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }} />
                  <button type="button" className="btn-primary" disabled={busy || !query.trim()} onClick={() => void runSearch()}><SearchIcon /> Search</button>
                </div>
                {hits === null ? null : hits.length === 0 ? (
                  <span className="u-label-sm">No matches — add documents, or try a different question.</span>
                ) : (
                  <div className="u-grid u-gap-2">
                    {hits.map((h) => (
                      <div key={h.chunkId} className="surface-inset kbase-hit">
                        <div className="u-flex u-gap-2 u-items-center">
                          <strong className="kbase-hit-title">{h.title}</strong>
                          <span className="chip" title="cosine score">{(h.score ?? 0).toFixed(3)}</span>
                        </div>
                        <span className="kbase-hit-text">{h.text}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Ingest */}
              <div className="surface-card u-gap-2">
                <strong>Add a document</strong>
                <input value={docTitle} onChange={(e) => setDocTitle(e.target.value)} placeholder="Title (optional)" />
                <textarea value={docText} onChange={(e) => setDocText(e.target.value)} placeholder="Paste text to chunk + embed into this collection…" rows={5} />
                <div className="u-flex u-justify-end">
                  <button type="button" className="btn-primary" disabled={busy || !docText.trim()} onClick={() => void ingest()}><PlusIcon /> Ingest</button>
                </div>
              </div>

              {/* Documents */}
              <div className="surface-card u-gap-1">
                <strong>Documents</strong>
                {!docs ? <Skeleton /> : docs.length === 0 ? <span className="u-label-sm">No documents yet.</span> : docs.map((d) => (
                  <div key={d.documentId} className="u-flex u-gap-2 u-items-center">
                    <span className="u-flex-1">{d.title}</span>
                    <span className="chip" title="chunks">{d.chunkCount} chunks</span>
                    <span className="u-label-sm">{d.source.kind}</span>
                    <button type="button" className="btn-ghost" title="Delete document" aria-label="Delete document" onClick={() => void removeDoc(d.documentId)}><TrashIcon /></button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
