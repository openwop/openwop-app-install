/**
 * Version history you can use (ADR 0838 D6). Each immutable version can be
 * VIEWED, COMPARED with the current version, and RESTORED — non-destructively:
 * restore saves the old text as a NEW version, checked against the current one
 * (D5), so history is never rewritten and a concurrent save is never buried.
 *
 * Compare reuses the ONE diff the app already has: the artifact projection's
 * server-computed `GET /artifacts/document:<id>/diff` and the chat workbench's
 * `ArtifactDiffView` (ADR 0069) — no second diff. Lazy-loaded from the detail
 * page, so neither this nor the diff view enters the entry chunk.
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Markdown } from '../../ui/Markdown.js';
import { Notice, Skeleton } from '../../ui/index.js';
import { confirm } from '../../ui/confirm.js';
import { formatDateTime, formatNumber } from '../../i18n/format.js';
import { ArtifactDiffView } from '../../chat/artifacts/ArtifactDiffView.js';
import { diffArtifact, type ArtifactDiff } from '../../chat/artifacts/artifactClient.js';
import type { DocumentVersion } from './documentsClient.js';

type Panel = { versionId: string; mode: 'view' } | { versionId: string; mode: 'compare'; diff: ArtifactDiff['diff'] | null; failed?: boolean };

export interface DocumentVersionHistoryProps {
  documentId: string;
  versions: DocumentVersion[];
  currentVersionId: string | undefined;
  /** The version the share link serves, when the document is approved. */
  publishedVersionId: string | undefined;
  /** Disables Restore while the editor holds unsaved text (restoring would
   *  replace the screen, and the user would lose that text). */
  dirty: boolean;
  busy: boolean;
  /** Restore writes a version; hidden for a caller without write access. */
  canWrite: boolean;
  onRestore: (version: DocumentVersion) => Promise<void>;
}

export default function DocumentVersionHistory(props: DocumentVersionHistoryProps): JSX.Element {
  const { t } = useTranslation('documents');
  const { documentId, versions, currentVersionId, publishedVersionId, dirty, busy, canWrite, onRestore } = props;
  const [panel, setPanel] = useState<Panel | null>(null);
  const headingId = useId();
  const dirtyHintId = useId();

  async function compare(v: DocumentVersion): Promise<void> {
    if (!currentVersionId) return;
    setPanel({ versionId: v.versionId, mode: 'compare', diff: null });
    try {
      const r = await diffArtifact(`document:${documentId}`, v.versionId, currentVersionId);
      setPanel((p) => (p && p.versionId === v.versionId && p.mode === 'compare' ? { ...p, diff: r.diff } : p));
    } catch {
      setPanel((p) => (p && p.versionId === v.versionId && p.mode === 'compare' ? { ...p, failed: true } : p));
    }
  }

  async function restore(v: DocumentVersion): Promise<void> {
    const ok = await confirm({
      title: t('restoreVersionConfirm', { version: formatNumber(v.version) }),
      body: t('restoreVersionBody'),
      confirmLabel: t('restoreVersion'),
    });
    if (!ok) return;
    await onRestore(v);
    setPanel(null);
  }

  return (
    <section className="u-grid u-gap-2" aria-labelledby={headingId}>
      <h2 id={headingId} className="u-label-sm u-m-0">{t('versionHistory')}</h2>
      {canWrite && dirty ? <p id={dirtyHintId} className="muted u-fs-13 u-m-0">{t('restoreDisabledDirty')}</p> : null}
      <ul className="u-grid u-gap-1 u-m-0 u-p-0 u-list-none">
        {versions.map((v) => {
          const isCurrent = v.versionId === currentVersionId;
          const isPublished = v.versionId === publishedVersionId;
          const open = panel?.versionId === v.versionId ? panel : null;
          const label = t('versionEntry', { version: formatNumber(v.version), date: formatDateTime(v.createdAt) });
          return (
            <li key={v.versionId} className="u-grid u-gap-1">
              <div className="u-flex u-items-center u-gap-1 u-wrap">
                <span className="u-label-sm">{label}</span>
                {isCurrent ? <span className="chip chip--muted u-fs-11">{t('versionCurrent')}</span> : null}
                {isPublished ? <span className="chip chip--success u-fs-11">{t('versionPublished')}</span> : null}
                {/* DOCTPL-2 — a human doc can carry agent-written revisions;
                    the history is where that distinction lives. */}
                {v.producedBy?.kind === 'agent' ? <span className="chip chip--ai u-fs-11">{t('draftedByAgent')}</span>
                  : v.producedBy?.kind === 'run' ? <span className="chip chip--ai u-fs-11">{t('generatedByWorkflow')}</span> : null}
                <span className="u-flex-1" />
                <Button
                  variant="quiet" size="sm"
                  aria-expanded={open?.mode === 'view'}
                  aria-label={t('viewVersionAria', { version: formatNumber(v.version) })}
                  onClick={() => setPanel(open?.mode === 'view' ? null : { versionId: v.versionId, mode: 'view' })}
                >{t('viewVersion')}</Button>
                {!isCurrent && currentVersionId ? (
                  <Button
                    variant="quiet" size="sm"
                    aria-expanded={open?.mode === 'compare'}
                    aria-label={t('compareVersionAria', { version: formatNumber(v.version) })}
                    onClick={() => (open?.mode === 'compare' ? setPanel(null) : void compare(v))}
                  >{t('compareVersion')}</Button>
                ) : null}
                {!isCurrent && canWrite ? (
                  <Button
                    variant="quiet" size="sm"
                    disabled={busy || dirty}
                    {...(dirty ? { 'aria-describedby': dirtyHintId } : {})}
                    aria-label={t('restoreVersionAria', { version: formatNumber(v.version) })}
                    onClick={() => void restore(v)}
                  >{t('restoreVersion')}</Button>
                ) : null}
              </div>
              {open?.mode === 'view' ? (
                <div className="md-editor-preview" role="region" aria-label={t('viewVersionAria', { version: formatNumber(v.version) })} tabIndex={0}>
                  {v.content.trim() ? <Markdown>{v.content}</Markdown> : <span className="muted u-fs-13">{t('previewEmpty')}</span>}
                </div>
              ) : null}
              {open?.mode === 'compare' ? (
                <div role="region" aria-label={t('compareVersionAria', { version: formatNumber(v.version) })} aria-busy={!open.diff && !open.failed}>
                  {open.failed ? <Notice variant="error" announce={t('compareFailed')}>{t('compareFailed')}</Notice>
                    : open.diff ? <ArtifactDiffView diff={open.diff} />
                      : <div role="status"><span className="sr-only">{t('common:loading')}</span><Skeleton width="80%" /></div>}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
