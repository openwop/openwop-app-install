/**
 * Email template version history (ADR 0905 D1) — the immutable versions of one
 * template: view a version, compare it with the current one, restore it.
 *
 * Restore writes a NEW version copying the old content; history is never rewritten.
 * The comparison is computed server-side by the one text differ (`host/textDiff.ts`)
 * and rendered by the shared `ArtifactDiffView` — the `DocumentVersionHistory`
 * precedent, not a second diff.
 */
import { useCallback, useEffect, useId, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Notice, Skeleton } from '../../ui/index.js';
import { confirm } from '../../ui/confirm.js';
import { formatDateTime, formatNumber } from '../../i18n/format.js';
import { ArtifactDiffView } from '../../chat/artifacts/ArtifactDiffView.js';
import { diffTemplateVersion, listTemplateVersions, type EmailTemplateVersion, type EmailTemplateVersionDiff } from './emailClient.js';

type Panel = { version: number; mode: 'view' } | { version: number; mode: 'compare'; diff: EmailTemplateVersionDiff | null; failed?: boolean };

export interface EmailTemplateVersionHistoryProps {
  orgId: string;
  templateId: string;
  /** The template's current version; a change re-reads the list. */
  currentVersion: number;
  /** Restore is disabled while the editor holds unsaved edits (it would replace them). */
  dirty: boolean;
  busy: boolean;
  onRestore: (version: number) => Promise<void>;
}

export function EmailTemplateVersionHistory(props: EmailTemplateVersionHistoryProps): JSX.Element {
  const { t } = useTranslation('email');
  const { orgId, templateId, currentVersion, dirty, busy, onRestore } = props;
  const [versions, setVersions] = useState<EmailTemplateVersion[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const headingId = useId();
  const dirtyHintId = useId();

  useEffect(() => {
    let live = true;
    setFailed(false);
    void listTemplateVersions(orgId, templateId)
      .then((v) => { if (live) setVersions(v); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [orgId, templateId, currentVersion]);

  const compare = useCallback(async (version: number) => {
    setPanel({ version, mode: 'compare', diff: null });
    try {
      const diff = await diffTemplateVersion(orgId, templateId, version);
      setPanel((p) => (p && p.version === version && p.mode === 'compare' ? { ...p, diff } : p));
    } catch {
      setPanel((p) => (p && p.version === version && p.mode === 'compare' ? { ...p, failed: true } : p));
    }
  }, [orgId, templateId]);

  const restore = useCallback(async (version: number) => {
    const ok = await confirm({
      title: t('restoreVersionConfirm', { version: formatNumber(version) }),
      body: t('restoreVersionBody'),
      confirmLabel: t('restoreVersion'),
    });
    if (!ok) return;
    await onRestore(version);
    setPanel(null);
  }, [onRestore, t]);

  return (
    <section className="surface-card u-gap-2" aria-labelledby={headingId}>
      <h2 id={headingId} className="u-fs-16 u-m-0">{t('versionHistory')}</h2>
      {dirty ? <p id={dirtyHintId} className="muted u-fs-13 u-m-0">{t('restoreDisabledDirty')}</p> : null}
      {failed ? <Notice variant="error" announce={t('versionsLoadFailed')}>{t('versionsLoadFailed')}</Notice> : null}
      {!versions && !failed ? <div role="status"><span className="sr-only">{t('common:loading')}</span><Skeleton width="60%" /></div> : null}
      {versions ? (
        <ul className="u-grid u-gap-1 u-m-0 u-p-0 u-list-none">
          {versions.map((v) => {
            const isCurrent = v.version === currentVersion;
            const open = panel?.version === v.version ? panel : null;
            return (
              <li key={v.version} className="u-grid u-gap-1">
                <div className="u-flex u-items-center u-gap-1 u-wrap">
                  <span className="u-label-sm">{t('versionEntry', { version: formatNumber(v.version), date: formatDateTime(v.createdAt) })}</span>
                  {isCurrent ? <span className="chip chip--muted u-fs-11">{t('versionCurrent')}</span> : null}
                  {v.restoredFrom ? <span className="chip chip--muted u-fs-11">{t('versionRestoredFrom', { version: formatNumber(v.restoredFrom) })}</span> : null}
                  <span className="u-flex-1" />
                  <Button variant="quiet" size="sm" aria-expanded={open?.mode === 'view'}
                    aria-label={t('viewVersionAria', { version: formatNumber(v.version) })}
                    onClick={() => setPanel(open?.mode === 'view' ? null : { version: v.version, mode: 'view' })}>{t('viewVersion')}</Button>
                  {!isCurrent ? (
                    <Button variant="quiet" size="sm" aria-expanded={open?.mode === 'compare'}
                      aria-label={t('compareVersionAria', { version: formatNumber(v.version) })}
                      onClick={() => (open?.mode === 'compare' ? setPanel(null) : void compare(v.version))}>{t('compareVersion')}</Button>
                  ) : null}
                  {!isCurrent ? (
                    <Button variant="quiet" size="sm" disabled={busy || dirty}
                      {...(dirty ? { 'aria-describedby': dirtyHintId } : {})}
                      aria-label={t('restoreVersionAria', { version: formatNumber(v.version) })}
                      onClick={() => void restore(v.version)}>{t('restoreVersion')}</Button>
                  ) : null}
                </div>
                {open?.mode === 'view' ? (
                  <div className="u-grid u-gap-1" role="region" aria-label={t('viewVersionAria', { version: formatNumber(v.version) })}>
                    <span className="u-fs-13"><strong>{t('editorSubjectLabel')}:</strong> {v.subject}</span>
                    <pre className="u-fs-13 u-m-0 u-prewrap">{v.body}</pre>
                  </div>
                ) : null}
                {open?.mode === 'compare' ? (
                  <div className="u-grid u-gap-1" role="region" aria-label={t('compareVersionAria', { version: formatNumber(v.version) })} aria-busy={!open.diff && !open.failed}>
                    {open.failed ? <Notice variant="error" announce={t('compareFailed')}>{t('compareFailed')}</Notice>
                      : open.diff ? (
                        <>
                          {open.diff.subject.changed
                            ? <span className="u-fs-13">{t('compareSubjectChanged', { from: open.diff.subject.from, to: open.diff.subject.to })}</span>
                            : <span className="muted u-fs-13">{t('compareSubjectSame')}</span>}
                          <ArtifactDiffView diff={open.diff.body} />
                        </>
                      ) : <div role="status"><span className="sr-only">{t('common:loading')}</span><Skeleton width="80%" /></div>}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
