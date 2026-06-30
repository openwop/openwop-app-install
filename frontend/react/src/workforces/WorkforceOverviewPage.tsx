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
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '../ui/PageHeader.js';
import { StateCard } from '../ui/StateCard.js';
import { Skeleton } from '../ui/Skeleton.js';
import { Notice } from '../ui/Notice.js';
import { KeyFigureBand, type KeyFigureItem } from '../ui/KeyFigure.js';
import { AlertIcon, ArrowLeftIcon, BotIcon, BoxesIcon, ShieldIcon, UserIcon } from '../ui/icons/index.js';
import { TraceSearchPanel } from './TraceSearchPanel.js';
import { AutonomyTrack } from './AutonomyTrack.js';
import { JOURNEY, autonomyLabelKey, journeyGlossKey, journeyLabelKey, journeyIndex } from './labels.js';
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
import { formatCurrency, formatDate, formatDurationMs, formatNumber, formatPercent } from '../i18n/format.js';

function pct(n: number): string {
  return formatPercent(n, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
function pctRound(n: number): string {
  return `${Math.round(n * 100)}%`;
}
function duration(ms: number | null): string {
  if (ms === null) return '—';
  const h = ms / 3_600_000;
  if (h >= 1) return `${formatNumber(h, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h`;
  const m = ms / 60_000;
  if (m >= 1) return `${formatNumber(m, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} min`;
  return formatDurationMs(ms);
}
function usd(n: number | null): string {
  return n === null ? '—' : formatCurrency(n, 'USD', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
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

export function WorkforceOverviewPage(): JSX.Element {
  const { t } = useTranslation('workforces');
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

  const back = <Link to="/workforces" className="chip"><ArrowLeftIcon size={13} /> {t('allWorkforces')}</Link>;

  if (loading) {
    return <div><PageHeader eyebrow={t('overviewEyebrow')} title={t('loadingTitle')} actions={back} /><Skeleton height={120} /></div>;
  }
  if (notFound) {
    return (
      <div>
        <PageHeader eyebrow={t('overviewEyebrow')} title={t('notFoundTitle')} actions={back} />
        <StateCard icon={<BoxesIcon />} title={t('workforceNotFound')} body={t('noWorkforceNamed', { id: workforceId })} action={back} />
      </div>
    );
  }
  if (error || !wf) {
    return <div><PageHeader eyebrow={t('overviewEyebrow')} title={t('couldNotLoad')} actions={back} /><Notice variant="error">{error ?? t('unknownError')}</Notice></div>;
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
        eyebrow={t('overviewEyebrow')}
        title={wf.name}
        lede={wf.purpose.statement}
        actions={
          <span className="action-bar u-gap-2">
            {back}
            <Link to={`/workforces/${encodeURIComponent(workforceId)}/migrate`} className="btn">{t('setupGuide')}</Link>
          </span>
        }
      />

      {isShowcase ? (
        <Notice variant="info">
          <IllustrativeBadge detail={t('showcaseBadgeDetail')} /> {t('overviewShowcaseLead')}
          <strong> {t('overviewShowcaseShowcaseData')}</strong>. {t('overviewShowcaseTail')}
        </Notice>
      ) : null}

      {/* HERO — where it is on the trust journey + the one forward action. */}
      <section className="surface-card u-mb-4">
        <div className="chip chip--muted">{t('agentTeam', { count: wf.agents.length, businessFunction: wf.businessFunction })}</div>
        <AutonomyTrack status={wf.status} />
        <p className="wf-gate">{t(journeyGlossKey(wf.status))}</p>

        {next ? (
          <>
            {productionGated ? (
              <p className="wf-gate">
                {t('proveFirstLead')} <strong>{t('proveFirstRunOnItsOwn')}</strong>{t('proveFirstMid')}
                {metrics ? <> {t('proveFirstOverride')} <strong>{pct(metrics.overrideRate)}</strong> {t('proveFirstOverrideTail')}</> : null}.
              </p>
            ) : null}
            {/* Cut-over mutates the GLOBAL workforce entity (shared across
                visitors), so it is read-only on illustrative showcase data —
                you manage your own, not the demo's. */}
            {isShowcase ? (
              <p className="muted u-mbox-t2 u-fs-14">
                {t('showcaseReadOnly')}
              </p>
            ) : (
              <div className="action-bar u-gap-2 u-wrap u-mt-2 u-items-center">
                <button
                  type="button"
                  className="btn-accent-solid"
                  disabled={cutoverBusy || productionGated}
                  onClick={() => { void cutOver(next.status); }}
                  title={productionGated ? t('advanceGatedTitle') : undefined}
                >
                  {t('advanceTo', { label: t(journeyLabelKey(next.status)) })}
                </button>
                {prev ? (
                  <button type="button" className="secondary" disabled={cutoverBusy} onClick={() => { void cutOver(prev.status); }} title={t('rollBackTitle')}>
                    {t('rollBackTo', { label: t(journeyLabelKey(prev.status)) })}
                  </button>
                ) : null}
              </div>
            )}
          </>
        ) : (
          <>
            <p className="wf-gate"><strong>{t('runningOnItsOwnLead')}</strong> {t('runningOnItsOwnTail')}{!isShowcase ? <>{' '}{t('rollBackAnyTimeClause')}</> : null}</p>
            {!isShowcase && prev ? (
              <div className="action-bar u-mt-2">
                <button type="button" className="secondary" disabled={cutoverBusy} onClick={() => { void cutOver(prev.status); }}>{t('rollBackTo', { label: t(journeyLabelKey(prev.status)) })}</button>
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
            <h2 className="u-mt-0">{t('needsYou')}</h2>
            {clear ? (
              <p className="muted u-m-0">{t('needsYouClear')}</p>
            ) : (
              <div className="action-bar u-gap-2 u-wrap u-items-center">
                {openApprovals > 0 ? <span className="chip chip--warning"><AlertIcon size={12} /> {t('awaitingApprovalChip', { count: openApprovals })}</span> : null}
                {eligible ? <span className="chip chip--success">{t('readyForMoreChip')}</span> : null}
                {violations > 0 ? <span className="chip chip--danger"><AlertIcon size={12} /> {t('policyIssuesChip', { count: violations })}</span> : null}
                {openApprovals > 0 && isVisible('notifications') ? <button type="button" className="btn-sm" onClick={() => navigate('/inbox')}>{t('reviewInInbox')}</button> : null}
              </div>
            )}
          </section>
        );
      })() : null}

      {/* WHAT IT'S DONE — outcomes in business terms (the value). */}
      <h2>{t('whatItsDone')}</h2>
      {hasRuns && metrics ? (
        <div className="surface-card wf-outcomes u-mb-4">
          <Outcome n={pctRound(Math.max(0, 1 - metrics.escalationRate))} l={t('outcomeClearedWithoutEscalation')} />
          <Outcome n={duration(metrics.cycleTimeP50Ms)} l={t('outcomeTypicalTime')} />
          <Outcome n={usd(metrics.costPerClearedUsd)} l={t('outcomeCostPerItem')} />
          <Outcome n={String(metrics.totalRuns)} l={t('outcomeItemsProcessed')} />
        </div>
      ) : (wf.historyRunCount ?? 0) > 0 ? (
        <StateCard
          icon={<BoxesIcon />}
          title={t('noResultsTitle')}
          body={t('noResultsHistoryBody')}
          action={<button type="button" className="btn-accent-solid" onClick={() => navigate('/example-data')}>{t('loadExampleData')}</button>}
        />
      ) : (
        <StateCard
          icon={<BoxesIcon />}
          title={t('noResultsTitle')}
          body={t('noResultsTemplateBody')}
        />
      )}

      {/* EVIDENCE & DETAILS — the governance machinery, opt-in. */}
      <details className="surface-card u-mt-4">
        <summary className="u-cursor-pointer u-fw-600">{t('evidenceAndDetails')}</summary>
        <div className="wforce-details-body">
          {/* Purpose & policy */}
          <h3 className="u-mbox-b04">{t('whatItsAllowed')}</h3>
          <div className="action-bar u-gap-2 u-wrap u-mb-2">
            {wf.purpose.policyTags.map((tag) => <span key={tag} className="chip">{tag}</span>)}
          </div>
          <div className="u-mb-4">
            <strong>{t('neverDoesAutomatically')}</strong>
            <ul className="wforce-refusal-list">
              {wf.purpose.refusalBoundaries.map((b) => <li key={b}>{b}</li>)}
            </ul>
          </div>

          {/* Telemetry — the signature figure band (read-only; reportorial). */}
          {hasRuns && metrics ? (() => {
            const telemetry: KeyFigureItem[] = [
              { key: 'runs', label: t('telemetryRunsLabel', { count: metrics.openApprovals }), value: String(metrics.totalRuns) },
              { key: 'cycle', label: t('telemetryCycleLabel'), value: duration(metrics.cycleTimeP50Ms) },
              { key: 'cost', label: t('telemetryCostLabel'), value: usd(metrics.costPerClearedUsd) },
              { key: 'escalation', label: t('telemetryEscalationLabel'), value: pct(metrics.escalationRate) },
              { key: 'override', label: t('telemetryOverrideLabel'), value: pct(metrics.overrideRate) },
              { key: 'fp', label: t('telemetryFalsePositiveLabel'), value: pct(metrics.falsePositiveRate) },
              { key: 'recovery', label: t('telemetryRecoveryLabel'), value: pct(metrics.recoveryRate) },
              { key: 'violations', label: t('telemetryViolationsLabel'), value: String(metrics.policyViolations), ...(metrics.policyViolations > 0 ? { tone: 'attention' as const } : {}) },
            ];
            return (
              <>
                <h3 className="u-mbox-b04">{t('fullTelemetry')}</h3>
                <KeyFigureBand figures={telemetry} ariaLabel={t('telemetryAriaLabel')} />
              </>
            );
          })() : null}

          {/* Graduation curve */}
          {metrics && metrics.weekly.length > 1 ? (
            <section className="u-mb-4">
              <h3 className="u-mbox-b04">{t('overrideByWeek')}</h3>
              <div className="action-bar u-gap-3 u-wrap u-items-end">
                {metrics.weekly.map((w) => (
                  <div key={w.week} className="u-text-center">
                    <div aria-hidden="true" className="wforce-grad-bar" style={{ height: `${Math.max(4, w.overrideRate * 200)}px` }} />
                    <div className="u-fs-12 muted">{t('weekShort', { n: w.week + 1 })}</div>
                    <div className="u-fs-12 u-tabular">{pct(w.overrideRate)}</div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {/* Governance posture + milestones */}
          {governance ? (
            <section className="u-mb-4">
              <h3 className="u-mbox-b04">{t('autonomyHistory')}</h3>
              <ol className="wforce-milestone-list">
                {governance.autonomy.milestones.map((m) => (
                  <li key={`${m.toTier}-${m.runIndex}`}>
                    <strong>{m.fromTier ? t('milestoneTransition', { from: t(autonomyLabelKey(m.fromTier)), to: t(autonomyLabelKey(m.toTier)) }) : t('milestoneStartedAt', { tier: t(autonomyLabelKey(m.toTier)) })}</strong>
                    {' '}<span className="muted">· {formatDate(m.atIso)}</span>
                  </li>
                ))}
              </ol>
              <div className="action-bar u-gap-2 u-wrap">
                <span className="chip">{t('postureOverrides', { count: governance.posture.overrides })}</span>
                <span className="chip">{t('postureEscalations', { count: governance.posture.escalations })}</span>
                <span className="chip">{t('postureRecoveries', { count: governance.posture.recoveries })}</span>
                <span className="chip chip--warning">{t('postureViolations', { count: governance.posture.policyViolations })}</span>
              </div>
            </section>
          ) : null}

          {/* Cross-run trace search */}
          <TraceSearchPanel workforceId={workforceId} />

          {/* Agent cluster */}
          <h3 className="wforce-team-head">{t('theTeam')}</h3>
          <div className="card-grid">
            {wf.agents.map((a) => (
              <div key={a.agentRef} className="surface-card">
                <div className="action-bar u-justify-between">
                  <strong>{a.agentRef}</strong>
                  <span className="chip"><RoleGlyph role={a.role} /> {a.role}</span>
                </div>
                <dl className="u-mbox-t2 u-fs-14">
                  <div><strong>{t('decidesOnItsOwn')}</strong> {a.decisionBoundary}</div>
                  <div><strong>{t('sees')}</strong> {a.dataBoundary}</div>
                  <div><strong>{t('onFailure')}</strong> {a.recoveryBehavior}</div>
                </dl>
              </div>
            ))}
          </div>
        </div>
      </details>
    </div>
  );
}
