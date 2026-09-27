/**
 * KickTodo "Today" tile (ADR 0452) — the participant's next incomplete action
 * (the RFC 0436 One Thing) across their active enrollments, a projection over
 * the EXISTING `kicktodoClient.getToday()`. Owns no data (ADR 0082); read-only,
 * deep-links to `/today` where the check-in happens. Toggle-gated
 * (`kicktodo-core`) so it is absent when KickTodo is off.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { getToday, type TodayView } from '../../../client/kicktodoClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import type { DashboardTileProps } from '../tileTypes.js';

interface NextItem { cardId: string; title: string }

/** The next incomplete action across ACTIVE enrollments (the "One Thing"),
 *  plus how many remain today — a pure derivation of the Today view. */
function deriveToday(view: TodayView): { next: NextItem | null; remaining: number } {
  const open: NextItem[] = [];
  for (const e of view.enrollments) {
    if (e.state !== 'active') continue;
    for (const a of e.actions) {
      if (a.card && !a.card.completed) open.push({ cardId: a.card.id, title: a.card.title });
    }
  }
  return { next: open[0] ?? null, remaining: open.length };
}

export default function KickTodoTodayTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const [view, setView] = useState<TodayView | null>(null);
  const [state, setState] = useState<'ok' | 'error' | 'signed-out'>('ok');

  useEffect(() => {
    let live = true;
    getToday()
      .then((v) => { if (live) setView(v); })
      .catch((e: unknown) => {
        if (!live) return;
        // An auth-gated read (401/403 for anon demo sessions) is a quiet sign-in
        // hint, never a broken-looking error tile (the TodosTile posture).
        setState(/\b40[13]\b/.test(e instanceof Error ? e.message : '') ? 'signed-out' : 'error');
      });
    return () => { live = false; };
  }, []);

  if (view === null && state === 'ok') return <SkeletonRows rows={compact ? 2 : 3} columns={['70%', '40%']} />;
  if (state === 'signed-out') return <p className="dash-tile__state muted">{t('kicktodoSignedOut')}</p>;
  if (state === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;

  const { next, remaining } = deriveToday(view!);
  if (!next) return <p className="dash-tile__state muted">{t('kicktodoTodayEmpty')}</p>;

  return (
    <div className="dash-tile__body">
      <Link to="/today" className="dash-tile__row-main u-truncate" title={next.title}>{next.title}</Link>
      <p className="dash-tile__row-meta muted u-m-0">
        {remaining > 1 ? t('kicktodoTodayMore', { count: remaining - 1 }) : t('kicktodoTodayLast')}
      </p>
    </div>
  );
}
