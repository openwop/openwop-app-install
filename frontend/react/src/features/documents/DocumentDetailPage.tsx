/**
 * Document detail page (ADR 0350 Phase 1). The full-screen, per-document URL
 * (`/documents/:documentId?org=<orgId>`) for a markdown business document —
 * extracted from the DocumentsPage inline editor so every document has its own
 * shareable, middle-clickable address (Notion/Drive "each doc is a URL"). The
 * documents store stays canonical (ADR 0053); this is a routing/URL change, not
 * a new store. Fullbleed chrome, matching the canvas-editor convention; a
 * centered column keeps the markdown body readable at full-screen widths.
 *
 * Phase 2 (ADR 0350) adds the markdown-native editing experience: a Write /
 * Split / Preview toggle whose preview pane reuses the shared `ui/Markdown`
 * renderer (GFM, XSS-safe, `chat-md`-themed) — a live projection of the textarea
 * buffer, never a second store. No new editor dependency (react-markdown already
 * ships; this lazy route keeps it out of the entry bundle). Markdown stays the
 * canonical format of the `documents` store (Pattern 2 — live rich VIEW over the
 * markdown source, not a rich store).
 *
 * Phase 3 (ADR 0350) adds an opt-in, one-way "Promote to rich document" that
 * converts this markdown doc into a `canvas.document` (ADR 0334): server renders
 * markdown→HTML, the document-editor schema (lazy-imported) turns HTML→ProseMirror,
 * a new canvas is seeded, and `promotedCanvasId` is linked back here. Idempotent —
 * re-promote opens the same canvas; the source stays as a linked, non-dual-edited
 * markdown artifact. Gated on the `document-editor` toggle.
 */
import { Button } from '../../ui/Button.js';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { formatDateTime, formatNumber } from '../../i18n/format.js';
import { Notice, StateCard, Skeleton, useUnsavedChangesWarning } from '../../ui/index.js';
import { useConfirmDiscardUnsaved } from '../../ui/useUnsavedChangesWarning.js';
import { Markdown } from '../../ui/Markdown.js';
import { confirm } from '../../ui/confirm.js';
import { Menu } from '../../ui/Menu.js';
import { ArrowDownToLineIcon, LockIcon, SaveIcon, FileTextIcon, ArrowLeftIcon, ArrowUpRightIcon, TrashIcon, PencilIcon, ColumnsIcon, EyeIcon, SparklesIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { createCanvasClient } from '../../canvas/canvasClient.js';
import { CREATABLE_CANVAS_TYPES } from '../../canvas/creatableTypes.js';
import {
  getDocument, locateDocument, patchDocument, deleteDocument,
  listVersions, addVersion, renderDocument, promoteToHtml, type RenderExportFormat,
  DOC_STATUSES,
  type DocumentRecord, type DocumentVersion, type DocStatus,
} from './documentsClient.js';

type DocumentDetail = DocumentRecord & { currentVersion: DocumentVersion | null };
type DocEditorView = 'write' | 'split' | 'preview';
const VIEW_KEY = 'documents:editorView';
// The rich `canvas.document` type's host-ext base + SPA editor route (ADR 0334),
// resolved once from the shared creatable-types registry — no hardcoded paths.
const DOC_CANVAS = CREATABLE_CANVAS_TYPES.find((d) => d.canvasTypeId === 'canvas.document');

export function DocumentDetailPage(): JSX.Element {
  const { t } = useTranslation('documents');
  const navigate = useNavigate();
  const access = useFeatureAccess('documents');
  // Promote-to-rich is offered only when the rich editor feature is on.
  const richEditor = useFeatureAccess('document-editor');
  const { documentId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const orgParam = searchParams.get('org') ?? '';

  const [orgId, setOrgId] = useState(orgParam);
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [draft, setDraft] = useState('');
  // The loaded baseline — `draft` diverges on edit, matches again after a
  // load/select or a successful "Save version" (UX CONT-6).
  const [savedDraft, setSavedDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  // UX-DOC-6 — a non-40x load failure is retryable, not "not found".
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const retryLoad = (): void => { setLoadFailed(null); setLoading(true); setReloadNonce((n) => n + 1); };
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Write / Split / Preview (ADR 0350 Phase 2). Persisted so the choice sticks
  // across documents; defaults to Split (source + live preview side by side).
  const [viewMode, setViewMode] = useState<DocEditorView>(() => {
    try { const s = localStorage.getItem(VIEW_KEY); return s === 'write' || s === 'preview' || s === 'split' ? s : 'split'; } catch { return 'split'; }
  });
  useEffect(() => { try { localStorage.setItem(VIEW_KEY, viewMode); } catch { /* storage unavailable — non-fatal */ } }, [viewMode]);

  // Load: resolve the org (query param, else ONE server-side locate — DOCS-2
  // replaced the old per-org getDocument fan-out) then the document + its
  // version history. A missing/inaccessible doc lands on the not-found state.
  useEffect(() => {
    if (!access.enabled || !documentId) return;
    let cancelled = false;
    setLoading(true); setNotFound(false); setError('');
    void (async () => {
      try {
        const org = orgParam || (await locateDocument(documentId)).orgId;
        const full: DocumentDetail | null = await getDocument(org, documentId);
        if (cancelled) return;
        if (!full) { setNotFound(true); setLoading(false); return; }
        const loadedVersions = await listVersions(org, documentId);
        if (cancelled) return;
        setOrgId(org);
        setDoc(full);
        setDraft(full.currentVersion?.content ?? '');
        setSavedDraft(full.currentVersion?.content ?? '');
        setVersions(loadedVersions);
        setLoading(false);
      } catch (e) {
        // A 404/403 reads as "not found" (no existence leak). Every OTHER
        // failure — a 500, offline — used to fold into the same card, telling
        // the user a document that exists doesn't (UX-DOC-6, P2 baseline).
        // Those now get a retryable failure state instead.
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        if (/returned 40[34]$/.test(msg)) setNotFound(true);
        else setLoadFailed(msg);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [access.enabled, documentId, orgParam, reloadNonce]);

  // Move focus to the heading once the document loads, so keyboard/SR users land
  // on what just appeared (VOXUX-G1, carried over from the inline editor).
  const loadedTitle = doc?.title;
  useEffect(() => { if (loadedTitle) headingRef.current?.focus(); }, [loadedTitle]);

  const dirty = doc !== null && draft !== savedDraft;
  useUnsavedChangesWarning(dirty);
  // DOCTPL-1 (the FORM-UX-2/ADR 0584 class) — the IN-APP half. `beforeunload`
  // never fires for a react-router navigation, and this page renders its own
  // exits (the back link, the already-promoted rich-editor hop), so one click
  // silently discarded unsaved edits while the page's own `dirty` knew better.
  const confirmLeave = useConfirmDiscardUnsaved(dirty);

  async function saveVersion(): Promise<void> {
    if (!doc) return;
    setBusy(true); setError('');
    try {
      await addVersion(orgId, doc.documentId, draft);
      setSavedDraft(draft);
      setVersions(await listVersions(orgId, doc.documentId));
    } catch (e) { setError(e instanceof Error ? e.message : t('actionFailed')); } finally { setBusy(false); }
  }

  async function download(format: RenderExportFormat): Promise<void> {
    if (!doc) return;
    setBusy(true); setError('');
    try {
      const r = await renderDocument(orgId, doc.documentId, format);
      window.open(r.downloadUrl, '_blank', 'noopener');
    } catch (e) { setError(e instanceof Error ? e.message : t('actionFailed')); } finally { setBusy(false); }
  }

  async function setStatus(status: DocStatus): Promise<void> {
    if (!doc) return;
    setError('');
    try {
      const updated = await patchDocument(orgId, doc.documentId, { status });
      setDoc({ ...doc, status: updated.status });
    } catch (e) { setError(e instanceof Error ? e.message : t('actionFailed')); }
  }

  // ADR 0350 Phase 3 — one-way, idempotent promotion to a rich `canvas.document`.
  // Already promoted → just open it. Otherwise: render markdown→HTML (server),
  // convert HTML→ProseMirror via the document-editor schema (lazy-imported so the
  // heavy TipTap engine never enters the documents chunk), create + seed a canvas,
  // and link it back on the source doc (link FIRST so a mid-flight failure still
  // resolves a re-promote to the SAME canvas — never a second).
  async function promoteToRich(): Promise<void> {
    if (!doc || !DOC_CANVAS) return;
    // DOCTPL-1 — the already-promoted hop navigates away; unsaved edits need
    // the same confirm as any other exit (the source doc keeps its markdown).
    if (doc.promotedCanvasId) {
      if (!(await confirmLeave())) return;
      navigate(`${DOC_CANVAS.editorPath}/${doc.promotedCanvasId}`);
      return;
    }
    setBusy(true); setError('');
    try {
      // DOCTPL-1 — promote used to convert the SAVED version while the screen
      // showed a diverged draft: a silent content fork on top of the discard.
      // Save first, so what gets promoted is what the user is looking at.
      if (dirty) {
        await addVersion(orgId, doc.documentId, draft);
        setSavedDraft(draft);
      }
      const { html, title, promotedCanvasId } = await promoteToHtml(orgId, doc.documentId);
      if (promotedCanvasId) { navigate(`${DOC_CANVAS.editorPath}/${promotedCanvasId}`); return; }
      const { htmlToDocumentJson } = await import('../document-editor/documentSchema.js');
      const content = htmlToDocumentJson(html);
      const client = createCanvasClient({ basePath: DOC_CANVAS.basePath });
      const rec = await client.createCanvas(orgId, { name: title || doc.title });
      await patchDocument(orgId, doc.documentId, { promotedCanvasId: rec.canvasId });
      setDoc({ ...doc, promotedCanvasId: rec.canvasId });
      await client.saveCanvas(orgId, rec.canvasId, { title: title || doc.title, content }, rec.version);
      navigate(`${DOC_CANVAS.editorPath}/${rec.canvasId}`);
    } catch (e) { setError(e instanceof Error ? e.message : t('actionFailed')); setBusy(false); }
  }

  async function removeDoc(): Promise<void> {
    if (!doc) return;
    if (!(await confirm({ title: t('deleteDocumentConfirm', { name: doc.title }), body: t('deleteDocumentBody'), danger: true, confirmLabel: t('common:delete') }))) return;
    setError('');
    try {
      await deleteDocument(orgId, doc.documentId);
      // DOCTPL-1 — the row is gone; clear `dirty` before navigating so no
      // leave-guard (in-app or beforeunload) can fire over deleted content.
      setSavedDraft(draft);
      navigate('/documents');
    } catch (e) { setError(e instanceof Error ? e.message : t('actionFailed')); }
  }

  const backLink = (
    // DOCTPL-1 — the charter/form-guard pattern: a plain click on the page's
    // own exit awaits the discard confirm while dirty; modified clicks
    // (new-tab) and clean state pass through untouched.
    <Link
      to="/documents"
      className="btn-ghost btn-sm"
      onClick={(e) => {
        if (!dirty || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        void confirmLeave().then((ok) => { if (ok) { setSavedDraft(draft); navigate('/documents'); } });
      }}
    ><ArrowLeftIcon size={14} aria-hidden /> {t('backToDocuments')}</Link>
  );

  if (access.loading) return <Skeleton />;
  if (!access.enabled) return <StateCard icon={<LockIcon />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />;

  return (
    <div className="u-p-4 u-grid u-gap-3 u-mx-auto u-w-full" style={{ maxWidth: viewMode === 'split' ? '1200px' : '900px' }}>
      <div className="action-bar">{backLink}</div>

      {error ? <Notice variant="error">{error}</Notice> : null}

      {loading ? (
        <div role="status"><span className="sr-only">{t('common:loading')}</span><Skeleton width="40%" /><Skeleton width="90%" /></div>
      ) : loadFailed ? (
        <StateCard announce icon={<FileTextIcon size={20} />} title={t('documentLoadFailedTitle')} body={`${t('documentLoadFailedBody')} ${loadFailed}`} action={<Button variant="secondary" size="sm" onClick={retryLoad}>{t('common:retry')}</Button>} />
      ) : notFound || !doc ? (
        <StateCard icon={<FileTextIcon size={20} />} title={t('documentNotFoundTitle')} body={t('documentNotFoundBody')} />
      ) : (
        <div className="surface-card u-p-4 u-grid u-gap-2">
          <div className="u-flex u-items-center u-gap-2 u-wrap">
            <h1 className="u-fs-16 u-m-0 u-flex-1" ref={headingRef} tabIndex={-1}>{doc.title}</h1>
            {/* DOCTPL-2 — model/automation provenance is stamped server-side on
                doc AND version and rendered nowhere. `chip--ai` is §5.3's
                model-provenance token; a human reviewer approving this doc must
                see who drafted it. */}
            {doc.provenance?.producedBy?.kind === 'agent' ? (
              <span className="chip chip--ai u-fs-11">{t('draftedByAgent')}</span>
            ) : doc.provenance?.producedBy?.kind === 'run' ? (
              <span className="chip chip--ai u-fs-11">{t('generatedByWorkflow')}</span>
            ) : null}
            <div className="action-bar" role="group" aria-label={t('viewModeGroup')}>
              {/* UX-DOCS-1 — visible text labels (discoverability); the accessible
                  name comes from the content, so no aria-label needed. */}
              <Button variant="quiet" size="sm" aria-pressed={viewMode === 'write'} onClick={() => setViewMode('write')}><PencilIcon size={14} aria-hidden /> {t('viewWrite')}</Button>
              <Button variant="quiet" size="sm" aria-pressed={viewMode === 'split'} onClick={() => setViewMode('split')}><ColumnsIcon size={14} aria-hidden /> {t('viewSplit')}</Button>
              <Button variant="quiet" size="sm" aria-pressed={viewMode === 'preview'} onClick={() => setViewMode('preview')}><EyeIcon size={14} aria-hidden /> {t('viewPreview')}</Button>
            </div>
            <select value={doc.status} onChange={(e) => void setStatus(e.target.value as DocStatus)} className="u-w-auto" aria-label={t('statusAriaLabel')}>
              {DOC_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className={`md-editor-body${viewMode === 'split' ? ' md-editor-body--split' : ''}`}>
            {viewMode !== 'preview' ? (
              <textarea className="md-editor-textarea" value={draft} onChange={(e) => setDraft(e.target.value)} rows={20} placeholder={t('contentPlaceholder')} aria-label={t('contentAriaLabel')} />
            ) : null}
            {viewMode !== 'write' ? (
              <div className="md-editor-preview" role="region" aria-label={t('previewAria')} tabIndex={0}>
                {draft.trim() ? <Markdown>{draft}</Markdown> : <span className="muted u-fs-13">{t('previewEmpty')}</span>}
              </div>
            ) : null}
          </div>
          <div className="action-bar">
            <Button variant="primary" disabled={busy} onClick={() => void saveVersion()}><SaveIcon /> {t('saveVersion')}</Button>
            {/* ADR 0400 — the export menu (PDF · Slides · CSV · DOCX · EPUB · ODT);
                editable formats carry the fidelity hint (math/footnote softening). */}
            <Menu
              label={t('downloadMenuAria')}
              triggerContent={<><ArrowDownToLineIcon size={14} aria-hidden /> {t('downloadMenu')}</>}
              triggerClassName="btn-ghost"
              disabled={busy || !doc.currentVersionId}
              items={[
                { id: 'pdf', label: t('downloadPdfItem'), onSelect: () => void download('pdf') },
                { id: 'slides', label: t('downloadSlides'), onSelect: () => void download('slides') },
                { id: 'sheet', label: t('downloadCsv'), onSelect: () => void download('sheet') },
                { id: 'sep', separator: true },
                // UXB-2 — the fidelity caveat is a VISIBLE inline tag on the
                // editable formats, not a hover-only title.
                { id: 'docx', label: <>{t('downloadDocx')} <span className="muted">· {t('exportFidelityTag')}</span></>, title: t('exportFidelityHint'), onSelect: () => void download('docx') },
                { id: 'epub', label: t('downloadEpub'), onSelect: () => void download('epub') },
                { id: 'odt', label: <>{t('downloadOdt')} <span className="muted">· {t('exportFidelityTag')}</span></>, title: t('exportFidelityHint'), onSelect: () => void download('odt') },
                // LaTeX is math's native format — the one export with faithful math.
                { id: 'latex', label: <>{t('downloadLatex')} <span className="muted">· {t('exportLatexTag')}</span></>, title: t('exportLatexHint'), onSelect: () => void download('latex') },
              ]}
            />
            {richEditor.enabled && DOC_CANVAS && !doc.promotedCanvasId ? (
              <Button variant="quiet" disabled={busy} title={t('promoteToRichHint')} onClick={() => void promoteToRich()}><SparklesIcon /> {t('promoteToRich')}</Button>
            ) : null}
            <Button variant="quiet" aria-label={t('common:delete')} onClick={() => void removeDoc()}><TrashIcon /> {t('common:delete')}</Button>
          </div>
          {doc.promotedCanvasId && DOC_CANVAS ? (
            <Notice variant="info">
              {t('promotedNotice')}{' '}
              {/* DOCTPL-1 — this is also an exit the page renders; same guard. */}
              <Link
                className="inline-link"
                to={`${DOC_CANVAS.editorPath}/${doc.promotedCanvasId}`}
                onClick={(e) => {
                  if (!dirty || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                  e.preventDefault();
                  const dest = `${DOC_CANVAS.editorPath}/${doc.promotedCanvasId}`;
                  void confirmLeave().then((ok) => { if (ok) { setSavedDraft(draft); navigate(dest); } });
                }}
              >{t('openRichDocument')} <ArrowUpRightIcon size={13} aria-hidden /></Link>
            </Notice>
          ) : null}
          {versions.length > 0 ? (
            <div className="u-grid u-gap-1">
              <span className="u-label-sm">{t('versionHistory')}</span>
              {versions.map((v) => (
                <span key={v.versionId} className="u-label-sm u-flex u-items-center u-gap-1">
                  {t('versionEntry', { version: formatNumber(v.version), date: formatDateTime(v.createdAt) })}
                  {/* DOCTPL-2 — a human doc can carry agent-written revisions;
                      the history is where that distinction lives. */}
                  {v.producedBy?.kind === 'agent' ? <span className="chip chip--ai u-fs-11">{t('draftedByAgent')}</span>
                    : v.producedBy?.kind === 'run' ? <span className="chip chip--ai u-fs-11">{t('generatedByWorkflow')}</span> : null}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
