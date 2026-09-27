/**
 * My to-dos tile (ADR 0375 Phase 3) — the caller's "assigned to me" agent-board
 * cards (ADR 0049), a projection over the EXISTING kanban client. Owns no data
 * (ADR 0082). Caller-scoped (no org). Admin-tier: the rows link to `/boards`,
 * a core admin-tier route.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { listAssignedToMe, type AssignedCard } from '../../../kanban/kanbanClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatRelativeTime } from '../../../i18n/format.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function TodosTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const [cards, setCards] = useState<AssignedCard[] | null>(null);
  const [state, setState] = useState<'ok' | 'error' | 'signed-out'>('ok');

  useEffect(() => {
    let live = true;
    listAssignedToMe()
      .then((c) => { if (live) setCards(c.filter((x) => !x.terminal).slice(0, compact ? 4 : 8)); })
      .catch((e: unknown) => {
        if (!live) return;
        setCards([]);
        // /kanban/assigned requires a DURABLE signed-in account (401 for anon
        // demo sessions) — an auth-gated read is a quiet sign-in hint, never an
        // error (the home page must not open with a broken-looking tile).
        setState(/\b40[13]\b/.test(e instanceof Error ? e.message : '') ? 'signed-out' : 'error');
      });
    return () => { live = false; };
  }, [compact]);

  if (cards === null) return <SkeletonRows rows={compact ? 3 : 5} columns={['70%', '50%', '55%']} />;
  if (state === 'signed-out') return <p className="dash-tile__state muted">{t('todosSignedOut')}</p>;
  if (state === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;
  if (cards.length === 0) return <p className="dash-tile__state muted">{t('todosEmpty')}</p>;

  return (
    <ul className="dash-tile__list u-list-none u-m-0 u-p-0">
      {cards.map((c) => (
        <li key={c.id} className="dash-tile__row">
          <Link to="/boards" className="dash-tile__row-main u-truncate" title={c.title}>{c.title}</Link>
          {c.dueAt ? <span className="dash-tile__row-meta muted">{formatRelativeTime(c.dueAt)}</span> : <span className="dash-tile__row-meta muted">{c.boardName}</span>}
        </li>
      ))}
    </ul>
  );
}
