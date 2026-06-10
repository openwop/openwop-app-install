/**
 * Workforce overview — the trust-journey view.
 *
 * Leads with the plain story: what this team of AI agents does, where it is on
 * its journey to running on its own (the autonomy track), what still needs a
 * human, and what it's actually delivered. The governance machinery (the 8-metric
 * grid, graduation curve, posture log, policy/boundaries, agent cluster) is real
 * and kept — demoted into a collapsible "Evidence & details" section so the page
 * sells the value before it shows the proof.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '../ui/PageHeader.js';
import { StateCard } from '../ui/StateCard.js';
import { Skeleton } from '../ui/Skeleton.js';
import { Notice } from '../ui/Notice.js';
import { AlertIcon, ArrowLeftIcon, BotIcon, BoxesIcon, ShieldIcon, UserIcon } from '../ui/icons/index.js';
import { TraceSearchPanel } from './TraceSearchPanel.js';
import { AutonomyTrack } from './AutonomyTrack.js';
import { JOURNEY, autonomyLabel, journeyGloss, journeyIndex } from './labels.js';
import { IllustrativeBadge } from '../ui/IllustrativeBadge.js';
import { useFeatureVisible } from '../featureToggles/FeatureAccessContext.js';
import {
  getWorkforce,
  getWorkforceGovernance,
  getWorkforceMetrics,
  updateWorkforceStatus,
  type Workforce,
  type WorkforceAgentSpec,
  type WorkforceGovernance,
  type WorkforceMetrics,
  type WorkforceStatus,
} from '../client/workforcesClient.js';

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}
function pctRound(n: number): string {
  return `${Math.round(n * 100)}%`;
}
function duration(ms: number | null): string {
  if (ms === null) return '—';
  const h = ms / 3_600_000;
  if (h >= 1) return `${h.toFixed(1)} h`;
  const m = ms / 60_000;
  if (m >= 1) return `${m.toFixed(1)} min`;
  return `${(ms / 1000).toFixed(1)} s`;
}
function usd(n: number | null): string {
  return n === null ? '—' : `$${n.toFixed(4)}`;
}

/** Role differentiates by glyph, never by color (DESIGN.md §5.4). */
function RoleGlyph({ role }: { role: WorkforceAgentSpec['role'] }): JSX.Element {
  if (role === 'supervisor') return <UserIcon size={12} />;
  if (role === 'governance') return <ShieldIcon size={12} />;
  return <BotIcon size={12} />;
}

function Outcome({ n, l }: { n: string; l: string }): JSX.Element {
  return (
    <div>
      <div className="wf-outcome-n">{n}</div>
      <div className="wf-outcome-l">{l}</div>
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }): JSX.Element {
  return (
    <div className="surface-card u-minw-0">
      <div className="chip chip--muted u-mb-1-5">{label}</div>
      <div className="wforce-metric-val">{value}</div>
      {hint ? <div className="muted u-fs-14">{hint}</div> : null}
    </div>
  );
}

export function WorkforceOverviewPage(): JSX.Element {
  const { workforceId = '' } = useParams();
  const navigate = useNavigate();
  // The "Review in Inbox" deep-link targets /inbox, which is gated on the
  // `notifications` toggle (ADR 0010). Hide the button when the feature is off
  // so it doesn't route to a surface whose bell + nav are hidden.
  const isVisible = useFeatureVisible();
  const [wf, setWf] = useState<Workforce | null>(null);
  const [metrics, setMetrics] = useState<WorkforceMetrics | null>(null);
  const [governance, setGovernance] = useState<WorkforceGovernance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [cutoverBusy, setCutoverBusy] = useState(false);
  const [cutoverError, setCutoverError] = useState<string | null>(null);

  async function cutOver(status: WorkforceStatus): Promise<void> {
    setCutoverBusy(true);
    setCutoverError(null);
    try {
      const updated = await updateWorkforceStatus(workforceId, status);
      setWf(updated);
    } catch (e: unknown) {
      setCutoverError(e instanceof Error ? e.message : String(e));
    } finally {
      setCutoverBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      getWorkforce(workforceId),
      getWorkforceMetrics(workforceId).catch(() => null),
      getWorkforceGovernance(workforceId).catch(() => null),
    ])
      .then(([w, m, g]) => {
        if (cancelled) return;
        if (!w) { setNotFound(true); return; }
        setWf(w); setMetrics(m); setGovernance(g); setError(null);
      })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workforceId]);

  const back = <Link to="/workforces" className="chip"><ArrowLeftIcon size={13} /> All workforces</Link>;

  if (loading) {
    return <div><PageHeader eyebrow="Workforce" title="Loading…" actions={back} /><Skeleton height={120} /></div>;
  }
  if (notFound) {
    return (
      <div>
        <PageHeader eyebrow="Workforce" title="Not found" actions={back} />
        <StateCard icon={<BoxesIcon />} title="Workforce not found" body={`No workforce "${workforceId}".`} action={back} />
      </div>
    );
  }
  if (error || !wf) {
    return <div><PageHeader eyebrow="Workforce" title="Couldn't load" actions={back} /><Notice variant="error">{error ?? 'Unknown error'}</Notice></div>;
  }

  const idx = journeyIndex(wf.status);
  const next = JOURNEY[idx + 1];
  const prev = idx > 0 ? JOURNEY[idx - 1] : null;
  const tier = governance?.autonomy.currentTier ?? null;
  const productionGated = next?.status === 'production' && tier !== 'auto';
  const hasRuns = !!metrics && metrics.totalRuns > 0;
  const isShowcase = (metrics?.source ?? governance?.source) === 'showcase' && hasRuns;

  return (
    <div>
      <PageHeader
        eyebrow="Workforce"
        title={wf.name}
        lede={wf.purpose.statement}
        actions={
          <span className="action-bar u-gap-2">
            {back}
            <Link to={`/workforces/${encodeURIComponent(workforceId)}/migrate`} className="btn">Set-up guide →</Link>
          </span>
        }
      />

      {isShowcase ? (
        <Notice variant="info">
          <IllustrativeBadge detail="Synthetic showcase data — not derived from your runs" /> Showing built-in
          <strong> showcase data</strong>. Run this workforce yourself (or load demo data) to populate your own numbers.
        </Notice>
      ) : null}

      {/* HERO — where it is on the trust journey + the one forward action. */}
      <section className="surface-card u-mb-4">
        <div className="chip chip--muted">{wf.agents.length}-agent team · {wf.businessFunction}</div>
        <AutonomyTrack status={wf.status} />
        <p className="wf-gate">{journeyGloss(wf.status)}</p>

        {next ? (
          <>
            {productionGated ? (
              <p className="wf-gate">
                To let it <strong>run on its own</strong>, it needs to prove itself first
                {metrics ? <> — a human still steps in on <strong>{pct(metrics.overrideRate)}</strong> of runs</> : null}.
              </p>
            ) : null}
            {/* Cut-over mutates the GLOBAL workforce entity (shared across
                visitors), so it is read-only on illustrative showcase data —
                you manage your own, not the demo's. */}
            {isShowcase ? (
              <p className="muted u-mbox-t2 u-fs-14">
                Showcase data — autonomy controls are read-only here. Run your own workforce to manage it.
              </p>
            ) : (
              <div className="action-bar u-gap-2 u-wrap u-mt-2 u-items-center">
                <button
                  type="button"
                  className="btn-accent-solid"
                  disabled={cutoverBusy || productionGated}
                  onClick={() => { void cutOver(next.status); }}
                  title={productionGated ? 'Needs to graduate to bounded-autonomous first' : undefined}
                >
                  Advance to {next.label} →
                </button>
                {prev ? (
                  <button type="button" className="secondary" disabled={cutoverBusy} onClick={() => { void cutOver(prev.status); }} title="Kill-switch — always available">
                    Roll back to {prev.label}
                  </button>
                ) : null}
              </div>
            )}
          </>
        ) : (
          <>
            <p className="wf-gate"><strong>Running on its own</strong> within its policy guardrails.{!isShowcase ? ' Roll back any time below.' : ''}</p>
            {!isShowcase && prev ? (
              <div className="action-bar u-mt-2">
                <button type="button" className="secondary" disabled={cutoverBusy} onClick={() => { void cutOver(prev.status); }}>Roll back to {prev.label}</button>
              </div>
            ) : null}
          </>
        )}
        {cutoverError ? <Notice variant="error">{cutoverError}</Notice> : null}
      </section>

      {/* NEEDS YOU — decision-first (DESIGN.md §4.5 rule 1). Real fields only. */}
      {metrics || governance ? (() => {
        const openApprovals = metrics?.openApprovals ?? 0;
        const violations = metrics?.policyViolations ?? governance?.posture.policyViolations ?? 0;
        const eligible = governance?.autonomy.eligibleForNext ?? false;
        const clear = openApprovals === 0 && violations === 0 && !eligible;
        return (
          <section className="surface-card u-mb-4">
            <h3 className="u-mt-0">Needs you</h3>
            {clear ? (
              <p className="muted u-m-0">All clear — nothing needs your attention right now.</p>
            ) : (
              <div className="action-bar u-gap-2 u-wrap u-items-center">
                {openApprovals > 0 ? <span className="chip chip--warning"><AlertIcon size={12} /> {openApprovals} awaiting approval</span> : null}
                {eligible ? <span className="chip chip--success">ready for more autonomy</span> : null}
                {violations > 0 ? <span className="chip chip--danger"><AlertIcon size={12} /> {violations} policy issues</span> : null}
                {openApprovals > 0 && isVisible('notifications') ? <button type="button" className="btn-sm" onClick={() => navigate('/inbox')}>Review in Inbox →</button> : null}
              </div>
            )}
          </section>
        );
      })() : null}

      {/* WHAT IT'S DONE — outcomes in business terms (the value). */}
      <h3>What it&rsquo;s done for you</h3>
      {hasRuns && metrics ? (
        <div className="surface-card wf-outcomes u-mb-4">
          <Outcome n={pctRound(Math.max(0, 1 - metrics.escalationRate))} l="cleared without escalation" />
          <Outcome n={duration(metrics.cycleTimeP50Ms)} l="typical time per item" />
          <Outcome n={usd(metrics.costPerClearedUsd)} l="cost per item" />
          <Outcome n={String(metrics.totalRuns)} l="items processed" />
        </div>
      ) : (wf.historyRunCount ?? 0) > 0 ? (
        <StateCard
          icon={<BoxesIcon />}
          title="No results yet"
          body="This workforce ships with weeks of sample runs. Load the demo data to see what it can do."
          action={<button type="button" className="btn-accent-solid" onClick={() => navigate('/demo-data')}>Load demo data</button>}
        />
      ) : (
        <StateCard
          icon={<BoxesIcon />}
          title="No results yet"
          body="This is a stand-up template — results appear here once the workforce runs real work."
        />
      )}

      {/* EVIDENCE & DETAILS — the governance machinery, opt-in. */}
      <details className="surface-card u-mt-4">
        <summary className="u-cursor-pointer u-fw-600">Evidence &amp; details</summary>
        <div className="wforce-details-body">
          {/* Purpose & policy */}
          <h4 className="u-mbox-b04">What it&rsquo;s allowed to do</h4>
          <div className="action-bar u-gap-2 u-wrap u-mb-2">
            {wf.purpose.policyTags.map((t) => <span key={t} className="chip">{t}</span>)}
          </div>
          <div className="u-mb-4">
            <strong>Never does automatically:</strong>
            <ul className="wforce-refusal-list">
              {wf.purpose.refusalBoundaries.map((b) => <li key={b}>{b}</li>)}
            </ul>
          </div>

          {/* Telemetry grid */}
          {hasRuns && metrics ? (
            <>
              <h4 className="u-mbox-b04">Full telemetry</h4>
              <div className="wforce-telemetry-grid">
                <Metric label="RUNS" value={String(metrics.totalRuns)} hint={`${metrics.openApprovals} awaiting approval`} />
                <Metric label="CYCLE TIME P50" value={duration(metrics.cycleTimeP50Ms)} />
                <Metric label="COST / CLEARED" value={usd(metrics.costPerClearedUsd)} />
                <Metric label="ESCALATION RATE" value={pct(metrics.escalationRate)} />
                <Metric label="OVERRIDE RATE" value={pct(metrics.overrideRate)} hint="how often a human stepped in" />
                <Metric label="FALSE-POSITIVE" value={pct(metrics.falsePositiveRate)} />
                <Metric label="RECOVERY RATE" value={pct(metrics.recoveryRate)} />
                <Metric label="POLICY VIOLATIONS" value={String(metrics.policyViolations)} />
              </div>
            </>
          ) : null}

          {/* Graduation curve */}
          {metrics && metrics.weekly.length > 1 ? (
            <section className="u-mb-4">
              <h4 className="u-mbox-b04">How often a human stepped in, by week</h4>
              <div className="action-bar u-gap-3 u-wrap u-items-end">
                {metrics.weekly.map((w) => (
                  <div key={w.week} className="u-text-center">
                    <div aria-hidden="true" className="wforce-grad-bar" style={{ height: `${Math.max(4, w.overrideRate * 200)}px` }} />
                    <div className="u-fs-12 muted">wk {w.week + 1}</div>
                    <div className="u-fs-12 u-tabular">{pct(w.overrideRate)}</div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {/* Governance posture + milestones */}
          {governance ? (
            <section className="u-mb-4">
              <h4 className="u-mbox-b04">Autonomy history</h4>
              <ol className="wforce-milestone-list">
                {governance.autonomy.milestones.map((m) => (
                  <li key={`${m.toTier}-${m.runIndex}`}>
                    <strong>{m.fromTier ? `${autonomyLabel(m.fromTier)} → ${autonomyLabel(m.toTier)}` : `started at ${autonomyLabel(m.toTier)}`}</strong>
                    {' '}<span className="muted">· {new Date(m.atIso).toLocaleDateString()}</span>
                  </li>
                ))}
              </ol>
              <div className="action-bar u-gap-2 u-wrap">
                <span className="chip">{governance.posture.overrides} human step-ins</span>
                <span className="chip">{governance.posture.escalations} escalations</span>
                <span className="chip">{governance.posture.recoveries} auto-recoveries</span>
                <span className="chip chip--warning">{governance.posture.policyViolations} policy violations</span>
              </div>
            </section>
          ) : null}

          {/* Cross-run trace search */}
          <TraceSearchPanel workforceId={workforceId} />

          {/* Agent cluster */}
          <h4 className="wforce-team-head">The team</h4>
          <div className="card-grid">
            {wf.agents.map((a) => (
              <div key={a.agentRef} className="surface-card">
                <div className="action-bar u-justify-between">
                  <strong>{a.agentRef}</strong>
                  <span className="chip"><RoleGlyph role={a.role} /> {a.role}</span>
                </div>
                <dl className="u-mbox-t2 u-fs-14">
                  <div><strong>Decides on its own:</strong> {a.decisionBoundary}</div>
                  <div><strong>Sees:</strong> {a.dataBoundary}</div>
                  <div><strong>On failure:</strong> {a.recoveryBehavior}</div>
                </dl>
              </div>
            ))}
          </div>
        </div>
      </details>
    </div>
  );
}
