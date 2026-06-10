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
import { Link, useNavigate } from 'react-router-dom';
import { PageHeader } from '../ui/PageHeader.js';
import { StateCard } from '../ui/StateCard.js';
import { Skeleton } from '../ui/Skeleton.js';
import { Notice } from '../ui/Notice.js';
import { BoxesIcon, AlertIcon } from '../ui/icons/index.js';
import { IllustrativeBadge } from '../ui/IllustrativeBadge.js';
import { AutonomyTrack } from './AutonomyTrack.js';
import {
  getWorkforceGovernance,
  getWorkforceMetrics,
  listWorkforces,
  type Workforce,
} from '../client/workforcesClient.js';

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** What needs a human + the headline outcome, per workforce. */
interface WfSignals {
  openApprovals: number;
  eligible: boolean;
  policyViolations: number;
  /** Share cleared without escalating to a human (1 − escalationRate); null = no runs. */
  handledShare: number | null;
}
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
  const navigate = useNavigate();
  const [rows, setRows] = useState<WfRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [showcase, setShowcase] = useState(false);

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
        eyebrow="Workforces"
        title="Your AI workforces"
        lede="Each workforce is a team of AI agents running a whole business function — and earning the right to run it on its own. See where each one is on that journey, and what still needs you."
      />

      {error ? <Notice variant="error">Couldn't load workforces: {error}</Notice> : null}

      {showcase ? (
        <Notice variant="info">
          <IllustrativeBadge detail="Synthetic showcase data — not derived from your runs" /> These are
          built-in <strong>showcase</strong> workforces so you can explore. Run your own (or load demo data) to see your real numbers.
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
          title="No workforces yet"
          body="Load the demo data to explore sample workforces with weeks of run history."
          action={<button type="button" className="btn-accent-solid" onClick={() => navigate('/demo-data')}>Load demo data</button>}
        />
      ) : (
        <>
          {/* Key figures double as the filter for what needs a human (§4.5 r2). */}
          <div className="wf-figures" role="group" aria-label="What needs you — click to filter">
            {([
              ['all', 'Workforces', figures.all, false],
              ['approvals', 'Awaiting approval', figures.approvals, true],
              ['eligible', 'Ready for more autonomy', figures.eligible, false],
              ['violations', 'Policy issues', figures.violations, true],
            ] as const).map(([key, label, n, attn]) => (
              <button
                type="button"
                key={key}
                className={'wf-figure wf-figure--tile' + (filter === key ? ' is-active' : '') + (attn && n > 0 ? ' is-attn' : '')}
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                <span className="wf-figure-n">{n}</span>
                <span className="wf-figure-l">
                  {attn && n > 0 ? <AlertIcon size={11} aria-hidden /> : null}
                  {label}
                </span>
              </button>
            ))}
          </div>

          {filter === 'all' && nothingNeedsYou ? (
            <Notice variant="success">Every workforce is within policy — nothing needs your attention right now.</Notice>
          ) : null}

          {visible.length === 0 ? (
            <StateCard
              icon={<BoxesIcon />}
              title="Nothing here right now"
              body="No workforce is in that state."
              action={<button type="button" className="secondary" onClick={() => setFilter('all')}>Show all</button>}
            />
          ) : (
            <div className="card-grid">
              {visible.map(({ wf, signals }) => (
                <Link
                  key={wf.workforceId}
                  to={`/workforces/${encodeURIComponent(wf.workforceId)}`}
                  className="surface-card wfgallery-card-link"
                >
                  <div className="action-bar u-justify-between u-items-baseline">
                    <h3 className="u-m-0">{wf.name}</h3>
                    <span className="muted u-fs-13 u-nowrap">{wf.agents.length} agents</span>
                  </div>
                  <p className="wfgallery-statement">{wf.purpose.statement}</p>

                  <AutonomyTrack status={wf.status} compact />

                  {signals == null ? null /* couldn't load — don't claim a state */
                    : signals.handledShare === null ? (
                      <p className="muted wfgallery-noruns">No runs yet</p>
                    ) : (
                      <div>
                        <span className="wf-outcome-n">{pct(signals.handledShare)}</span>
                        <span className="wf-outcome-l wfgallery-outcome-inline">cleared without escalation</span>
                      </div>
                    )}

                  {signals && (signals.openApprovals > 0 || signals.eligible || signals.policyViolations > 0) ? (
                    <div className="action-bar u-gap-2 u-wrap u-mt-1-5">
                      {signals.openApprovals > 0 ? (
                        <span className="chip chip--warning"><AlertIcon size={12} /> {signals.openApprovals} awaiting approval</span>
                      ) : null}
                      {signals.eligible ? (
                        <span className="chip chip--success">ready for more autonomy</span>
                      ) : null}
                      {signals.policyViolations > 0 ? (
                        <span className="chip chip--danger"><AlertIcon size={12} /> {signals.policyViolations} policy issues</span>
                      ) : null}
                    </div>
                  ) : null}
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
