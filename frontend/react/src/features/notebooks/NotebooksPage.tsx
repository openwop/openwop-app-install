/**
 * Research Notebooks page (ADR 0084). A notebook chooser (list + create) and,
 * for the selected notebook, a three-panel workspace:
 *   - Sources : the notebook's KB documents + an "add text source" form.
 *   - Notes   : curated subject-memory notes + an add-note form.
 *   - Ask     : a grounded RAG "Ask" box over the notebook's collection
 *               (hits + citations, with "save answer to notes"), plus a launch
 *               panel that deep-links into the main /chat surface — the notebook's
 *               project group conversation, grounded server-side in its sources
 *               (ADR 0084 Phase 2). No second chat system.
 *
 * Gating mirrors every feature page: hidden in nav when off, a disabled state on
 * the page when the toggle is off, the full UI when on. Drives notebooksClient,
 * which wraps the host-extension routes 1:1.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { TextField, TextareaField, SelectField } from '../../ui/Field.js';
import { toast } from '../../ui/toast.js';
import { confirm } from '../../ui/confirm.js';
import { formatNumber, formatRelativeTime } from '../../i18n/format.js';
import {
  BookOpenIcon, PlusIcon, TrashIcon, FileTextIcon, ClipboardIcon, SearchIcon, MessageSquareIcon, ArrowLeftIcon, SparklesIcon, ZapIcon, ArrowRightIcon,
  MicIcon, LinkIcon, PaperclipIcon,
} from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { fileToBase64, inferContentType, KB_UPLOAD_ACCEPT, withinUploadCap, MAX_UPLOAD_MB } from '../../client/fileToBase64.js';
import {
  listNotebooks, createNotebook, ensureNotebook, deleteNotebook, listOrgs,
  listSources, addSource, addFileSource, addAudioSource, addYoutubeSource, setSourceContextLevel, summarizeSource, listNotes, addNote, searchNotebook, ensureNotebookChat,
  listTransformationTemplates, applyTransformation, listTransformations,
  type Notebook, type NotebookSource, type NotebookNote, type NotebookSearchResult, type Org, type SourceContextLevel,
  type TransformationTemplate, type Transformation,
} from './notebooksClient.js';

/** Approximate tokens for a source. Heuristic: ~250 tokens per KB chunk (the KB
 *  chunker targets ~1k chars/chunk; ~4 chars per token ⇒ ~250 tokens/chunk). This
 *  is a UI affordance (a rough "context budget" indicator), not an exact count. */
const TOKENS_PER_CHUNK = 250;
const sourceTokens = (s: NotebookSource): number => s.chunkCount * TOKENS_PER_CHUNK;
/** Locale-aware compact token count (e.g. `1.5K` en / `1,5 mil` pt-BR) via the
 *  shared formatter (ADR 0065 — no hand-rolled toFixed in UI code). */
const formatTokens = (n: number): string => formatNumber(n, { notation: 'compact', maximumFractionDigits: 1 });

function NotebookChooser({ onOpen }: { onOpen: (nb: Notebook) => void }): JSX.Element {
  const { t } = useTranslation('notebooks');
  const [notebooks, setNotebooks] = useState<Notebook[] | null>(null);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [orgId, setOrgId] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    void listNotebooks().then(setNotebooks).catch((err) => setError(err instanceof Error ? err.message : t('loadFailed')));
  }, [t]);

  useEffect(() => {
    load();
    void listOrgs().then(setOrgs).catch(() => { /* org list is best-effort */ });
  }, [load]);

  const effectiveOrg = orgId || orgs[0]?.orgId || '';

  const create = useCallback(async () => {
    if (!name.trim() || !effectiveOrg) return;
    setBusy(true);
    try {
      await createNotebook(effectiveOrg, name.trim());
      setName('');
      load();
      toast.success(t('created'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('createFailed'));
    } finally {
      setBusy(false);
    }
  }, [name, effectiveOrg, load, t]);

  const remove = useCallback(async (id: string) => {
    try {
      await deleteNotebook(id);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('deleteFailed'));
    }
  }, [load, t]);

  return (
    <section className="u-grid u-gap-4">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      <form className="surface-card u-p-4 surface-form" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <TextField
          label={t('nameLabel')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('namePlaceholder')}
        />
        <SelectField label={t('orgLabel')} value={effectiveOrg} onChange={(e) => setOrgId(e.target.value)}>
          {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
        </SelectField>
        <button type="submit" className="btn-primary" disabled={busy || !name.trim() || !effectiveOrg}>
          <PlusIcon size={14} /> {t('createNotebook')}
        </button>
      </form>

      {notebooks === null ? (
        <Skeleton height={120} />
      ) : notebooks.length === 0 ? (
        <StateCard icon={<BookOpenIcon size={24} />} title={t('emptyTitle')} body={t('emptyBody')} />
      ) : (
        <div className="nb-grid">
          {notebooks.map((nb) => (
            <div key={nb.id} className="surface-card u-p-4 nb-card">
              <button type="button" className="nb-card__name inline-link" onClick={() => onOpen(nb)}>
                {nb.name}
              </button>
              <span className="nb-card__meta">{t('sourcesTitle')}</span>
              <span className="action-bar">
                <button type="button" className="btn-ghost" onClick={() => onOpen(nb)}>{t('open')}</button>
                <button type="button" className="btn-ghost" onClick={() => { void confirm({ title: t('deleteNotebookConfirm', { name: nb.name }), danger: true, confirmLabel: t('common:delete') }).then((ok) => { if (ok) void remove(nb.id); }); }} aria-label={t('deleteNotebookLabel', { name: nb.name })}>
                  <TrashIcon size={14} /> {t('common:delete')}
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function NotebookWorkspace({ notebook, onBack }: { notebook: Notebook; onBack?: () => void }): JSX.Element {
  const { t } = useTranslation('notebooks');
  const navigate = useNavigate();
  const [chatBusy, setChatBusy] = useState(false);
  const [sources, setSources] = useState<NotebookSource[] | null>(null);
  const [notes, setNotes] = useState<NotebookNote[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Add-source form
  const [srcTitle, setSrcTitle] = useState('');
  const [srcText, setSrcText] = useState('');
  const [srcBusy, setSrcBusy] = useState(false);

  // Audio/video + YouTube sources (ADR 0085) — both enqueue async ingest runs.
  const [ytUrl, setYtUrl] = useState('');
  const [audioBusy, setAudioBusy] = useState(false);
  const [ytBusy, setYtBusy] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);

  // Add-note form
  const [noteText, setNoteText] = useState('');
  const [noteBusy, setNoteBusy] = useState(false);

  // Ask box
  const [query, setQuery] = useState('');
  const [askBusy, setAskBusy] = useState(false);
  const [answer, setAnswer] = useState<NotebookSearchResult | null>(null);

  // Transformations (ADR 0084 T2) — the catalog (per-source Transform menu) + the
  // result Documents (read-only, owned by the notebook subject in Documents).
  const [templates, setTemplates] = useState<TransformationTemplate[]>([]);
  const [transformations, setTransformations] = useState<Transformation[] | null>(null);
  // Sources mid-transform (the run is async — show pending until a new artifact
  // lands). Keyed by documentId.
  const [transforming, setTransforming] = useState<Set<string>>(new Set());

  const loadSources = useCallback(() => {
    void listSources(notebook.id).then(setSources).catch((err) => setError(err instanceof Error ? err.message : t('loadFailed')));
  }, [notebook.id, t]);
  const loadNotes = useCallback(() => {
    void listNotes(notebook.id).then(setNotes).catch((err) => setError(err instanceof Error ? err.message : t('loadFailed')));
  }, [notebook.id, t]);
  const loadTransformations = useCallback(() => {
    void listTransformations(notebook.id).then(setTransformations).catch((err) => setError(err instanceof Error ? err.message : t('loadFailed')));
  }, [notebook.id, t]);

  useEffect(() => {
    loadSources();
    loadNotes();
    loadTransformations();
    void listTransformationTemplates(notebook.id).then(setTemplates).catch(() => { /* catalog is best-effort */ });
  }, [loadSources, loadNotes, loadTransformations, notebook.id]);

  const submitSource = useCallback(async () => {
    if (!srcText.trim()) return;
    setSrcBusy(true);
    try {
      await addSource(notebook.id, { ...(srcTitle.trim() ? { title: srcTitle.trim() } : {}), text: srcText.trim() });
      setSrcTitle('');
      setSrcText('');
      loadSources();
      toast.success(t('sourceAdded'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('sourceAddFailed'));
    } finally {
      setSrcBusy(false);
    }
  }, [notebook.id, srcTitle, srcText, loadSources, t]);

  // Sources mid-summarize (the run is async; show pending until listSources reports
  // hasSummary). Keyed by documentId.
  const [summarizing, setSummarizing] = useState<Set<string>>(new Set());

  // The async pollers below recurse via setTimeout; this flips false on unmount so a
  // poll in flight when the user navigates away stops fetching + setting state on an
  // unmounted component (review fix).
  const liveRef = useRef(true);
  useEffect(() => () => { liveRef.current = false; }, []);

  // Poll listSources until the count grows past `baseline` (a transcribed source
  // landed) or the ~30s cap — the same async pattern as summarize/transform; an
  // ingest run is an LLM transcription / network fetch, so it can take seconds.
  const pollForNewSource = useCallback((baseline: number) => {
    let attempts = 0;
    const poll = async (): Promise<void> => {
      attempts += 1;
      if (!liveRef.current) return; // bail if the workspace unmounted mid-poll
      try {
        const fresh = await listSources(notebook.id);
        setSources(fresh);
        if (fresh.length > baseline) return;
      } catch { /* transient — keep polling until the cap */ }
      if (attempts >= 10) return; // ~30s cap; the user can re-open to re-check
      window.setTimeout(() => { void poll(); }, 3000);
    };
    window.setTimeout(() => { void poll(); }, 2500);
  }, [notebook.id]);

  const submitAudio = useCallback(async (file: File | undefined) => {
    if (!file) return;
    if (!withinUploadCap(file)) { toast.error(t('fileTooLarge', { max: MAX_UPLOAD_MB })); return; }
    setAudioBusy(true);
    try {
      const contentBase64 = await fileToBase64(file);
      const contentType = file.type || 'audio/mpeg';
      const baseline = sources?.length ?? 0;
      await addAudioSource(notebook.id, { title: file.name, contentBase64, contentType });
      toast.success(t('audioEnqueued'));
      pollForNewSource(baseline);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('audioFailed'));
    } finally {
      setAudioBusy(false);
    }
  }, [notebook.id, sources, pollForNewSource, t]);

  // Document file upload (text/PDF/DOCX) — extracted to text + ingested synchronously.
  const submitDocument = useCallback(async (file: File | undefined) => {
    if (!file) return;
    if (!withinUploadCap(file)) { toast.error(t('fileTooLarge', { max: MAX_UPLOAD_MB })); return; }
    setFileBusy(true);
    try {
      const contentBase64 = await fileToBase64(file);
      await addFileSource(notebook.id, { title: file.name, contentBase64, contentType: inferContentType(file) });
      loadSources();
      toast.success(t('sourceAdded'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('sourceAddFailed'));
    } finally {
      setFileBusy(false);
    }
  }, [notebook.id, loadSources, t]);

  const submitYoutube = useCallback(async () => {
    if (!ytUrl.trim()) return;
    setYtBusy(true);
    try {
      const baseline = sources?.length ?? 0;
      await addYoutubeSource(notebook.id, { url: ytUrl.trim() });
      setYtUrl('');
      toast.success(t('youtubeEnqueued'));
      pollForNewSource(baseline);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('youtubeFailed'));
    } finally {
      setYtBusy(false);
    }
  }, [notebook.id, ytUrl, sources, pollForNewSource, t]);

  const changeLevel = useCallback(async (sourceId: string, level: SourceContextLevel) => {
    // Optimistic: flip the level locally, then reconcile with the server's projection.
    setSources((prev) => prev?.map((s) => (s.documentId === sourceId ? { ...s, contextLevel: level } : s)) ?? prev);
    try {
      const updated = await setSourceContextLevel(notebook.id, sourceId, level);
      setSources((prev) => prev?.map((s) => (s.documentId === sourceId ? updated : s)) ?? prev);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('contextLevelFailed'));
      loadSources(); // roll back to the server truth
    }
  }, [notebook.id, loadSources, t]);

  const summarize = useCallback(async (sourceId: string) => {
    setSummarizing((prev) => new Set(prev).add(sourceId));
    try {
      await summarizeSource(notebook.id, sourceId);
      toast.success(t('summarizeStarted'));
      // The run is async (an LLM call — can take several seconds). Poll listSources
      // until the source reports hasSummary rather than guessing a fixed delay; stop
      // on success, on max attempts, or if the page navigated away. Refresh the panel
      // on every poll so the user sees it land the moment it does.
      const clearPending = () =>
        setSummarizing((prev) => { const next = new Set(prev); next.delete(sourceId); return next; });
      let attempts = 0;
      const poll = async (): Promise<void> => {
        attempts += 1;
      if (!liveRef.current) return; // bail if the workspace unmounted mid-poll
        try {
          const fresh = await listSources(notebook.id);
          setSources(fresh);
          if (fresh.find((s) => s.documentId === sourceId)?.hasSummary) { clearPending(); return; }
        } catch { /* transient — keep polling until the cap */ }
        if (attempts >= 8) { clearPending(); return; } // ~20s cap; the user can re-open to re-check
        window.setTimeout(() => { void poll(); }, 2500);
      };
      window.setTimeout(() => { void poll(); }, 2000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('summarizeFailed'));
      setSummarizing((prev) => { const next = new Set(prev); next.delete(sourceId); return next; });
    }
  }, [notebook.id, loadSources, t]);

  const transform = useCallback(async (sourceId: string, templateId: string) => {
    if (!templateId) return;
    setTransforming((prev) => new Set(prev).add(sourceId));
    try {
      await applyTransformation(notebook.id, sourceId, templateId);
      toast.success(t('transformStarted'));
      // The run is async (an LLM call). Poll listTransformations until a new artifact
      // lands (count grows) rather than guessing a fixed delay; stop on success, on
      // max attempts, or when the page navigates away (~20s cap). Refresh the panel on
      // every poll so the user sees it the moment it lands.
      const baseline = transformations?.length ?? 0;
      const clearPending = () =>
        setTransforming((prev) => { const next = new Set(prev); next.delete(sourceId); return next; });
      let attempts = 0;
      const poll = async (): Promise<void> => {
        attempts += 1;
      if (!liveRef.current) return; // bail if the workspace unmounted mid-poll
        try {
          const fresh = await listTransformations(notebook.id);
          setTransformations(fresh);
          if (fresh.length > baseline) { clearPending(); return; }
        } catch { /* transient — keep polling until the cap */ }
        if (attempts >= 8) { clearPending(); return; } // ~20s cap; re-open to re-check
        window.setTimeout(() => { void poll(); }, 2500);
      };
      window.setTimeout(() => { void poll(); }, 2000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('transformFailed'));
      setTransforming((prev) => { const next = new Set(prev); next.delete(sourceId); return next; });
    }
  }, [notebook.id, transformations, t]);

  const submitNote = useCallback(async (text: string) => {
    if (!text.trim()) return;
    setNoteBusy(true);
    try {
      const next = await addNote(notebook.id, text.trim());
      setNotes(next);
      setNoteText('');
      toast.success(t('noteAdded'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('noteAddFailed'));
    } finally {
      setNoteBusy(false);
    }
  }, [notebook.id, t]);

  const openChat = useCallback(async () => {
    setChatBusy(true);
    try {
      const { conversationId } = await ensureNotebookChat(notebook.id);
      navigate(`/chat?conversation=${encodeURIComponent(conversationId)}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('chatOpenFailed'));
      setChatBusy(false);
    }
  }, [notebook.id, navigate, t]);

  const ask = useCallback(async () => {
    if (!query.trim()) return;
    setAskBusy(true);
    setError(null);
    try {
      setAnswer(await searchNotebook(notebook.id, query.trim()));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('askFailed'));
    } finally {
      setAskBusy(false);
    }
  }, [notebook.id, query, t]);

  return (
    <section className="u-grid u-gap-4">
      {/* Embedded in a project tab (onBack absent): the project page owns the header,
          so skip the page-level PageHeader + back action. ADR 0084 correction. */}
      {onBack ? (
        <PageHeader
          eyebrow={t('eyebrow')}
          title={notebook.name}
          lede={t('workspaceLede')}
          actions={<button type="button" className="btn-ghost" onClick={onBack}><ArrowLeftIcon size={14} /> {t('backToList')}</button>}
        />
      ) : null}
      {error ? <Notice variant="error">{error}</Notice> : null}

      <div className="nb-workspace">
        {/* Sources */}
        <div className="surface-card u-p-4 nb-panel">
          <div className="nb-panel__head">
            <h2 className="nb-panel__title"><FileTextIcon size={16} /> {t('sourcesTitle')}</h2>
            {sources && sources.length > 0 ? (
              <span className="chip chip--muted" title={t('contextBudgetHint')}>
                {t('contextBudget', {
                  tokens: formatTokens(sources.filter((s) => s.contextLevel !== 'excluded').reduce((sum, s) => sum + sourceTokens(s), 0)),
                })}
              </span>
            ) : null}
          </div>
          <form className="u-grid u-gap-2" onSubmit={(e) => { e.preventDefault(); void submitSource(); }}>
            <TextField label={t('sourceTitleLabel')} value={srcTitle} onChange={(e) => setSrcTitle(e.target.value)} placeholder={t('sourceTitlePlaceholder')} />
            <TextareaField label={t('sourceTextLabel')} value={srcText} onChange={(e) => setSrcText(e.target.value)} rows={4} placeholder={t('sourceTextPlaceholder')} />
            <button type="submit" className="btn-primary" disabled={srcBusy || !srcText.trim()}><PlusIcon size={14} /> {t('addSource')}</button>
          </form>
          {/* Document file upload (text/PDF/DOCX) — extracted to text synchronously. */}
          <div className="field u-mt-2">
            <span className="field-label"><PaperclipIcon size={14} /> {t('addFileLabel')}</span>
            <input
              type="file"
              accept={KB_UPLOAD_ACCEPT}
              disabled={fileBusy}
              aria-label={t('addFileLabel')}
              aria-describedby="nb-file-help"
              onChange={(e) => { void submitDocument(e.target.files?.[0]); e.target.value = ''; }}
            />
            <div className="field-help" id="nb-file-help">{fileBusy ? t('uploading') : t('addFileHint')}</div>
          </div>
          {/* Audio/video upload + YouTube URL (ADR 0085) — both transcribe to a KB source asynchronously. */}
          <div className="u-grid u-gap-2 u-mt-2">
            <div className="field">
              <span className="field-label"><MicIcon size={14} /> {t('addAudioLabel')}</span>
              <input
                type="file"
                accept="audio/*,video/*"
                disabled={audioBusy}
                aria-label={t('addAudioLabel')}
                aria-describedby="nb-audio-help"
                onChange={(e) => { void submitAudio(e.target.files?.[0]); e.target.value = ''; }}
              />
              <div className="field-help" id="nb-audio-help">{audioBusy ? t('uploading') : t('addAudioHint')}</div>
            </div>
            <form className="u-grid u-gap-2" onSubmit={(e) => { e.preventDefault(); void submitYoutube(); }}>
              <TextField label={t('addYoutubeLabel')} type="url" value={ytUrl} onChange={(e) => setYtUrl(e.target.value)} placeholder={t('addYoutubePlaceholder')} />
              <button type="submit" className="btn-ghost" disabled={ytBusy || !ytUrl.trim()}><LinkIcon size={14} /> {t('addYoutubeBtn')}</button>
            </form>
          </div>
          {sources === null ? (
            <Skeleton height={60} />
          ) : sources.length === 0 ? (
            <StateCard icon={<FileTextIcon size={20} />} title={t('noSourcesTitle')} body={t('noSourcesBody')} />
          ) : (
            <ul className="nb-list">
              {sources.map((s) => {
                const excluded = s.contextLevel === 'excluded';
                const isSummarizing = summarizing.has(s.documentId);
                const isPending = isSummarizing || transforming.has(s.documentId);
                const itemClass = [
                  'nb-list__item',
                  excluded ? 'nb-list__item--excluded' : '',
                  isPending ? 'nb-list__item--pending' : '',
                ].filter(Boolean).join(' ');
                return (
                  <li key={s.documentId} className={itemClass} aria-busy={isPending ? 'true' : undefined}>
                    <div className="nb-list__item-title">{s.title}</div>
                    <div className="nb-list__item-meta">
                      {t('chunkCount', { count: s.chunkCount })} · {t('approxTokens', { tokens: formatTokens(sourceTokens(s)) })}
                    </div>
                    <div className="nb-level" role="group" aria-label={t('contextLevelLabel', { title: s.title })}>
                      <button
                        type="button"
                        className="nb-level__btn"
                        aria-pressed={s.contextLevel === 'full'}
                        onClick={() => { if (s.contextLevel !== 'full') void changeLevel(s.documentId, 'full'); }}
                      >
                        {t('levelFull')}
                      </button>
                      <button
                        type="button"
                        className="nb-level__btn"
                        aria-pressed={s.contextLevel === 'summary'}
                        disabled={!s.hasSummary}
                        title={s.hasSummary ? t('levelSummaryReadyHint') : t('levelSummaryHint')}
                        onClick={() => { if (s.hasSummary && s.contextLevel !== 'summary') void changeLevel(s.documentId, 'summary'); }}
                      >
                        {t('levelSummary')}
                      </button>
                      <button
                        type="button"
                        className="nb-level__btn"
                        aria-pressed={excluded}
                        onClick={() => { if (!excluded) void changeLevel(s.documentId, 'excluded'); }}
                      >
                        {t('levelExcluded')}
                      </button>
                    </div>
                    <div className="action-bar">
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={isSummarizing}
                        onClick={() => void summarize(s.documentId)}
                        title={s.hasSummary ? t('resummarizeHint') : t('summarizeHint')}
                      >
                        <SparklesIcon size={14} /> {isSummarizing ? t('summarizing') : s.hasSummary ? t('resummarize') : t('summarize')}
                      </button>
                      {templates.length > 0 ? (
                        <label className="nb-transform" title={t('transformHint')}>
                          <span className="nb-transform__icon"><ZapIcon size={14} /></span>
                          <span className="u-sr-only">{t('transformLabel', { title: s.title })}</span>
                          <select
                            className="nb-transform__select"
                            value=""
                            disabled={transforming.has(s.documentId)}
                            onChange={(e) => { const v = e.target.value; e.target.value = ''; void transform(s.documentId, v); }}
                          >
                            <option value="" disabled>
                              {transforming.has(s.documentId) ? t('transforming') : t('transform')}
                            </option>
                            {templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.label}</option>)}
                          </select>
                        </label>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Notes */}
        <div className="surface-card u-p-4 nb-panel">
          <h2 className="nb-panel__title"><ClipboardIcon size={16} /> {t('notesTitle')}</h2>
          <form className="u-grid u-gap-2" onSubmit={(e) => { e.preventDefault(); void submitNote(noteText); }}>
            <TextareaField label={t('noteLabel')} value={noteText} onChange={(e) => setNoteText(e.target.value)} rows={3} placeholder={t('notePlaceholder')} />
            <button type="submit" className="btn-primary" disabled={noteBusy || !noteText.trim()}><PlusIcon size={14} /> {t('addNote')}</button>
          </form>
          {notes === null ? (
            <Skeleton height={60} />
          ) : notes.length === 0 ? (
            <StateCard icon={<ClipboardIcon size={20} />} title={t('noNotesTitle')} body={t('noNotesBody')} />
          ) : (
            <ul className="nb-list">
              {notes.map((n) => (
                <li key={n.id} className="nb-list__item">
                  <div className="nb-note__body">{n.content}</div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Transformations (ADR 0084 T2) — the result Documents, read-only. The
            output lives in Documents (single source of truth); this panel only lists
            it and deep-links the Documents surface. */}
        <div className="surface-card u-p-4 nb-panel">
          <h2 className="nb-panel__title"><FileTextIcon size={16} /> {t('transformationsTitle')}</h2>
          <p className="muted u-m-0 u-fs-12">{t('transformationsNote')}</p>
          {transformations === null ? (
            <Skeleton height={60} />
          ) : transformations.length === 0 ? (
            <StateCard icon={<ZapIcon size={20} />} title={t('noTransformationsTitle')} body={t('noTransformationsBody')} />
          ) : (
            <ul className="nb-list">
              {transformations.map((tr) => (
                <li key={tr.documentId} className="nb-list__item">
                  <div className="nb-list__item-title">{tr.title}</div>
                  <div className="nb-list__item-meta">
                    <span className="chip chip--accent">{tr.kind}</span>{' '}
                    {formatRelativeTime(tr.createdAt)}
                  </div>
                  <div className="action-bar">
                    <button type="button" className="btn-ghost" onClick={() => navigate('/documents')}>
                      <ArrowRightIcon size={14} /> {t('openInDocuments')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Ask + chat */}
        <div className="surface-card u-p-4 nb-panel">
          <h2 className="nb-panel__title"><SearchIcon size={16} /> {t('askTitle')}</h2>
          <form className="u-grid u-gap-2" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
            <TextField label={t('askLabel')} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('askPlaceholder')} />
            <button type="submit" className="btn-primary" disabled={askBusy || !query.trim()}><SearchIcon size={14} /> {t('ask')}</button>
          </form>

          {answer ? (
            answer.hits.length === 0 ? (
              <StateCard icon={<SearchIcon size={20} />} title={t('noHitsTitle')} body={t('noHitsBody')} />
            ) : (
              <div className="u-grid u-gap-2">
                <div className="nb-citations">
                  {answer.citations.map((c) => <span key={c.documentId} className="chip chip--accent">{c.title}</span>)}
                </div>
                {answer.hits.map((h) => (
                  <div key={h.chunkId} className="nb-hit">
                    <div className="nb-hit__head">
                      <span className="nb-list__item-title">{h.title}</span>
                      <span className="chip chip--muted">{t('score', { score: Math.round(h.score * 100) })}</span>
                    </div>
                    <div className="nb-hit__text">{h.text}</div>
                    <span className="action-bar">
                      <button type="button" className="btn-ghost" onClick={() => void submitNote(h.text)} disabled={noteBusy}>
                        <ClipboardIcon size={14} /> {t('saveToNotes')}
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )
          ) : null}

          <h2 className="nb-panel__title"><MessageSquareIcon size={16} /> {t('chatTitle')}</h2>
          <p className="muted u-m-0 u-fs-12">{t('chatGroundedNote')}</p>
          <StateCard
            icon={<MessageSquareIcon size={20} />}
            title={t('chatLaunchTitle')}
            body={t('chatLaunchBody')}
            action={(
              <button type="button" className="btn-primary" disabled={chatBusy} onClick={() => void openChat()}>
                <MessageSquareIcon size={14} /> {chatBusy ? t('chatOpening') : t('openChat')}
              </button>
            )}
          />
        </div>
      </div>
    </section>
  );
}

export function NotebooksPage(): JSX.Element {
  const { t } = useTranslation('notebooks');
  const notebooks = useFeatureAccess('notebooks');
  const [selected, setSelected] = useState<Notebook | null>(null);

  if (notebooks.loading) return <Skeleton />;
  if (!notebooks.enabled) {
    return (
      <section className="u-grid u-gap-4">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} />
        <StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </section>
    );
  }

  return selected
    ? <NotebookWorkspace notebook={selected} onBack={() => setSelected(null)} />
    : <NotebookChooser onOpen={setSelected} />;
}

/** Sources tab embedded in a project (ADR 0084 correction) — provisions the
 *  project's KB collection on open (idempotent `ensureNotebook`), then renders the
 *  full notebook workspace (sources w/ context levels, audio/YouTube ingest,
 *  transformations, grounded Ask) scoped to this project. No back chrome — the
 *  project page owns the header. Toggle-gating is done by the host tab. */
export function ProjectSourcesPanel({ projectId }: { projectId: string }): JSX.Element {
  const { t } = useTranslation('notebooks');
  const [notebook, setNotebook] = useState<Notebook | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void ensureNotebook(projectId)
      .then((nb) => { if (live) setNotebook(nb); })
      .catch((err) => { if (live) setError(err instanceof Error ? err.message : String(err)); });
    return () => { live = false; };
  }, [projectId]);
  if (error) return <StateCard title={t('loadFailed')} body={error} />;
  if (!notebook) return <Skeleton height={120} />;
  return <NotebookWorkspace notebook={notebook} />;
}
