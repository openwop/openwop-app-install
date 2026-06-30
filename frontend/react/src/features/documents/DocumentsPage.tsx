/**
 * Documents page (ADR 0053). An org-scoped business-document workspace: a
 * documents list (grid/list, filterable) + a Markdown editor with version
 * history and export. Document CREATION (blank, from a template, from a canvas)
 * and template management now live in the on-demand <NewDocumentModal> behind
 * the header's "New document" action — the page body is no longer cluttered by
 * always-on create/starter/template sections (the blank-first, templates-on-
 * demand pattern Word/Drive converge on). Honest about run-scoped generation:
 * the page assembles + lets you author/save versions; the actual AI draft is
 * produced by the feature.documents.nodes workflow node / agent.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime, formatNumber } from '../../i18n/format.js';
import { Notice, PageHeader, StateCard, Skeleton, useUnsavedChangesWarning, ViewToggle, useViewMode } from '../../ui/index.js';
import { LockIcon, GlobeIcon, PlusIcon, SaveIcon, FileTextIcon } from '../../ui/icons/index.js';
import { DocumentCard, DocumentRow } from './DocumentViews.js';
import { NewDocumentModal } from './NewDocumentModal.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { getEffectiveAccess } from '../../client/accessClient.js';
import {
  listOrgs, listDocuments, getDocument, patchDocument, deleteDocument,
  listVersions, addVersion, renderDocument,
  DOC_STATUSES,
  type Org, type DocumentRecord, type DocumentVersion, type DocStatus,
} from './documentsClient.js';

export function DocumentsPage(): JSX.Element {
  const { t } = useTranslation('documents');
  const access = useFeatureAccess('documents');
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [selected, setSelected] = useState<DocumentRecord | null>(null);
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [draft, setDraft] = useState('');
  // The loaded baseline body — `draft` diverges from it on edit, matches it
  // again after a load/select or a successful "Save version". UX CONT-6.
  const [savedDraft, setSavedDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [viewMode, setViewMode] = useViewMode('documents', 'grid');
  const [showNew, setShowNew] = useState(false);
  // ADR 0063 — only offer "New document" to a caller who can write, so a
  // read-only member doesn't get a create modal that 403s on submit.
  const [canCreate, setCanCreate] = useState(false);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return docs;
    return docs.filter((d) => d.title.toLowerCase().includes(q));
  }, [docs, query]);

  useEffect(() => {
    if (!access.enabled) return;
    void listOrgs().then((o) => { setOrgs(o); setOrgId((cur) => cur || (o[0]?.orgId ?? '')); }).catch(() => setOrgs([]));
    void getEffectiveAccess().then((a) => setCanCreate(a.scopes.includes('workspace:write'))).catch(() => setCanCreate(false));
  }, [access.enabled]);

  useEffect(() => {
    if (!orgId) return;
    setError('');
    void listDocuments(orgId).then(setDocs).catch((e: Error) => setError(e.message));
  }, [orgId]);

  async function openDoc(doc: DocumentRecord): Promise<void> { await openDocById(doc.documentId); }
  async function openDocById(documentId: string): Promise<void> {
    setError('');
    try {
      const full = await getDocument(orgId, documentId);
      setSelected(full);
      setDraft(full.currentVersion?.content ?? '');
      setSavedDraft(full.currentVersion?.content ?? '');
      setVersions(await listVersions(orgId, documentId));
    } catch (e) { setError((e as Error).message); }
  }

  async function refreshDocs(): Promise<void> { setDocs(await listDocuments(orgId)); }

  async function saveVersion(): Promise<void> {
    if (!selected) return;
    setBusy(true); setError('');
    try {
      await addVersion(orgId, selected.documentId, draft);
      setSavedDraft(draft);
      setVersions(await listVersions(orgId, selected.documentId));
      await refreshDocs();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function download(format: 'pdf' | 'slides' | 'sheet'): Promise<void> {
    if (!selected) return;
    setBusy(true); setError('');
    try {
      const r = await renderDocument(orgId, selected.documentId, format);
      window.open(r.downloadUrl, '_blank', 'noopener');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function setStatus(status: DocStatus): Promise<void> {
    if (!selected) return;
    setError('');
    try {
      const updated = await patchDocument(orgId, selected.documentId, { status });
      setSelected({ ...selected, status: updated.status });
      await refreshDocs();
    } catch (e) { setError((e as Error).message); }
  }

  async function removeDoc(doc: DocumentRecord): Promise<void> {
    setError('');
    try {
      await deleteDocument(orgId, doc.documentId);
      if (selected?.documentId === doc.documentId) { setSelected(null); setVersions([]); setDraft(''); setSavedDraft(''); }
      await refreshDocs();
    } catch (e) { setError((e as Error).message); }
  }

  // Dirty while the editor body diverges from the loaded version (self-resetting
  // on select / successful save). Status changes patch immediately, so they are
  // never "unsaved". UX CONT-6.
  const dirty = selected !== null && draft !== savedDraft;
  useUnsavedChangesWarning(dirty);

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />;
  }

  const orgPicker = orgs && orgs.length > 0 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label={t('orgAriaLabel')}>
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : undefined;

  const headerActions = orgs && orgs.length > 0 ? (
    <>
      {orgPicker}
      {canCreate ? (
        <button type="button" className="btn-accent-solid" disabled={!orgId} onClick={() => setShowNew(true)}>
          <PlusIcon size={14} aria-hidden /> {t('newDocumentButton')}
        </button>
      ) : null}
    </>
  ) : undefined;

  return (
    <div className="u-grid u-gap-4">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} actions={headerActions} />

      {error ? <Notice variant="error">{error}</Notice> : null}

      {!orgs ? <Skeleton /> : orgs.length === 0 ? (
        <StateCard icon={<GlobeIcon />} title={t('noOrgsTitle')} body={t('noOrgsBody')} />
      ) : (
        <div className="u-grid u-gap-4">
          {/* documents list */}
          <div className="u-grid u-gap-2">
            <h2 className="u-fs-16 u-m-0">{t('documentsHeading', { count: docs.length })}</h2>
            {docs.length === 0 ? (
              <StateCard
                icon={<FileTextIcon size={20} />}
                title={t('noDocumentsTitle')}
                body={t('noDocumentsBody')}
                action={canCreate ? <button type="button" className="primary" disabled={!orgId} onClick={() => setShowNew(true)}>{t('newDocumentButton')}</button> : undefined}
              />
            ) : (
              <>
                <div className="filterbar" role="group" aria-label={t('filterGroup')}>
                  {docs.length > 3 ? (
                    <input
                      type="search"
                      className="ui-input filterbar-search"
                      placeholder={t('filterPlaceholder')}
                      aria-label={t('filterAria')}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  ) : null}
                  <ViewToggle value={viewMode} onChange={setViewMode} className="u-ml-auto" />
                </div>

                {visible.length === 0 ? (
                  <StateCard
                    icon={<FileTextIcon size={20} />}
                    title={t('noMatchTitle')}
                    body={t('noMatchBody')}
                    action={<button type="button" className="secondary" onClick={() => setQuery('')}>{t('clearSearch')}</button>}
                  />
                ) : viewMode === 'grid' ? (
                  <div className="card-grid">
                    {visible.map((d) => <DocumentCard key={d.documentId} doc={d} onOpen={(doc) => void openDoc(doc)} />)}
                  </div>
                ) : (
                  <div className="surface-card list-view">
                    {visible.map((d) => <DocumentRow key={d.documentId} doc={d} onOpen={(doc) => void openDoc(doc)} onRemove={(doc) => void removeDoc(doc)} />)}
                  </div>
                )}
              </>
            )}
          </div>

          {/* editor */}
          {selected ? (
            <div className="surface-card u-p-4 u-grid u-gap-2">
              <div className="u-flex u-items-center u-gap-2">
                <h2 className="u-fs-16 u-m-0 u-flex-1">{selected.title}</h2>
                <select value={selected.status} onChange={(e) => void setStatus(e.target.value as DocStatus)} className="u-w-auto" aria-label={t('statusAriaLabel')}>
                  {DOC_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={10} placeholder={t('contentPlaceholder')} aria-label={t('contentAriaLabel')} />
              <div className="action-bar">
                <button type="button" className="btn-primary" disabled={busy} onClick={() => void saveVersion()}><SaveIcon /> {t('saveVersion')}</button>
                <button type="button" className="btn-ghost" aria-label={t('downloadPdfAria')} disabled={busy || !selected.currentVersionId} onClick={() => void download('pdf')}><FileTextIcon /> {t('downloadPdf')}</button>
                <button type="button" className="btn-ghost" aria-label={t('downloadSlidesAria')} disabled={busy || !selected.currentVersionId} onClick={() => void download('slides')}><FileTextIcon /> {t('downloadSlides')}</button>
                <button type="button" className="btn-ghost" aria-label={t('downloadCsvAria')} disabled={busy || !selected.currentVersionId} onClick={() => void download('sheet')}><FileTextIcon /> {t('downloadCsv')}</button>
              </div>
              {versions.length > 0 ? (
                <div className="u-grid u-gap-1">
                  <span className="u-label-sm">{t('versionHistory')}</span>
                  {versions.map((v) => <span key={v.versionId} className="u-label-sm">{t('versionEntry', { version: formatNumber(v.version), date: formatDateTime(v.createdAt) })}</span>)}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      {showNew && orgId ? (
        <NewDocumentModal
          orgId={orgId}
          onClose={() => setShowNew(false)}
          onCreated={async (doc) => {
            setShowNew(false);
            await refreshDocs();
            await openDocById(doc.documentId);
          }}
        />
      ) : null}
    </div>
  );
}
