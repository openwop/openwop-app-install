/**
 * HistoryDrawer (ADR 0474 P1a-4) — the builder's revision-history panel:
 * newest-first list (relative time, name, node-count delta vs the superseded
 * row, Published/Current chips) with per-row Restore.
 *
 * Restore is the BULLETPROOF-BAR shape for a destructive-adjacent action:
 * a two-step confirm that PREVIEWS the change (node counts, and the server's
 * removed-referenced-node disclosure after the fact), and is itself undoable
 * by construction — history is append-only, so restoring the newer row back
 * is always one click away.
 */

import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StateCard } from '../ui/index.js';
import { HistoryIcon, RotateCcwIcon, XIcon } from '../ui/icons/index.js';
import { formatDate } from '../i18n/format.js';
import { drawerEscapeHandler } from './builderShellHelpers.js';
import { listWorkflowRevisions, rollbackWorkflow, type WorkflowRevisionRow } from '../workflows/workflowsClient.js';

export function HistoryDrawer({ workflowId, open, onClose, onRestored }: {
  workflowId: string;
  open: boolean;
  onClose(): void;
  /** The canvas must reload the restored head (the caller owns the store). */
  onRestored(): void;
}): JSX.Element | null {
  const { t } = useTranslation('builder');
  const rootRef = useRef<HTMLElement | null>(null);
  const [rows, setRows] = useState<WorkflowRevisionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    listWorkflowRevisions(workflowId)
      .then(setRows)
      .catch(() => setError(t('historyLoadFailed')));
  }, [workflowId, t]);
  useEffect(() => { if (open) { setRows(null); setNotice(null); setConfirming(null); load(); } }, [open, load]);
  // Grade-ux #6 — focus moves into the drawer when it OPENS (the menu that
  // launched it closes and would otherwise strand focus on <body>).
  useEffect(() => { if (open) rootRef.current?.focus(); }, [open]);

  if (!open) return null;

  async function restore(row: WorkflowRevisionRow): Promise<void> {
    setBusy(row.revisionHash);
    setError(null);
    try {
      const res = await rollbackWorkflow(workflowId, row.revisionHash);
      setNotice(res.removedReferencedNodeIds?.length
        ? t('historyRestoredWithRemoved', { count: res.removedReferencedNodeIds.length })
        : t('historyRestored'));
      setConfirming(null);
      load();
      onRestored();
    } catch {
      // Review L5 — machine codes (`rollback_409`) never reach the UI raw.
      setError(t('historyRestoreFailed'));
    } finally {
      setBusy(null);
    }
  }

  const head = rows?.find((r) => r.isHead);

  return (
    // Grade-ux #6 — house panel convention (the ReviewInboxPanel pattern):
    // Escape closes; focus moves into the drawer on open. eslint's
    // noninteractive heuristic is a false positive on the Escape handler.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <aside
      className="surface-card builder-history-drawer"
      aria-label={t('historyAria')}
      tabIndex={-1}
      ref={rootRef}
      onKeyDown={drawerEscapeHandler(onClose)}
    >
      <header className="u-flex u-items-center u-gap-2">
        <HistoryIcon size={16} />
        <h3 className="u-fs-13 u-m-0">{t('historyTitle')}</h3>
        <span className="review-card__spacer" />
        <Button variant="secondary" size="sm" onClick={onClose} aria-label={t('historyClose')}>
          <XIcon size={14} />
        </Button>
      </header>
      {notice ? <p className="alert success u-fs-12 u-m-0" role="status">{notice}</p> : null}
      {error ? <p className="alert error u-fs-12 u-m-0" role="alert">{error}</p> : null}
      {rows === null && !error ? <StateCard loading title={t('historyLoading')} /> : null}
      {rows !== null && rows.length === 0 ? <StateCard title={t('historyEmptyTitle')} body={t('historyEmptyBody')} /> : null}
      {rows !== null && rows.length > 0 ? (
        <ol className="builder-history-drawer__list" aria-label={t('historyTitle')}>
          {rows.map((r) => {
            const prev = rows.find((p) => p.revisionHash === r.supersedes);
            const delta = prev ? r.nodeCount - prev.nodeCount : null;
            return (
              <li key={r.revisionHash} className="builder-history-drawer__row">
                <div className="u-flex u-items-center u-gap-2 u-wrap">
                  <code className="builder-history-drawer__hash" title={r.revisionHash}>{r.revisionHash.slice(0, 8)}</code>
                  {r.isHead ? <span className="chip chip--accent u-fs-10">{t('historyCurrent')}</span> : null}
                  {r.published ? <span className="chip chip--muted u-fs-10">{t('historyPublished')}</span> : null}
                  <span className="muted u-fs-11">{formatDate(r.createdAt)}</span>
                </div>
                <div className="u-flex u-items-center u-gap-2 u-wrap u-fs-12">
                  <span>{r.name ?? workflowId}</span>
                  <span className="muted">
                    {t('historyNodeCount', { count: r.nodeCount })}
                    {delta !== null && delta !== 0 ? ` (${delta > 0 ? '+' : ''}${delta})` : ''}
                  </span>
                </div>
                {!r.isHead ? (
                  confirming === r.revisionHash ? (
                    <div className="u-flex u-items-center u-gap-2 u-wrap">
                      <span className="u-fs-11">{t('historyRestoreConfirm', { nodes: r.nodeCount, headNodes: head?.nodeCount ?? 0 })}</span>
                      <Button
                        variant="accent-solid" size="sm"
                        onClick={() => void restore(r)}
                        disabled={busy !== null}
                        aria-busy={busy === r.revisionHash}
                      >
                        {busy === r.revisionHash ? `${t('historyRestoreYes')}…` : t('historyRestoreYes')}
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => setConfirming(null)} disabled={busy !== null}>
                        {t('historyRestoreNo')}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="secondary" size="sm" className="u-flex u-items-center u-gap-2"
                      onClick={() => setConfirming(r.revisionHash)}
                      disabled={busy !== null}
                    >
                      <RotateCcwIcon size={13} /> {t('historyRestore')}
                    </Button>
                  )
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </aside>
  );
}
