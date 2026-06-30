/**
 * Workforces gallery — the trust-journey view.
 *
 * A workforce is a TEAM of AI agents running a whole business function, earning
 * the right to run it on its own. Each card leads with the plain job, the
 * autonomy track (Watching → Assisting → Running on its own), and one headline
 * outcome — not governance jargon. The key-figure tiles double as filters for
 * what needs a human (DESIGN.md §4.5 rule 2); per-workforce metrics + governance
 * are fetched best-effort.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../ui/PageHeader.js';
import { StateCard } from '../ui/StateCard.js';
import { Skeleton } from '../ui/Skeleton.js';
import { Notice } from '../ui/Notice.js';
import { KeyFigureBand } from '../ui/KeyFigure.js';
import { BoxesIcon, AlertIcon } from '../ui/icons/index.js';
import { IllustrativeBadge } from '../ui/IllustrativeBadge.js';
import { ViewToggle, useViewMode } from '../ui/ViewToggle.js';
import { WorkforceCard, WorkforceRow, type WfSignals } from './WorkforceViews.js';
import {
  getWorkforceGovernance,
  getWorkforceMetrics,
  listWorkforces,
  type Workforce,
} from '../client/workforcesClient.js';

interface WfRow {
  wf: Workforce;
  signals: WfSignals | null; // null when metrics + governance both failed
}

type FilterKey = 'all' | 'approvals' | 'eligible' | 'violations';

function rowMatches(row: WfRow, filter: FilterKey): boolean {
  if (filter === 'all') return true;
  const s = row.signals;
  if (!s) return false;
  if (filter === 'approvals') return s.openApprovals > 0;
  if (filter === 'eligible') return s.eligible;
  return s.policyViolations > 0; // violations
}

export function WorkforcesGalleryPage(): JSX.Element {
  const { t } = useTranslation('workforces');
  const navigate = useNavigate();
  const [rows, setRows] = useState<WfRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [showcase, setShowcase] = useState(false);
  const [viewMode, setViewMode] = useViewMode('workforces', 'grid');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listWorkforces()
      .then(async (wf) => {
        const built = await Promise.all(
          wf.map(async (w): Promise<WfRow> => {
            const [m, g] = await Promise.all([
              getWorkforceMetrics(w.workforceId).catch(() => null),
              getWorkforceGovernance(w.workforceId).catch(() => null),
            ]);
            const signals: WfSignals | null = m || g ? {
              openApprovals: m?.openApprovals ?? 0,
              eligible: g?.autonomy.eligibleForNext ?? false,
              policyViolations: m?.policyViolations ?? g?.posture.policyViolations ?? 0,
              handledShare: m && m.totalRuns > 0 ? Math.max(0, 1 - m.escalationRate) : null,
            } : null;
            if ((m?.source ?? g?.source) === 'showcase' && (m?.totalRuns ?? 0) > 0 && !cancelled) setShowcase(true);
            return { wf: w, signals };
          }),
        );
        if (!cancelled) { setRows(built); setError(null); }
      })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const figures = {
    all: rows.length,
    approvals: rows.filter((r) => (r.signals?.openApprovals ?? 0) > 0).length,
    eligible: rows.filter((r) => r.signals?.eligible).length,
    violations: rows.filter((r) => (r.signals?.policyViolations ?? 0) > 0).length,
  };
  const haveSignals = rows.some((r) => r.signals !== null);
  const nothingNeedsYou = haveSignals && figures.approvals === 0 && figures.eligible === 0 && figures.violations === 0;
  const visible = rows.filter((r) => rowMatches(r, filter));

  return (
    <div>
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('galleryTitle')}
        lede={t('galleryLede')}
      />

      {error ? <Notice variant="error">{t('loadError', { error })}</Notice> : null}

      {showcase ? (
        <Notice variant="info">
          <IllustrativeBadge detail={t('showcaseBadgeDetail')} /> {t('galleryShowcaseLead')}{' '}
          <strong>{t('showcaseWord')}</strong> {t('galleryShowcaseTail')}
        </Notice>
      ) : null}

      {loading ? (
        <div className="card-grid">
          <Skeleton height={180} />
          <Skeleton height={180} />
        </div>
      ) : !error && rows.length === 0 ? (
        <StateCard
          icon={<BoxesIcon />}
          title={t('noneTitle')}
          body={t('noneBody')}
          action={<button type="button" className="btn-accent-solid" onClick={() => navigate('/example-data')}>{t('loadExampleData')}</button>}
        />
      ) : (
        <>
          {/* Key figures double as the filter for what needs a human (§4.5 r2). */}
          <KeyFigureBand
            ariaLabel={t('filterAriaLabel')}
            activeKey={filter}
            onToggle={(key) => setFilter(key as FilterKey)}
            figures={([
              ['all', t('figureWorkforces'), figures.all, false],
              ['approvals', t('figureAwaitingApproval'), figures.approvals, true],
              ['eligible', t('figureReadyForMore'), figures.eligible, false],
              ['violations', t('figurePolicyIssues'), figures.violations, true],
            ] as const).map(([key, label, n, attn]) => {
              const attentive = attn && n > 0;
              return {
                key,
                label,
                value: n,
                ...(attentive ? { tone: 'attention' as const, glyph: <AlertIcon size={11} aria-hidden /> } : {}),
              };
            })}
          />

          {filter === 'all' && nothingNeedsYou ? (
            <Notice variant="success">{t('allClear')}</Notice>
          ) : null}

          {/* The collection-view canon (§4.5 r11): the shared toggle lives at
              the end of the one filterbar row, right-aligned. The key-figure
              band above is the page's filter (r2); this row just switches the
              grid/list rendering. */}
          <div className="filterbar">
            <ViewToggle value={viewMode} onChange={setViewMode} className="u-ml-auto" />
          </div>

          {visible.length === 0 ? (
            <StateCard
              icon={<BoxesIcon />}
              title={t('emptyFilterTitle')}
              body={t('emptyFilterBody')}
              action={<button type="button" className="secondary" onClick={() => setFilter('all')}>{t('showAll')}</button>}
            />
          ) : viewMode === 'grid' ? (
            <div className="card-grid">
              {visible.map(({ wf, signals }) => (
                <WorkforceCard key={wf.workforceId} wf={wf} signals={signals} />
              ))}
            </div>
          ) : (
            <div className="surface-card list-view">
              {visible.map(({ wf, signals }) => (
                <WorkforceRow key={wf.workforceId} wf={wf} signals={signals} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
