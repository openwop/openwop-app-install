/**
 * ADR 1054 review (WEB86-14 / WEB-19) — the people behind the "not on Zoom yet" count.
 *
 * A registrant Zoom keeps refusing (an invalid email, say) used to sit behind the count
 * forever: the page never said who it was, and nothing could take it out. This lists the
 * queue (masked emails, Zoom's last answer, attempts) and offers one way out: remove the
 * pending push. The person stays registered in the CRM; only the Zoom push is dropped.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { toast } from '../../ui/toast.js';
import { confirm } from '../../ui/confirm.js';
import { listPendingRegistrants, removePendingRegistrant, WebinarsApiError, type PendingRegistrant } from './webinarsClient.js';

export function QueuedRegistrants({ orgId, eventId, describeReason, onChanged, refreshKey }: {
  orgId: string;
  eventId: string;
  /** The page's reason wording (one table for push, sync and this list). */
  describeReason: (raw: string) => string;
  onChanged: () => void;
  /** Bumped by the page after a push, so an open list shows what is still waiting (WEB86-18). */
  refreshKey: number;
}): JSX.Element {
  const { t } = useTranslation('webinars');
  const [rows, setRows] = useState<{ total: number; items: PendingRegistrant[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [removing, setRemoving] = useState('');

  const load = useCallback(async () => {
    setFailed(false);
    try { setRows(await listPendingRegistrants(orgId, eventId)); } catch { setFailed(true); }
  }, [orgId, eventId]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  /** Who a row is, for the confirm and the button's accessible name. */
  const who = (r: PendingRegistrant): string => (r.name ? `${r.name} (${r.email})` : r.email);

  // WEB86-17 — the only destructive action on the page asks first (the shared dialog).
  const remove = async (row: PendingRegistrant): Promise<void> => {
    const ok = await confirm({ title: t('queuedRemoveConfirmTitle', { who: who(row) }), body: t('queuedRemoveConfirmBody'), confirmLabel: t('queuedRemove'), danger: true });
    if (!ok) return;
    setRemoving(row.pendingId);
    try {
      await removePendingRegistrant(orgId, eventId, row.pendingId);
      toast.success(t('queuedRemoved'));
      await load();
      onChanged();
    } catch (e) {
      // WEB86-19 — the known refusals in the page's words, not the server's English.
      if (e instanceof WebinarsApiError && e.code === 'not_found') { toast.info(t('queuedGone')); await load(); onChanged(); }
      else if (e instanceof WebinarsApiError && e.code === 'forbidden_scope') toast.error(t('queuedNoPermission'));
      else toast.error(t('actionFailed'));
    }
    finally { setRemoving(''); }
  };

  if (failed) {
    return (
      <div className="u-flex u-gap-2 u-items-center">
        <span className="u-fs-13 u-text-warning">{t('queuedLoadFailed')}</span>
        <Button variant="quiet" size="sm" onClick={() => void load()}>{t('common:retry')}</Button>
      </div>
    );
  }
  if (rows === null) return <span className="u-fs-13 u-text-muted">{t('queuedLoading')}</span>;
  return (
    <div className="u-grid u-gap-2">
      <ul className="u-grid u-gap-1 u-list-none u-p-0 u-m-0">
        {rows.items.map((r) => (
          <li key={r.pendingId} className="u-flex u-items-center u-gap-2 u-flex-wrap">
            <span className="u-fs-13">{r.name ? <><strong>{r.name}</strong> · {r.email}</> : r.email}</span>
            <span className="u-fs-12 u-text-muted">
              {r.attempts > 0 ? t('queuedAttempts', { count: r.attempts }) : t('queuedNotTried')}
              {r.lastError ? ` · ${describeReason(r.lastError)}` : ''}
            </span>
            <Button variant="quiet" size="sm" disabled={removing === r.pendingId} aria-busy={removing === r.pendingId}
              aria-label={t('queuedRemoveLabel', { who: who(r) })} onClick={() => void remove(r)}>
              {t('queuedRemove')}
            </Button>
          </li>
        ))}
      </ul>
      {rows.total > rows.items.length ? <span className="u-fs-12 u-text-muted">{t('queuedMore', { shown: rows.items.length, total: rows.total })}</span> : null}
    </div>
  );
}
