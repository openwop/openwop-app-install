/**
 * The `canvas.document` EditorSurface (ADR 0334 Phase 1) — the TipTap/ProseMirror
 * rich-text editor mounted by the shared chassis as the center panel. Ownership
 * split (ADR 0334): the CHASSIS owns save (CAS/409), version snapshots, and the
 * dirty flag; THIS surface owns intra-document selection and undo/redo (the
 * editor's own history). `onDocChange` lifts the working copy WITHOUT a chassis
 * undo step (the chassis suppresses its undo/redo toolbar for EditorSurface
 * types). An external content change (initial load, version restore) re-seeds the
 * editor via `setContent(..., { emitUpdate: false })` — guarded against a loop by
 * comparing against the last-emitted JSON.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditor, EditorContent } from '@tiptap/react';
import type { EditorSurfaceProps } from '../../canvas/types.js';
import type { CollabState } from '../../canvas/useCollab.js';
import { collabExtension } from './collabExtension.js';
import { generateJSON } from '@tiptap/core';
import { config, authedHeaders, fetchOpts } from '../../client/config.js';
import { IconButton, Modal, Notice } from '../../ui/index.js';
import { confirm } from '../../ui/confirm.js';
import { A11yIssuesPanel } from '../../a11y/A11yIssuesPanel.js';
import { registerCommandSource, type ContributedCommand } from '../../ui/commandContributions.js';
import { BoldIcon, ItalicIcon, CodeIcon, ListIcon, ListOrderedIcon, QuoteIcon, CodeBlockIcon, ImageIcon, LayoutGridIcon, ScanIcon, ShieldIcon, ArrowUpToLineIcon, BarChartIcon, MonitorIcon, SigmaIcon, MessageSquareIcon, SparklesIcon, PencilIcon, CheckIcon, XIcon } from '../../ui/icons/index.js';
import { useNavigate, useLocation } from 'react-router-dom';
import { CommentsPanel } from '../comments/CommentsPanel.js';
import { stageComposerDraft } from '../../chat/composerSeed.js';
import { stageReturnTarget, takePendingApply } from '../../chat/returnTarget.js';
import { applyAsSuggestion } from './trackChanges.js';
import { DOCUMENT_AUTHOR_AGENT } from './documentAgents.js';
import type { JSONContent } from '@tiptap/core';
import { Placeholder } from '@tiptap/extension-placeholder';
import { MediaPickerDialog } from '../media/MediaPickerDialog.js';
import { MathEditModal } from './MathEditModal.js';
import { ChartEditModal } from './ChartEditModal.js';
import { EmbedEditModal } from './EmbedEditModal.js';
import { absoluteServeUrl, type MediaAsset } from '../media/mediaClient.js';
import { documentExtensions } from './documentSchema.js';
import { importWarningsOf, importWouldDestroyContent } from './importGuards.js';
import { SlashCommand } from './slashCommand.js';
import { buildSlashItems } from './slashItems.js';
import {
  TrackChanges, isSuggesting, toggleSuggesting, hasAnyChange, hasChangeAt,
  acceptAllChanges, rejectAllChanges, acceptChangeAt, rejectChangeAt,
} from './trackChanges.js';
import type { DocumentDoc, A11yIssue } from './documentDoc.js';
import { EMPTY_DOC, documentA11yIssues } from './documentDoc.js';

/**
 * The editor body. Mounted by the outer `DocumentEditorSurface` ONCE the collab
 * state is resolved (so its extension set / undo owner is fixed at mount, never
 * swapped mid-session — ADR 0335 Phase 2). `collab.enabled` ⇒ bound to a shared
 * Y.Doc (CRDT authoritative; no `content` prop, no FE CAS save, no re-seed).
 */
function DocumentEditorSurfaceInner({ orgId, canvasId, doc, onDocChange, onAnnounce, collab }: EditorSurfaceProps<DocumentDoc> & { collab: CollabState }): JSX.Element {
  const { t } = useTranslation('document-editor');
  const collabOn = collab.enabled;
  const navigate = useNavigate();
  const location = useLocation();
  // Latest doc + onDocChange without re-creating the editor / update handler.
  const docRef = useRef<DocumentDoc>(doc);
  docRef.current = doc;
  const onDocChangeRef = useRef(onDocChange);
  onDocChangeRef.current = onDocChange;
  // The JSON we last lifted up — so our own emissions don't re-seed the editor.
  const emittedRef = useRef<string>(JSON.stringify(doc.content));
  // DOC-2 perf: our own edit just changed `doc.content` (a new object each
  // keystroke), so the re-seed effect can skip the O(doc) stringify+compare on
  // the hot typing path — only EXTERNAL changes (load/restore) need it.
  const selfEditRef = useRef(false);
  // ADR 0334 6b polish — open a comment thread when its highlighted range is
  // clicked (populated below, once canvasId + the opener are in scope).
  const openThreadRef = useRef<(threadId: string) => void>(() => {});

  const editor = useEditor({
    extensions: [
      // ADR 0335 — when collab is on, drop prosemirror-history (yUndoPlugin owns
      // per-user undo) and bind to the shared Y.Doc via y-prosemirror.
      ...documentExtensions(collabOn ? { history: false } : undefined),
      // Editable-only affordances (the read-only renderer never loads these):
      // an empty-line placeholder that also teaches the slash menu, and the `/`
      // command menu itself.
      Placeholder.configure({ placeholder: t('placeholder'), emptyEditorClass: 'doc-editor__content--empty' }),
      SlashCommand.configure({ items: buildSlashItems(t), emptyLabel: t('slashEmpty') }),
      // Track-changes plugin — editable-only (the read-only renderer never loads
      // it; it only needs the marks, which are in the shared schema).
      TrackChanges.configure({ author: orgId }),
      ...(collab.enabled ? [collabExtension(collab.ydoc, collab.awareness)] : []),
    ],
    // When collab is on the CRDT is the source of truth (ySyncPlugin populates the
    // doc); setting `content` would fight it. Solo path is unchanged.
    ...(collabOn ? {} : { content: doc.content }),
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': t('editorAriaLabel'),
        class: 'doc-editor__content',
      },
      // 6b polish — click a commented range to open its thread (still places the
      // cursor: return false so default selection handling proceeds).
      handleClick: (_view, _pos, event) => {
        const el = (event.target as HTMLElement | null)?.closest('[data-comment-thread]');
        const threadId = el?.getAttribute('data-comment-thread');
        if (threadId) openThreadRef.current(threadId);
        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      // ADR 0335 — when collab is on the CRDT snapshot is the durable authority;
      // the FE must NOT run the chassis CAS save (N clients → 409 storms +
      // double-authority). Deriving host.canvas is backend-side (2b).
      if (collabOn) return;
      const content: JSONContent = ed.getJSON();
      emittedRef.current = JSON.stringify(content);
      selfEditRef.current = true;
      onDocChangeRef.current({ ...docRef.current, content });
    },
  });

  // Re-seed on an EXTERNAL content change (load / version restore) — not on our
  // own emissions (guarded by emittedRef). setContent alone kept the engine's
  // UNDO STACK, so Ctrl+Z after a version restore silently resurrected the
  // pre-restore document (review of #1601, F3): rebuilding the plugin state
  // around the freshly-seeded doc resets history — an external seed is a new
  // editing session, not an undoable step.
  useEffect(() => {
    if (!editor) return;
    // ADR 0335 — when collab is on the Y.Doc is the source of truth; never re-seed
    // from the CAS working copy (that would clobber concurrent CRDT state).
    if (collabOn) return;
    // Skip the stringify+compare when this render was triggered by our OWN edit
    // (the editor already holds it); only external changes fall through.
    if (selfEditRef.current) { selfEditRef.current = false; return; }
    const incoming = JSON.stringify(doc.content ?? EMPTY_DOC);
    if (incoming !== emittedRef.current) {
      editor.commands.setContent(doc.content ?? EMPTY_DOC, { emitUpdate: false });
      const state = editor.state;
      editor.view.updateState(state.reconfigure({ plugins: [] }).reconfigure({ plugins: state.plugins }));
      emittedRef.current = incoming;
    }
  }, [editor, doc.content, collabOn]);

  // ADR 0335 2b — seed a FRESH collab room from the host.canvas document, exactly
  // once, via the backend CAS election: the first-ever opener wins `{seed:true}`
  // and writes the loaded content into the Y.Doc (ySyncPlugin propagates it);
  // every later client gets `{seed:false}` and receives the content by sync. The
  // CAS (not an emptiness check — ySync populates an empty paragraph on bind) is
  // the authority on "who seeds", correct across instances. The election +
  // transport URL are chassis-owned (`collab.claimSeed`, ADR 0359 D2); this
  // surface only APPLIES the seed content through its own engine.
  const seededRef = useRef(false);
  const collabSynced = collab.enabled && collab.synced;
  useEffect(() => {
    if (!editor || !collabSynced || !canvasId || seededRef.current || !collab.enabled) return;
    seededRef.current = true;
    void (async () => {
      const seed = await collab.claimSeed();
      if (seed && docRef.current.content) editor.commands.setContent(docRef.current.content, { emitUpdate: true });
    })();
  }, [editor, collabSynced, canvasId, collab]);

  // Each toolbar action already runs `.chain().focus().<cmd>().run()`, so focus
  // returns to the editor; we only add the a11y announcement here.
  const run = useCallback((fn: () => void, announced: string) => {
    fn();
    onAnnounce(announced);
  }, [onAnnounce]);

  // DOCUX-1 — roving-tabindex toolbar (ARIA APG): the toolbar is ONE Tab stop;
  // ArrowLeft/Right (+Home/End) move focus between buttons. Managed via the DOM
  // (a mix of IconButton + plain buttons) so we don't thread an index through
  // each button. The first button is the initial tab stop.
  const toolbarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const tb = toolbarRef.current;
    if (!tb) return;
    tb.querySelectorAll<HTMLButtonElement>('button').forEach((el, i) => { el.tabIndex = i === 0 ? 0 : -1; });
  }, [editor]);
  const onToolbarKey = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
    const tb = toolbarRef.current;
    if (!tb) return;
    const btns = Array.from(tb.querySelectorAll<HTMLButtonElement>('button'));
    const cur = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (cur < 0 || btns.length === 0) return;
    e.preventDefault();
    const next = e.key === 'ArrowRight' ? (cur + 1) % btns.length
      : e.key === 'ArrowLeft' ? (cur - 1 + btns.length) % btns.length
      : e.key === 'Home' ? 0 : btns.length - 1;
    btns.forEach((el, i) => { el.tabIndex = i === next ? 0 : -1; });
    btns[next]?.focus();
  }, []);

  // ADR 0334 2b — image insertion via the shared MediaPickerDialog (a
  // tenant-scoped Media asset; never a remote/guessable src).
  const [imgOpen, setImgOpen] = useState(false);
  // ADR 0334 4b-3 — DOCX import: a hidden file input the toolbar button triggers.
  const importRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  // DOC-G1 — what the DOCX conversion could not carry across.
  const [importWarnings, setImportWarnings] = useState<string[] | null>(null);
  const onPickImage = useCallback((asset: MediaAsset) => {
    editor?.chain().focus().setImage({ src: absoluteServeUrl(asset.serveUrl), alt: asset.name }).run();
    onAnnounce(t('imageInserted'));
    setImgOpen(false);
  }, [editor, onAnnounce, t]);

  // ADR 0334 3b-2 — Focus mode (the iA Writer pattern): dim all but the active
  // top-level block + typewriter-scroll it to centre. Opt-in (dimming/centring
  // hurts revision, so it's off by default). CSS does the dimming; this marks
  // the active block (`.has-focus`) on every selection/edit and centres it.
  const [focusMode, setFocusMode] = useState(false);
  // ADR 0334 3b-2 — accessibility checker (null = closed; [] = ran, clean).
  const [a11yIssues, setA11yIssues] = useState<A11yIssue[] | null>(null);
  // ADR 0334 2b-2 — LaTeX math modal (insert or edit the selected math block).
  const [math, setMath] = useState<{ latex: string; editing: boolean } | null>(null);
  // ADR 0334 2b-3 — chart + sandboxed-embed modals (insert or edit the selection).
  const [chart, setChart] = useState<{ spec: string; editing: boolean } | null>(null);
  const [embed, setEmbed] = useState<{ html: string; editing: boolean } | null>(null);
  // ADR 0334 6b — the open inline-comment thread's resourceId (`${canvasId}#${id}`),
  // shown in a Modal via the shared CommentsPanel; null = closed.
  const [commentResId, setCommentResId] = useState<string | null>(null);
  // ADR 0334 3b-3 — contribute the document's insert/tool verbs into the ONE app
  // ⌘K palette (never a second palette). The getter reads a ref refreshed each
  // render, so it always runs the latest handlers; registered once while mounted.
  const paletteCmdsRef = useRef<ContributedCommand[]>([]);
  // Re-register when the editor becomes ready so the (cached) palette snapshot
  // picks up the populated command list; withdraws on unmount.
  useEffect(() => registerCommandSource('document-editor', () => paletteCmdsRef.current), [editor]);
  // ADR 0334 5b-2 — on return from the chat, consume a one-shot pending-apply and
  // land the chosen AI text over its range AS A TRACKED SUGGESTION (never silently
  // authoritative). One-shot + canvas-matched; a stale range fails closed (no-op).
  useEffect(() => {
    if (!editor || !canvasId) return;
    const p = takePendingApply();
    if (!p || p.canvasId !== canvasId) return;
    if (applyAsSuggestion(editor, p.from, p.to, p.text)) onAnnounce(t('aiApplied'));
  }, [editor, canvasId, onAnnounce, t]);
  useEffect(() => {
    if (!editor || !focusMode) return;
    const root = editor.view.dom as HTMLElement;
    const mark = (): void => {
      let node: HTMLElement | null = editor.view.domAtPos(editor.state.selection.from).node as HTMLElement | null;
      while (node && node.parentElement && node.parentElement !== root) node = node.parentElement;
      root.querySelectorAll('.has-focus').forEach((el) => el.classList.remove('has-focus'));
      if (node && node.nodeType === 1) {
        node.classList.add('has-focus');
        node.scrollIntoView({ block: 'center', behavior: 'auto' });
      }
    };
    editor.on('selectionUpdate', mark);
    editor.on('update', mark);
    mark();
    return () => {
      editor.off('selectionUpdate', mark);
      editor.off('update', mark);
      root.querySelectorAll('.has-focus').forEach((el) => el.classList.remove('has-focus'));
    };
  }, [editor, focusMode]);

  if (!editor) {
    return <div className="doc-editor" aria-busy="true" />;
  }

  const active = (name: string, attrs?: Record<string, unknown>): boolean => editor.isActive(name, attrs);

  const openMath = (): void => {
    const editing = editor.isActive('mathBlock');
    setMath({ latex: editing ? String(editor.getAttributes('mathBlock').latex ?? '') : '', editing });
  };
  const onMathSave = (latex: string): void => {
    if (math?.editing) editor.chain().focus().updateAttributes('mathBlock', { latex }).run();
    else editor.chain().focus().insertContent({ type: 'mathBlock', attrs: { latex } }).run();
    onAnnounce(t('mathInserted'));
    setMath(null);
  };

  const openChart = (): void => {
    const editing = editor.isActive('chartBlock');
    setChart({ spec: editing ? String(editor.getAttributes('chartBlock').spec ?? '') : '', editing });
  };
  const onChartSave = (spec: string): void => {
    if (chart?.editing) editor.chain().focus().updateAttributes('chartBlock', { spec }).run();
    else editor.chain().focus().insertContent({ type: 'chartBlock', attrs: { spec } }).run();
    onAnnounce(t('chartInserted'));
    setChart(null);
  };

  const openEmbed = (): void => {
    const editing = editor.isActive('embedBlock');
    setEmbed({ html: editing ? String(editor.getAttributes('embedBlock').html ?? '') : '', editing });
  };
  const onEmbedSave = (html: string): void => {
    if (embed?.editing) editor.chain().focus().updateAttributes('embedBlock', { html }).run();
    else editor.chain().focus().insertContent({ type: 'embedBlock', attrs: { html } }).run();
    onAnnounce(t('embedInserted'));
    setEmbed(null);
  };

  // ADR 0334 6b — open the inline-comment thread for the current selection: reuse
  // an existing thread when the cursor sits inside a `comment` mark, else mint one
  // over the selected range (needs a persisted canvas + a non-empty selection).
  const openComment = (): void => {
    if (!canvasId) { onAnnounce(t('commentNeedsSave'), 'assertive'); return; }
    let threadId = editor.isActive('comment') ? String(editor.getAttributes('comment').threadId ?? '') : '';
    if (!threadId) {
      if (editor.state.selection.empty) { onAnnounce(t('commentSelectFirst'), 'assertive'); return; }
      threadId = crypto.randomUUID();
      editor.chain().focus().setMark('comment', { threadId }).run();
    }
    setCommentResId(`${canvasId}#${threadId}`);
  };
  // 6b polish — the editor's click handler opens a clicked comment's thread.
  openThreadRef.current = (threadId: string) => {
    if (canvasId && threadId) setCommentResId(`${canvasId}#${threadId}`);
  };

  // ADR 0334 5b — "Improve with AI": stage the selection as a composer draft and
  // deep-link the ONE chat scoped to the document-author agent (ADR 0058 chat-
  // drive — NO bespoke AI panel, NO in-editor LLM call). The user reviews + sends,
  // then 5b-2's "Apply" hands the chosen response back here as a tracked suggestion.
  const improveWithAi = (): void => {
    const { from, to, empty } = editor.state.selection;
    if (empty) { onAnnounce(t('aiSelectFirst'), 'assertive'); return; }
    const selected = editor.state.doc.textBetween(from, to, '\n', ' ').trim();
    if (!selected) { onAnnounce(t('aiSelectFirst'), 'assertive'); return; }
    stageComposerDraft(t('aiImprovePrompt', { text: selected }));
    // 5b-2 — stage the return-target so the chat can hand a chosen response back
    // to this range (applied as a suggestion on return). Only when persisted.
    if (canvasId) {
      const title = typeof doc.title === 'string' && doc.title.trim() ? doc.title.trim() : t('untitledDoc');
      stageReturnTarget({ label: title, returnPath: location.pathname, canvasId, from, to });
    }
    void navigate(`/?agent=${encodeURIComponent(DOCUMENT_AUTHOR_AGENT)}`);
  };

  // ADR 0334 6b-2 — track-changes (suggesting mode) + accept/reject.
  const suggesting = isSuggesting(editor.state);
  const anyChange = hasAnyChange(editor.state);
  const changeAtCursor = hasChangeAt(editor.state);
  const onToggleSuggest = (): void => {
    toggleSuggesting(editor);
    onAnnounce(t(isSuggesting(editor.state) ? 'suggestOff' : 'suggestOn'));
  };
  const onAcceptChange = (): void => { if (changeAtCursor ? acceptChangeAt(editor) : acceptAllChanges(editor)) onAnnounce(t('changeAccepted')); };
  const onRejectChange = (): void => { if (changeAtCursor ? rejectChangeAt(editor) : rejectAllChanges(editor)) onAnnounce(t('changeRejected')); };

  // ADR 0334 4b-3 — DOCX import. Reads the picked .docx as base64, POSTs it to the
  // backend mammoth→HTML converter, then parses the returned HTML THROUGH THE
  // SCHEMA (`generateJSON` — script/unknown tags are dropped, so no XSS reaches
  // the doc) and replaces the content (emitUpdate → onDocChange lifts + dirties).
  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    // DOC-G2 — the import REPLACES the whole document. On an empty document that
    // is obviously what was asked for; on a document with content it destroys
    // work, and the control sat next to the ordinary formatting buttons with no
    // warning. Confirm only when there IS something to lose.
    if (importWouldDestroyContent(editor.state.doc.textContent)) {
      const ok = await confirm({
        title: t('importReplaceTitle'),
        body: t('importReplaceBody'),
        confirmLabel: t('importReplaceConfirm'),
        danger: true,
      });
      if (!ok) return;
    }
    setImporting(true);
    onAnnounce(t('importing'));
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error('read failed'));
        reader.readAsDataURL(file);
      });
      const docxBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const url = `${config.baseUrl}/host/openwop-app/document-editor/orgs/${encodeURIComponent(orgId)}/import`;
      const resp = await fetch(url, fetchOpts({
        method: 'POST',
        headers: authedHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ docxBase64 }),
      }));
      if (!resp.ok) throw new Error(t('importFailedStatus', { status: resp.status }));
      // DOC-G1 — mammoth reports exactly what it could NOT convert, the route
      // already serializes those messages, and this client destructured only
      // `html` — so a document that lost tables, images or footnotes on the way
      // in looked identical to a clean import. The list is on the wire; show it.
      const payload = await resp.json() as { html: string };
      const warnings = importWarningsOf(payload);
      const json = generateJSON(payload.html, documentExtensions());
      editor.chain().focus().setContent(json).run();
      setImportWarnings(warnings.length ? warnings : null);
      onAnnounce(warnings.length ? t('importDoneWithWarnings', { count: warnings.length }) : t('importDone'), warnings.length ? 'assertive' : 'polite');
    } catch (err) {
      // DOC-G3 — the reason was computed and thrown, then swallowed: a 413 (too
      // large) read exactly like a 422 (unreadable file) or a dropped network.
      onAnnounce(err instanceof Error && err.message ? err.message : t('importFailed'), 'assertive');
    } finally {
      setImporting(false);
    }
  };

  // Refresh the ⌘K contribution each render so its `run`s use the latest editor
  // + handlers (the getter registered on mount reads this ref).
  const group = t('paletteGroup');
  paletteCmdsRef.current = [
    { id: 'doc-chart', label: t('chart'), hint: t('chartHint'), group, icon: BarChartIcon, run: openChart },
    { id: 'doc-embed', label: t('embed'), hint: t('embedHint'), group, icon: MonitorIcon, run: openEmbed },
    { id: 'doc-math', label: t('math'), hint: t('math'), group, icon: SigmaIcon, run: openMath },
    { id: 'doc-table', label: t('insertTable'), hint: t('insertTable'), group, icon: LayoutGridIcon,
      run: () => run(() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), t('insertTable')) },
    { id: 'doc-image', label: t('insertImage'), hint: t('insertImage'), group, icon: ImageIcon, run: () => setImgOpen(true) },
    { id: 'doc-import', label: t('importDocx'), hint: t('importDocxHint'), group, icon: ArrowUpToLineIcon, run: () => importRef.current?.click() },
    { id: 'doc-focus', label: t('focusMode'), hint: t('focusModeHint'), group, icon: ScanIcon, run: () => setFocusMode((v) => !v) },
    { id: 'doc-a11y', label: t('a11yCheck'), hint: t('a11yCheck'), group, icon: ShieldIcon,
      run: () => setA11yIssues(documentA11yIssues({ title: '', content: editor.getJSON() })) },
    ...(canvasId ? [{ id: 'doc-comment', label: t('comment'), hint: t('commentHint'), group, icon: MessageSquareIcon, run: openComment }] : []),
    { id: 'doc-ai-improve', label: t('aiImprove'), hint: t('aiImproveHint'), group, icon: SparklesIcon, run: improveWithAi },
    { id: 'doc-suggest', label: t('suggestMode'), hint: t('suggestModeHint'), group, icon: PencilIcon, run: onToggleSuggest },
    ...(anyChange ? [
      { id: 'doc-accept-all', label: t('acceptAll'), hint: t('acceptAll'), group, icon: CheckIcon, run: () => { if (acceptAllChanges(editor)) onAnnounce(t('changeAccepted')); } },
      { id: 'doc-reject-all', label: t('rejectAll'), hint: t('rejectAll'), group, icon: XIcon, run: () => { if (rejectAllChanges(editor)) onAnnounce(t('changeRejected')); } },
    ] : []),
  ];

  return (
    <div className={`doc-editor${focusMode ? ' doc-editor--focus' : ''}`}>
      <div className="doc-editor__toolbar" role="toolbar" aria-label={t('toolbarAriaLabel')} ref={toolbarRef} onKeyDown={onToolbarKey}>
          <IconButton label={t('bold')} icon={<BoldIcon />} aria-pressed={active('bold')} title={t('bold')}
            onClick={() => run(() => editor.chain().focus().toggleBold().run(), t('bold'))} />
          <IconButton label={t('italic')} icon={<ItalicIcon />} aria-pressed={active('italic')} title={t('italic')}
            onClick={() => run(() => editor.chain().focus().toggleItalic().run(), t('italic'))} />
          <IconButton label={t('inlineCode')} icon={<CodeIcon />} aria-pressed={active('code')} title={t('inlineCode')}
            onClick={() => run(() => editor.chain().focus().toggleCode().run(), t('inlineCode'))} />
          <span className="doc-editor__sep" aria-hidden="true" />
          {([1, 2, 3] as const).map((level) => (
            <button key={level} type="button" className="doc-editor__hbtn" aria-pressed={active('heading', { level })}
              aria-label={t('headingLevel', { level })} title={t('headingLevel', { level })}
              onClick={() => run(() => editor.chain().focus().toggleHeading({ level }).run(), t('headingLevel', { level }))}>
              {`H${level}`}
            </button>
          ))}
          <span className="doc-editor__sep" aria-hidden="true" />
          <IconButton label={t('bulletList')} icon={<ListIcon />} aria-pressed={active('bulletList')} title={t('bulletList')}
            onClick={() => run(() => editor.chain().focus().toggleBulletList().run(), t('bulletList'))} />
          <IconButton label={t('orderedList')} icon={<ListOrderedIcon />} aria-pressed={active('orderedList')} title={t('orderedList')}
            onClick={() => run(() => editor.chain().focus().toggleOrderedList().run(), t('orderedList'))} />
          <IconButton label={t('blockquote')} icon={<QuoteIcon />} aria-pressed={active('blockquote')} title={t('blockquote')}
            onClick={() => run(() => editor.chain().focus().toggleBlockquote().run(), t('blockquote'))} />
          <IconButton label={t('codeBlock')} icon={<CodeBlockIcon />} aria-pressed={active('codeBlock')} title={t('codeBlock')}
            onClick={() => run(() => editor.chain().focus().toggleCodeBlock().run(), t('codeBlock'))} />
          <span className="doc-editor__sep" aria-hidden="true" />
          <IconButton label={t('insertTable')} icon={<LayoutGridIcon />} aria-pressed={active('table')} title={t('insertTable')}
            onClick={() => run(() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), t('insertTable'))} />
          <IconButton label={t('insertImage')} icon={<ImageIcon />} title={t('insertImage')}
            onClick={() => setImgOpen(true)} />
          <button type="button" className="doc-editor__hbtn" aria-pressed={active('mathBlock')}
            aria-label={t('math')} title={t('math')} onClick={openMath}>∑</button>
          <IconButton label={t('chart')} icon={<BarChartIcon />} aria-pressed={active('chartBlock')} title={t('chartHint')}
            onClick={openChart} />
          <IconButton label={t('embed')} icon={<MonitorIcon />} aria-pressed={active('embedBlock')} title={t('embedHint')}
            onClick={openEmbed} />
          <span className="doc-editor__sep" aria-hidden="true" />
          <IconButton label={t('focusMode')} icon={<ScanIcon />} aria-pressed={focusMode} title={t('focusModeHint')}
            onClick={() => setFocusMode((v) => !v)} />
          <IconButton label={t('a11yCheck')} icon={<ShieldIcon />} title={t('a11yCheck')}
            onClick={() => setA11yIssues(documentA11yIssues({ title: '', content: editor.getJSON() }))} />
          <IconButton label={t('comment')} icon={<MessageSquareIcon />} aria-pressed={active('comment')} title={t('commentHint')}
            disabled={!canvasId} onClick={openComment} />
          <IconButton label={t('aiImprove')} icon={<SparklesIcon />} title={t('aiImproveHint')} onClick={improveWithAi} />
          <span className="doc-editor__sep" aria-hidden="true" />
          <IconButton label={t('suggestMode')} icon={<PencilIcon />} aria-pressed={suggesting} title={t('suggestModeHint')}
            onClick={onToggleSuggest} />
          {anyChange ? (
            <>
              <IconButton label={changeAtCursor ? t('acceptChange') : t('acceptAll')} icon={<CheckIcon />}
                title={changeAtCursor ? t('acceptChange') : t('acceptAll')} onClick={onAcceptChange} />
              <IconButton label={changeAtCursor ? t('rejectChange') : t('rejectAll')} icon={<XIcon />}
                title={changeAtCursor ? t('rejectChange') : t('rejectAll')} onClick={onRejectChange} />
            </>
          ) : null}
          <span className="doc-editor__sep" aria-hidden="true" />
          <IconButton label={t('importDocx')} icon={<ArrowUpToLineIcon />} title={t('importDocxHint')}
            disabled={importing} onClick={() => importRef.current?.click()} />
          <input ref={importRef} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            hidden onChange={onImportFile} />
      </div>
      {/* DOC-G1 — what the conversion could not carry across. Dismissible and
          inline rather than a toast: it names content the user has to go and
          restore by hand, so it must outlive a 4-second banner. */}
      {importWarnings ? (
        <Notice variant="warning">
          <strong>{t('importWarningsTitle', { count: importWarnings.length })}</strong>
          <ul className="doc-editor__import-warnings">
            {importWarnings.slice(0, 20).map((w) => <li key={w}>{w}</li>)}
          </ul>
          {importWarnings.length > 20 ? <p>{t('importWarningsMore', { count: importWarnings.length - 20 })}</p> : null}
          <Button variant="secondary" size="sm" onClick={() => setImportWarnings(null)}>{t('importWarningsDismiss')}</Button>
        </Notice>
      ) : null}
      <EditorContent editor={editor} className="doc-editor__scroll" />
      {imgOpen ? (
        <Modal onClose={() => setImgOpen(false)} label={t('insertImage')} showClose>
          <MediaPickerDialog orgId={orgId} onSelect={onPickImage} onClose={() => setImgOpen(false)} />
        </Modal>
      ) : null}
      {math !== null ? (
        <MathEditModal initial={math.latex} editing={math.editing} onSave={onMathSave} onClose={() => setMath(null)} />
      ) : null}
      {chart !== null ? (
        <ChartEditModal initial={chart.spec} editing={chart.editing} onSave={onChartSave} onClose={() => setChart(null)} />
      ) : null}
      {embed !== null ? (
        <EmbedEditModal initial={embed.html} editing={embed.editing} onSave={onEmbedSave} onClose={() => setEmbed(null)} />
      ) : null}
      {a11yIssues !== null ? (
        <Modal onClose={() => setA11yIssues(null)} label={t('a11yTitle')} showClose>
          <A11yIssuesPanel issues={a11yIssues} />
        </Modal>
      ) : null}
      {commentResId !== null ? (
        <Modal onClose={() => setCommentResId(null)} label={t('commentThreadTitle')} showClose>
          <CommentsPanel orgId={orgId} resourceType="canvas_document" resourceId={commentResId} />
        </Modal>
      ) : null}
    </div>
  );
}

/**
 * The `canvas.document` EditorSurface (ADR 0334). Since ADR 0359 D2 the CHASSIS
 * owns collab provisioning — the resolve-once toggle gate, `useCollab`, the
 * seeder election, the provisioning busy-gate, and the keyed remount all live in
 * `CanvasEditorPage`, which passes the session via `props.collab`. This wrapper
 * only normalizes the optional prop for the body (whose extension set / undo
 * owner are fixed at mount by the chassis key).
 */
export function DocumentEditorSurface(props: EditorSurfaceProps<DocumentDoc>): JSX.Element {
  return <DocumentEditorSurfaceInner {...props} collab={props.collab ?? { enabled: false }} />;
}
