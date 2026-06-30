/**
 * Knowledge Base / RAG (host-extension product feature — ADR 0011).
 *
 * Gates on useFeatureAccess('kb'). An org picker drives a collection list; a
 * selected collection shows a semantic-search box (ranked chunks with scores +
 * citations) and an ingest form (paste text — the Media-asset-token source is
 * API-supported too). Retrieval rides the host vector store + the deterministic
 * embedder; grounded answers are a workflow step, so the UI surfaces retrieval.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../../i18n/format.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { KnowledgeSyncPanel } from '../knowledge-sync/KnowledgeSyncPanel.js';
import { toast } from '../../ui/toast.js';
import { ViewToggle, useViewMode } from '../../ui/ViewToggle.js';
import { BoxesIcon, DatabaseIcon, FileTextIcon, LockIcon, PaperclipIcon, PlusIcon, SearchIcon, TrashIcon } from '../../ui/icons/index.js';
import { fileToBase64, inferContentType, KB_UPLOAD_ACCEPT, withinUploadCap, MAX_UPLOAD_MB } from '../../client/fileToBase64.js';
import {
  createCollection,
  deleteCollection,
  deleteDocument,
  ingestFile,
  ingestText,
  listCollections,
  listDocuments,
  listOrgs,
  search,
  type KbCollection,
  type KbDocument,
  type Org,
  setRetrievalMode,
  type RetrievalMode,
  type SearchHit,
} from './kbClient.js';
import { DocumentCard, DocumentRow } from './KbViews.js';


export function KnowledgeBasePage(): JSX.Element {
  const { t } = useTranslation('kb');
  const access = { enabled: true, loading: false }; // always-on (toggle removed)
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
  // Document list filter + the §4.5 grid/list collection-view canon (rule 11).
  const [docQuery, setDocQuery] = useState('');
  const [viewMode, setViewMode] = useViewMode('kb', 'grid');

  const visibleDocs = useMemo(() => {
    const q = docQuery.trim().toLowerCase();
    if (!q) return docs ?? [];
    return (docs ?? []).filter((d) => d.title.toLowerCase().includes(q));
  }, [docs, docQuery]);

  useEffect(() => {
    if (!access.enabled) return;
    // Surface a genuine load failure instead of masking it as the "no organizations"
    // empty state (review fix — they're not the same thing).
    void listOrgs().then((o) => { setOrgs(o); setOrgId((cur) => cur || (o[0]?.orgId ?? '')); })
      .catch((e) => setError(e instanceof Error ? e.message : t('loadOrgsFailed')));
  }, [access.enabled, t]);

  const loadCollections = useCallback((org: string) => {
    void listCollections(org).then(setCollections).catch((e) => setError(e instanceof Error ? e.message : t('loadCollectionsFailed')));
  }, [t]);

  useEffect(() => { if (orgId) { setSelected(null); setDocs(null); setHits(null); loadCollections(orgId); } }, [orgId, loadCollections]);

  const openCollection = useCallback((c: KbCollection) => {
    setSelected(c); setHits(null); setDocs(null); setDocQuery('');
    void listDocuments(orgId, c.collectionId).then(setDocs).catch((e) => setError(e instanceof Error ? e.message : t('loadDocumentsFailed')));
  }, [orgId, t]);

  const create = useCallback(async () => {
    if (!newName.trim()) return;
    setBusy(true);
    try { await createCollection(orgId, newName.trim()); setNewName(''); loadCollections(orgId); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('createFailed')); }
    finally { setBusy(false); }
  }, [orgId, newName, loadCollections, t]);

  const removeCollection = useCallback(async (collectionId: string) => {
    try { await deleteCollection(orgId, collectionId); if (selected?.collectionId === collectionId) { setSelected(null); setDocs(null); setHits(null); } loadCollections(orgId); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('deleteFailed')); }
  }, [orgId, selected, loadCollections, t]);

  const ingest = useCallback(async () => {
    if (!selected || !docText.trim()) return;
    setBusy(true);
    try {
      await ingestText(orgId, selected.collectionId, docTitle.trim() || t('untitled'), docText.trim());
      setDocTitle(''); setDocText('');
      openCollection(selected);
      loadCollections(orgId);
    } catch (e) { toast.error(e instanceof Error ? e.message : t('ingestFailed')); }
    finally { setBusy(false); }
  }, [orgId, selected, docTitle, docText, openCollection, loadCollections, t]);

  // Upload a file (text/PDF/DOCX) — extracted to text server-side.
  const uploadFile = useCallback(async (file: File | undefined) => {
    if (!selected || !file) return;
    if (!withinUploadCap(file)) { toast.error(t('fileTooLarge', { max: MAX_UPLOAD_MB })); return; }
    setBusy(true);
    try {
      const contentBase64 = await fileToBase64(file);
      await ingestFile(orgId, selected.collectionId, { title: file.name, contentBase64, contentType: inferContentType(file) });
      openCollection(selected);
      loadCollections(orgId);
      toast.success(t('documentAdded'));
    } catch (e) { toast.error(e instanceof Error ? e.message : t('ingestFailed')); }
    finally { setBusy(false); }
  }, [orgId, selected, openCollection, loadCollections, t]);

  const removeDoc = useCallback(async (documentId: string) => {
    if (!selected) return;
    try { await deleteDocument(orgId, selected.collectionId, documentId); openCollection(selected); loadCollections(orgId); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('deleteFailed')); }
  }, [orgId, selected, openCollection, loadCollections, t]);

  const changeRetrievalMode = useCallback(async (mode: RetrievalMode) => {
    if (!selected) return;
    try {
      const updated = await setRetrievalMode(orgId, selected.collectionId, mode);
      setSelected(updated);
      void loadCollections(orgId);
    } catch (e) { toast.error(e instanceof Error ? e.message : t('retrievalModeFailed')); }
  }, [orgId, selected, loadCollections, t]);

  const runSearch = useCallback(async () => {
    if (!selected || !query.trim()) return;
    setBusy(true);
    try { setHits(await search(orgId, selected.collectionId, query.trim())); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('searchFailed')); }
    finally { setBusy(false); }
  }, [orgId, selected, query, t]);

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title={t('disabledTitle')} body={t('disabledBody')} />;
  }

  const orgPicker = orgs && orgs.length > 0 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label={t('organizationLabel')}>
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : undefined;

  return (
    <div>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} actions={orgPicker} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {!orgs ? <Skeleton /> : orgs.length === 0 ? (
        <StateCard icon={<BoxesIcon />} title={t('noOrgsTitle')} body={t('noOrgsBody')} />
      ) : (
        <div className="kbase-layout">
          {/* Collection list */}
          <div className="surface-card u-gap-2">
            <h2 className="u-fs-16 u-m-0">{t('collectionsHeading')}</h2>
            {!collections ? <Skeleton /> : collections.length === 0 ? <span className="u-label-sm">{t('noCollections')}</span> : collections.map((c) => (
              <div key={c.collectionId} className="u-flex u-gap-1 u-items-center">
                <button type="button" className={`${selected?.collectionId === c.collectionId ? 'btn-accent' : 'btn-ghost'} u-justify-start u-flex-1`} aria-current={selected?.collectionId === c.collectionId ? 'true' : undefined} onClick={() => openCollection(c)}>
                  {c.name}
                </button>
                {c.managed ? <span className="chip chip--muted" title={t('managedTitle', { source: t(`managedSource_${c.managed}`) })}><LockIcon size={12} /> {t('managedBadge')}</span> : null}
                <span className="chip" title={t('documentsTooltip')}>{formatNumber(c.documentCount)}</span>
                {c.managed ? null : <button type="button" className="btn-ghost" title={t('deleteCollection')} aria-label={t('deleteCollection')} onClick={() => void removeCollection(c.collectionId)}><TrashIcon /></button>}
              </div>
            ))}
            <div className="u-flex u-gap-1 u-mt-2">
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('newCollectionPlaceholder')} aria-label={t('newCollectionPlaceholder')} onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} />
              <button type="button" className="btn-ghost" disabled={busy || !newName.trim()} aria-label={t('createCollection')} onClick={() => void create()}><PlusIcon /></button>
            </div>
          </div>

          {/* Selected collection */}
          {!selected ? (
            <StateCard icon={<DatabaseIcon />} title={t('selectCollectionTitle')} body={t('selectCollectionBody')} />
          ) : (
            <div className="u-grid u-gap-4">
              {/* Search */}
              <div className="surface-card u-gap-3">
                <h2 className="u-fs-16 u-m-0">{t('searchHeading', { name: selected.name })}</h2>
                <div className="u-flex u-gap-1">
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('searchPlaceholder')} className="u-flex-1"
                    onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }} />
                  <button type="button" className="btn-primary" disabled={busy || !query.trim()} onClick={() => void runSearch()}><SearchIcon /> {busy ? t('common:searching') : t('common:search')}</button>
                </div>
                {/* ADR 0113 — retrieval-mode selector (hybrid lift + local rerank). */}
                {selected.managed ? null : (
                  <label className="field u-flex u-items-center u-gap-2">
                    <span className="field-label u-m-0">{t('retrievalModeLabel')}</span>
                    <select
                      value={selected.retrievalConfig?.mode ?? 'dense'}
                      onChange={(e) => void changeRetrievalMode(e.target.value as RetrievalMode)}
                      aria-label={t('retrievalModeLabel')}
                      className="u-w-auto"
                    >
                      <option value="dense">{t('retrievalModeDense')}</option>
                      <option value="hybrid">{t('retrievalModeHybrid')}</option>
                      <option value="hybrid+rerank">{t('retrievalModeRerank')}</option>
                    </select>
                  </label>
                )}
                {hits === null ? null : hits.length === 0 ? (
                  <span className="u-label-sm">{t('noMatches')}</span>
                ) : (
                  <div className="u-grid u-gap-2">
                    {hits.map((h) => (
                      <div key={h.chunkId} className="surface-inset kbase-hit">
                        <div className="u-flex u-gap-2 u-items-center">
                          <strong className="kbase-hit-title">{h.title}</strong>
                          <span className="chip" title={t('cosineScoreTooltip')}>{formatNumber(h.score ?? 0, { minimumFractionDigits: 3, maximumFractionDigits: 3 })}</span>
                        </div>
                        <span className="kbase-hit-text">{h.text}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Ingest — suppressed for an auto-managed collection (content is synced) */}
              {selected.managed ? (
                <Notice variant="info">{t('managedNotice', { source: t(`managedSource_${selected.managed}`) })}</Notice>
              ) : (
                <div className="surface-card u-gap-2">
                  <h2 className="u-fs-16 u-m-0">{t('addDocumentHeading')}</h2>
                  <input value={docTitle} onChange={(e) => setDocTitle(e.target.value)} placeholder={t('titlePlaceholder')} />
                  <textarea value={docText} onChange={(e) => setDocText(e.target.value)} placeholder={t('ingestPlaceholder')} rows={5} />
                  <div className="u-flex u-justify-end">
                    <button type="button" className="btn-primary" disabled={busy || !docText.trim()} onClick={() => void ingest()}><PlusIcon /> {t('ingest')}</button>
                  </div>
                  <label className="field">
                    <span className="field-label"><PaperclipIcon size={14} /> {t('uploadFileLabel')}</span>
                    <input type="file" accept={KB_UPLOAD_ACCEPT} disabled={busy}
                      onChange={(e) => { void uploadFile(e.target.files?.[0]); e.target.value = ''; }} />
                    <span className="field-help">{busy ? t('uploading') : t('uploadFileHint')}</span>
                  </label>
                </div>
              )}

              {/* Documents — the §4.5 grid/list collection-view canon (rule 11) */}
              <div className="u-grid u-gap-2">
                <h2 className="u-fs-16 u-m-0">{t('documentsHeading')}</h2>
                {!docs ? (
                  <Skeleton />
                ) : docs.length === 0 ? (
                  <StateCard icon={<FileTextIcon size={20} />} title={t('noDocumentsTitle')} body={t('noDocuments')} />
                ) : (
                  <>
                    <div className="filterbar" role="group" aria-label={t('docFilterGroup')}>
                      {docs.length > 3 ? (
                        <input
                          type="search"
                          className="ui-input filterbar-search"
                          placeholder={t('docFilterPlaceholder')}
                          aria-label={t('docFilterAria')}
                          value={docQuery}
                          onChange={(e) => setDocQuery(e.target.value)}
                        />
                      ) : null}
                      <ViewToggle value={viewMode} onChange={setViewMode} className="u-ml-auto" />
                    </div>

                    {visibleDocs.length === 0 ? (
                      <StateCard
                        icon={<FileTextIcon size={20} />}
                        title={t('docNoMatchTitle')}
                        body={t('docNoMatchBody')}
                        action={<button type="button" className="secondary" onClick={() => setDocQuery('')}>{t('clearDocSearch')}</button>}
                      />
                    ) : viewMode === 'grid' ? (
                      <div className="card-grid">
                        {visibleDocs.map((d) => (
                          <DocumentCard key={d.documentId} document={d} onRemove={(id) => void removeDoc(id)} canRemove={!selected.managed} />
                        ))}
                      </div>
                    ) : (
                      <div className="surface-card list-view">
                        {visibleDocs.map((d) => (
                          <DocumentRow key={d.documentId} document={d} onRemove={(id) => void removeDoc(id)} canRemove={!selected.managed} />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* ADR 0107 — Drive sync sources (self-hides when the toggle is off) */}
              <KnowledgeSyncPanel orgId={orgId} collectionId={selected.collectionId} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
