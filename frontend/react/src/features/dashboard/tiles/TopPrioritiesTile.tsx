/**
 * Top priorities tile (ADR 0375 Phase 3) — the highest-priority ideas across the
 * caller's portfolio, over the EXISTING priority-matrix client (`listPortfolio`,
 * which carries a real `topN` limit and an OPTIONAL org — so this tile is
 * caller-scoped, no org resolution needed). Admin-tier, gated by the
 * `priority-matrix` toggle. Owns no data (ADR 0082).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { listPortfolio, type PortfolioItem } from '../../priority-matrix/priorityMatrixClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function TopPrioritiesTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const [items, setItems] = useState<PortfolioItem[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let live = true;
    listPortfolio(compact ? 5 : 8)
      .then((r) => { if (live) setItems(r.items); })
      .catch(() => { if (live) { setItems([]); setError(true); } });
    return () => { live = false; };
  }, [compact]);

  if (items === null) return <SkeletonRows rows={compact ? 3 : 5} columns={['70%', '25%']} />;
  if (error) return <p className="dash-tile__state muted">{t('tileError')}</p>;
  if (items.length === 0) return <p className="dash-tile__state muted">{t('prioritiesEmpty')}</p>;

  return (
    <ol className="dash-tile__list u-list-none u-m-0 u-p-0">
      {items.map((it) => (
        <li key={it.cardId} className="dash-tile__row">
          <Link to="/priority-matrix" className="dash-tile__row-main u-truncate" title={it.title}>{it.title}</Link>
          <span className="dash-tile__row-meta muted">{it.listName}</span>
        </li>
      ))}
    </ol>
  );
}
