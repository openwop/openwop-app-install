/**
 * ArtifactWorkbench (ADR 0069) — the durable side surface a chat artifact opens
 * into: Preview, Raw, Revisions, Diff, and Provenance over the type-neutral
 * `/artifacts/*` projection. Survives reload (it loads by the stable artifactId),
 * so it can be reopened from chat history. Read-only in v1 (promote/publish/export
 * remain on the owning Documents surfaces).
 */

import { Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../ui/Modal.js';
import { StateCard, Notice } from '../../ui/index.js';
import { Markdown } from '../../ui/Markdown.js';
import { AlertIcon } from '../../ui/icons/index.js';
import { ArtifactDiffView } from './ArtifactDiffView.js';
import { RevisionTimeline } from './RevisionTimeline.js';
import { ProvenancePanel } from './ProvenancePanel.js';
// ADR 0153 Phase 0 — inline previews dispatch through the artifact-renderer registry
// (the interactive.* built-ins register in `defaultRenderers`; canvas features add
// canvas.* renderers). The chosen renderer's component is lazy-split and wrapped in a
// single <Suspense> below (the PR #804 entry-budget pattern).
import { getArtifactRenderer } from './rendererRegistry.js';
import {
  getArtifact, listArtifactRevisions, getArtifactRevision, diffArtifact,
  type ArtifactProjection, type ArtifactRevision, type ArtifactDiff,
} from './artifactClient.js';

type Tab = 'preview' | 'raw' | 'revisions' | 'diff' | 'provenance';
const TABS: ReadonlyArray<{ id: Tab; labelKey: string }> = [
  { id: 'preview', labelKey: 'artifactTabPreview' },
  { id: 'raw', labelKey: 'artifactTabRaw' },
  { id: 'revisions', labelKey: 'artifactTabRevisions' },
  { id: 'diff', labelKey: 'artifactTabDiff' },
  { id: 'provenance', labelKey: 'artifactTabProvenance' },
];

interface Props {
  artifactId: string;
  /** Optional revision to open on (e.g. the revision a review pinned). */
  revisionId?: string;
  onClose: () => void;
}

export function ArtifactWorkbench({ artifactId, revisionId, onClose }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  const [tab, setTab] = useState<Tab>('preview');
  const [artifact, setArtifact] = useState<ArtifactProjection | null>(null);
  const [revisions, setRevisions] = useState<ArtifactRevision[]>([]);
  const [shown, setShown] = useState<ArtifactRevision | null>(null);
  const [compare, setCompare] = useState<{ from?: string; to?: string }>({});
  const [diff, setDiff] = useState<ArtifactDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // ADR 0128 Phase 5 — the EPHEMERAL live-edit canvas. `editing` toggles a scratch editor
  // over an interactive.* artifact; `draft` is the textarea buffer; `renderSrc` is the
  // DEBOUNCED draft fed to the SAME sandboxed renderer (so a fast typist doesn't thrash
  // the iframe re-mount). Local state ONLY — never persisted, no revision write, no server
  // call; the workbench stays read-only-in-v1 (this is a preview, not a save).
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [renderSrc, setRenderSrc] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setRenderSrc(draft), 250);
    return () => clearTimeout(id);
  }, [draft]);
  // ART-4 (WCAG 2.4.3) — when edit mode opens, move focus into the scratch editor
  // so the keyboard lands in the textarea that just mounted, not back at the top.
  const editorRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (editing) editorRef.current?.focus(); }, [editing]);
  // Exit the scratch editor when the artifact changes, so a stale draft can't bleed
  // across artifacts (the draft is re-seeded from the persisted source on each Edit).
  useEffect(() => { setEditing(false); }, [artifactId]);

  useEffect(() => {
    let live = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [a, revs] = await Promise.all([getArtifact(artifactId), listArtifactRevisions(artifactId)]);
        if (!live) return;
        setArtifact(a);
        setRevisions(revs);
        // Load the pinned revision (or the latest) for the preview/raw tabs.
        const target = revisionId ?? a.latestRevisionId ?? revs[0]?.revisionId;
        if (target) setShown(await getArtifactRevision(artifactId, target));
      } catch {
        // ART-7 — surface a friendly, localized message instead of raw exception text.
        if (live) setError(t('artifactLoadError'));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [artifactId, revisionId, t]);

  // Toggle a revision into the (from, to) compare pair; oldest = from, newest = to.
  const onToggleCompare = useCallback((rid: string) => {
    setCompare((c) => {
      const picked = [c.from, c.to].filter((x): x is string => Boolean(x));
      const next = picked.includes(rid) ? picked.filter((x) => x !== rid) : [...picked, rid].slice(-2);
      // Order by version so the diff reads old → new.
      const byVer = new Map(revisions.map((r) => [r.revisionId, r.version]));
      next.sort((a, b) => (byVer.get(a) ?? 0) - (byVer.get(b) ?? 0));
      return { ...(next[0] ? { from: next[0] } : {}), ...(next[1] ? { to: next[1] } : {}) };
    });
  }, [revisions]);

  useEffect(() => {
    if (compare.from && compare.to) {
      setDiff(null);
      diffArtifact(artifactId, compare.from, compare.to)
        .then(setDiff)
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }
  }, [artifactId, compare.from, compare.to]);

  // WAI-ARIA tablist roving: Arrow/Home/End move + select the focused tab.
  const onTabKeyDown = useCallback((e: ReactKeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    let next = i;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    else return;
    e.preventDefault();
    const target = TABS[next];
    if (target) {
      setTab(target.id);
      document.getElementById(`artifact-tab-${target.id}`)?.focus();
    }
  }, [tab]);

  const title = artifact ? artifact.title : t('artifactWorkbenchFallbackTitle');

  return (
    <Modal label={title} onClose={onClose} className="surface-card artifact-workbench">
      <header className="artifact-workbench__head">
        <h2 className="artifact-workbench__title">{title}</h2>
        {artifact ? (
          <div className="artifact-workbench__tags">
            <span className="chip chip--muted">{artifact.kind}</span>
            <span className="chip chip--muted">{artifact.status}</span>
            {artifact.artifactTypeId ? <span className="chip chip--accent">{artifact.artifactTypeId}</span> : null}
            {/* IART-2: interactive artifacts are untrusted-by-construction — they render in an
                origin-isolated, no-egress sandbox. Surface that transparency as a chip (the
                content-trust signal, without persisting a per-record contentTrust flag). */}
            {artifact.artifactTypeId?.startsWith('interactive.')
              ? <span className="chip chip--muted" title={t('artifactSandboxedHint')}>{t('artifactSandboxedBadge')}</span>
              : null}
          </div>
        ) : null}
      </header>

      <nav className="artifact-workbench__tabs" role="tablist" aria-label={t('artifactViewsLabel')} onKeyDown={onTabKeyDown}>
        {TABS.map((tabDef) => (
          <button
            key={tabDef.id}
            id={`artifact-tab-${tabDef.id}`}
            type="button"
            role="tab"
            aria-selected={tab === tabDef.id}
            aria-controls="artifact-tabpanel"
            tabIndex={tab === tabDef.id ? 0 : -1}
            className={`artifact-workbench__tab${tab === tabDef.id ? ' is-active' : ''}`}
            onClick={() => setTab(tabDef.id)}
          >
            {t(tabDef.labelKey)}
          </button>
        ))}
      </nav>

      <div className="artifact-workbench__body" id="artifact-tabpanel" role="tabpanel" aria-labelledby={`artifact-tab-${tab}`}>
        {loading ? <StateCard loading title={t('artifactLoading')} /> : null}
        {error ? <Notice variant="error">{error}</Notice> : null}
        {!loading && artifact ? (
          <>
            {tab === 'preview' ? (
              artifact.source === 'media' && shown?.content ? (
                // A media artifact's "content" is its serve URL — render the bytes
                // (image inline; everything else as a download link), not markdown.
                artifact.format.startsWith('image/')
                  ? <img className="artifact-workbench__media-img" src={shown.content} alt={artifact.title} />
                  : <a className="secondary btn-sm" href={shown.content} target="_blank" rel="noreferrer">{t('artifactOpenFile', { name: artifact.title })}</a>
              ) : shown?.content ? (
                // ADR 0153 Phase 0 — the inline preview dispatches through the artifact-renderer
                // registry (registerArtifactRenderer) rather than a hardcoded type chain: each
                // feature registers its renderer (interactive.* built-ins in defaultRenderers;
                // canvas.* renderers from the canvas features). A `renderer.editable` registration
                // opts into the EPHEMERAL live-edit canvas — a scratch textarea whose DEBOUNCED
                // draft (`renderSrc`) re-feeds the SAME renderer (no new untrusted path, no
                // persistence). Unknown types fall back to inert Markdown.
                (() => {
                  const renderer = getArtifactRenderer(artifact.artifactTypeId);
                  if (!renderer) return <Markdown className="artifact-workbench__preview">{shown.content}</Markdown>;
                  const RendererComponent = renderer.Component;
                  const body = editing ? renderSrc : shown.content;
                  return (
                    <div className="artifact-workbench__canvas">
                      {renderer.editable ? (
                        <div className="artifact-workbench__canvas-bar">
                          {editing ? (
                            <>
                              <button type="button" className="secondary btn-sm" onClick={() => setDraft(shown.content ?? '')}>{t('artifactEditReset')}</button>
                              <button type="button" className="secondary btn-sm" onClick={() => setEditing(false)}>{t('artifactEditDone')}</button>
                            </>
                          ) : (
                            <button type="button" className="secondary btn-sm" onClick={() => { const src = shown.content ?? ''; setDraft(src); setRenderSrc(src); setEditing(true); }}>{t('artifactEdit')}</button>
                          )}
                        </div>
                      ) : null}
                      {renderer.editable && editing ? (
                        <textarea
                          ref={editorRef}
                          className="artifact-workbench__canvas-src"
                          value={draft}
                          spellCheck={false}
                          aria-label={t('artifactEditSource')}
                          onChange={(e) => setDraft(e.target.value)}
                        />
                      ) : null}
                      <Suspense fallback={<StateCard loading title={t('artifactLoading')} />}>
                        <RendererComponent artifact={artifact} content={body} />
                      </Suspense>
                    </div>
                  );
                })()
              ) : <p className="artifact-workbench__empty">{t('artifactNoPreview')}</p>
            ) : null}
            {tab === 'raw' ? (
              <pre className="artifact-workbench__raw">{shown?.content ?? t('artifactNoContent')}</pre>
            ) : null}
            {tab === 'revisions' ? (
              <RevisionTimeline revisions={revisions} latestRevisionId={artifact.latestRevisionId} compare={compare} onToggleCompare={onToggleCompare} />
            ) : null}
            {tab === 'diff' ? (
              compare.from && compare.to ? (
                diff ? <ArtifactDiffView diff={diff.diff} /> : <StateCard loading title={t('artifactComputingDiff')} />
              ) : (
                <StateCard icon={<AlertIcon />} title={t('artifactPickTwoTitle')} body={t('artifactPickTwoBody')} />
              )
            ) : null}
            {tab === 'provenance' ? <ProvenancePanel artifact={artifact} /> : null}
          </>
        ) : null}
      </div>
    </Modal>
  );
}
