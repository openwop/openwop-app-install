/**
 * Suppressions panel (ADR 0655 D10 — the EM-UX-5 / EM-UX-23 remedy).
 *
 * The send log has told operators a recipient was "suppressed (bounce/
 * unsubscribe)" since ADR 0217 and then offered no way to SEE the list, see why,
 * or release someone suppressed in error — seven routes with zero clients. This
 * is the first consumer: the tenant-wide list with kind / reason / date, a
 * search-by-address filter, and a Release action whose confirm names the
 * consequence.
 *
 * Release is offered on `manual` rows only. The server refuses to lift an
 * `unsubscribed` / `bounced` / `complaint` row from this route (ADR 0655 D3:
 * only the subject re-opting in lifts those) — so a button that would always
 * fail is replaced by the sentence saying who CAN lift it.
 *
 * Mounted lazily by the hub (inside a disclosure), so the read runs only when
 * the operator opens the section — the hub already fans out five reads on load.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { confirm } from '../../ui/confirm.js';
import { InlineState } from '../../ui/InlineState.js';
import { toast } from '../../ui/toast.js';
import { formatDateTime, formatRelativeTime } from '../../i18n/format.js';
import { listSuppressions, removeSuppression, type Suppression, type SuppressionReason } from './suppressionsClient.js';

const reasonChip = (r: SuppressionReason): string => (
  r === 'complaint' || r === 'bounced' ? 'chip chip--danger' : r === 'unsubscribed' ? 'chip chip--warning' : 'chip chip--muted'
);

export function SuppressionsPanel({ id }: { id: string }): JSX.Element {
  const { t } = useTranslation('email');
  // Tri-state: null = loading, 'error' = the read failed (never an empty
  // list — DESIGN.md §4.6 rule 2), array = the server's answer.
  const [rows, setRows] = useState<Suppression[] | null | 'error'>(null);
  const [query, setQuery] = useState('');
  const [releasing, setReleasing] = useState('');

  const load = useCallback(() => {
    setRows(null);
    let live = true;
    void listSuppressions()
      .then((list) => { if (live) setRows(list); })
      .catch(() => { if (live) setRows('error'); });
    return () => { live = false; };
  }, []);
  useEffect(() => load(), [load]);

  const visible = useMemo(() => {
    if (!Array.isArray(rows)) return [];
    const q = query.trim().toLowerCase();
    return q ? rows.filter((s) => s.email.includes(q)) : rows;
  }, [rows, query]);

  const release = useCallback(async (s: Suppression) => {
    const forced = s.reason !== 'manual';
    const ok = await confirm({
      title: t('suppressionReleaseTitle', { email: s.email }),
      body: forced ? t('suppressionReleaseForceBody', { reason: t(`suppressionReason_${s.reason}`) }) : t('suppressionReleaseBody'),
      confirmLabel: t('suppressionRelease'),
      danger: forced,
    });
    if (!ok) return;
    setReleasing(s.email);
    try {
      await removeSuppression(s.email, { force: forced });
      setRows((cur) => (Array.isArray(cur) ? cur.filter((r) => r.key !== s.key) : cur));
      toast.success(t('suppressionReleased', { email: s.email }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('suppressionReleaseFailed'));
    } finally {
      setReleasing('');
    }
  }, [t]);

  return (
    <div id={id} className="u-grid u-gap-2">
      <p className="muted u-fs-12 u-m-0">{t('suppressionsLede')}</p>
      {rows === null ? (
        <InlineState kind="loading" message={t('common:loading')} />
      ) : rows === 'error' ? (
        <InlineState
          kind="failed"
          message={t('suppressionsFailed')}
          announce={t('suppressionsFailed')}
          announcePolite
          action={<Button variant="quiet" size="sm" onClick={() => load()}>{t('common:retry')}</Button>}
        />
      ) : rows.length === 0 ? (
        <InlineState kind="empty" message={t('suppressionsEmpty')} />
      ) : (
        <>
          {/* One control + a count, not a group of facets — no `role="group"`. */}
          <div className="filterbar u-m-0">
            <input
              type="search"
              className="ui-input filterbar-search"
              placeholder={t('suppressionsFilterPlaceholder')}
              aria-label={t('suppressionsFilterAria')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span className="u-label-sm u-ml-auto">{t('suppressionsCount', { count: rows.length })}</span>
          </div>
          {visible.length === 0 ? (
            <InlineState
              kind="empty"
              message={t('suppressionsNoMatch')}
              action={<Button variant="quiet" size="sm" onClick={() => setQuery('')}>{t('clearSearch')}</Button>}
            />
          ) : visible.map((s) => (
            <div key={s.key} className="surface-inset u-flex u-gap-2 u-items-center u-wrap">
              <code className="u-flex-1">{s.email}</code>
              <span className={reasonChip(s.reason)}>{t(`suppressionReason_${s.reason}`)}</span>
              {s.note ? <span className="muted u-fs-12">{s.note}</span> : null}
              <span className="muted u-fs-12" title={formatDateTime(s.at)}>{t('suppressionAddedAt', { when: formatRelativeTime(s.at) })}</span>
              <Button
                variant="quiet"
                size="sm"
                disabled={releasing !== ''}
                aria-label={t('suppressionReleaseTitle', { email: s.email })}
                onClick={() => void release(s)}
              >{releasing === s.email ? t('common:loading') : t('suppressionRelease')}</Button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
