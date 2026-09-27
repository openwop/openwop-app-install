/**
 * ADR 0546 D4/P1–P5 — the scoreboard, the due follow-ups and the drafts.
 *
 * ## Why one page
 *
 * These are the three things a job-seeker opens the app to see AFTER the
 * applications go out, and ADR 0546's thesis is that this half is the product.
 * Splitting them across three screens would bury the two that require action
 * behind the one that does not.
 *
 * ## `null` is rendered as "not enough yet", never as 0%
 *
 * The backend distinguishes "nobody replied to your 40 applications" (rate 0)
 * from "you have not applied yet" (rate null), and that distinction survives
 * only if the UI honours it. Rendering null as 0% would tell a user who has
 * applied to nothing that their approach is failing — the most discouraging
 * possible lie, told to the person least able to evaluate it.
 *
 * ## Warm-vs-cold leads
 *
 * It is the dominant variable (2–3% cold against 40–65% referred), so it is the
 * first thing on the page rather than a row in a table further down. A page
 * that opened with "applications sent" would be selling the vanity number this
 * product exists to reject.
 *
 * ## The drafts panel states the rule it lives under
 *
 * Nothing here sends. That is a structural property of the backend module, and
 * saying it plainly is what stops a user from assuming an approved interview
 * reply went out on their behalf — an assumption that would cost them the
 * interview.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Panel } from '../../ui/layout.js';
import { Button } from '../../ui/Button.js';
import { StateCard } from '../../ui/StateCard.js';
import { StatusBadge } from '../../ui/StatusBadge.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { Notice } from '../../ui/Notice.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { ShieldIcon } from '../../ui/icons/index.js';
import {
  listOrgs, getFunnelBundle, completeFollowUp, approveDraft,
  type FunnelReport, type FollowUpRow, type DraftRow, type Rate,
} from './jobSearchClient.js';

/** A rate, or an explicit statement that there is nothing to state. */
function RateValue({ rate }: { rate: Rate }): JSX.Element {
  const { t } = useTranslation('job-search');
  if (rate.rate === null) {
    // NOT "0%". The denominator is zero: there is no rate, and claiming one
    // would be inventing a result.
    return <span className="muted">{t('funnelNoData')}</span>;
  }
  return (
    <span>
      <strong>{Math.round(rate.rate * 100)}%</strong>{' '}
      <span className="muted u-text-sm">({rate.numerator}/{rate.denominator})</span>
    </span>
  );
}

export function FunnelPage(): JSX.Element {
  const { t } = useTranslation('job-search');
  const { orgs, orgsFailed, retry: retryOrgs, orgId } = useOrgSelection(listOrgs);
  const [report, setReport] = useState<FunnelReport | null>(null);
  const [followUps, setFollowUps] = useState<FollowUpRow[]>([]);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    try {
      setFailed(false);
      // JSUX-FUN-2 (R3) — one bundle request instead of a 3-read mount fan-out.
      const { report: r, followUps: f, drafts: d } = await getFunnelBundle(orgId);
      setReport(r); setFollowUps(f); setDrafts(d);
    } catch {
      setFailed(true);
    }
  }, [orgId]);

  useEffect(() => { void load(); }, [load]);

  const onComplete = useCallback(async (row: FollowUpRow) => {
    if (!orgId) return;
    await completeFollowUp(orgId, row.dealId, row.stage);
    await load();
  }, [orgId, load]);

  const onApprove = useCallback(async (row: DraftRow) => {
    if (!orgId) return;
    await approveDraft(orgId, row.dealId, row.kind);
    await load();
  }, [orgId, load]);

  const kindLabel = (kind: DraftRow['kind']): string =>
    kind === 'interview-reply' ? t('draftKindReply') : kind === 'prep-sheet' ? t('draftKindPrep') : t('draftKindIntro');

  return (
    <div className="u-flex-col u-gap-4" data-walkthrough="job-search.funnel">
      <PageHeader eyebrow={t('eyebrow')} title={t('funnelTitle')} lede={t('funnelLede')} />

      <OrgSelectionState
        orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')} icon={<ShieldIcon />}
      >
        {failed ? (
          <StateCard
            announce
            icon={<ShieldIcon size={20} />}
            title={t('appsLoadFailed')}
            action={<Button variant="secondary" size="sm" onClick={() => { void load(); }}>{t('appsRetry')}</Button>}
          />
        ) : report === null ? (
          <div role="status" aria-busy="true" aria-label={t('funnelTitle')} className="u-flex u-flex-col u-gap-2">
            {['60%', '80%', '70%'].map((w, i) => <Skeleton key={i} width={w} height={20} />)}
          </div>
        ) : report.pipelineFound === false ? (
          // Grade-trio finding 9 — a missing pipeline used to render as a
          // perfectly healthy EMPTY funnel, collapsing "we lost your
          // pipeline" into "you have not applied yet".
          <StateCard
            announce
            icon={<ShieldIcon size={20} />}
            title={t('funnelPipelineMissingTitle')}
            body={t('funnelPipelineMissingBody')}
          />
        ) : (
          <>
            {/* The dominant variable, first. */}
            {/* The panel title is NOT `funnelWarm`: it names the comparison, so
                the two rows below read as arms of it. Rendered side by side the
                repeated words read as a stutter — visible only on the page. */}
            <Panel title={t('funnelWarmHeading')}>
              <p className="muted u-text-sm">{t('funnelWarmLede')}</p>
              <div className="u-flex u-gap-4 u-mt-2">
                <span>{t('funnelWarm')}: <RateValue rate={report.warmVsCold.warm} /></span>
                <span>{t('funnelCold')}: <RateValue rate={report.warmVsCold.cold} /></span>
              </div>
            </Panel>

            <Panel title={t('funnelResponse')}>
              <p><RateValue rate={report.responseRate} /></p>
              {report.responseRate.rate === null ? (
                <p className="muted u-text-sm u-mt-1">{t('funnelNoDataHint')}</p>
              ) : (
                <p className="muted u-text-sm u-mt-1">{t('funnelSilent', { count: report.silent })}</p>
              )}
              <p className="muted u-text-sm u-mt-1">
                {report.medianHoursToFirstResponse === null
                  ? t('funnelMedianNone')
                  : t('funnelMedian', { hours: Math.round(report.medianHoursToFirstResponse) })}
              </p>
            </Panel>

            <Panel title={t('funnelStages')}>
              <ul className="u-list-none u-flex u-flex-col u-gap-1">
                {report.conversions.map((c) => (
                  <li key={`${c.from}-${c.to}`}>
                    {c.from} → {c.to}: <RateValue rate={c.rate} />
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel title={t('funnelBySource')}>
              {/* Every source appears, including the boards that never reply —
                  those are the rows worth acting on. */}
              <ul className="u-list-none u-flex u-flex-col u-gap-1">
                {report.bySource.map((s) => (
                  <li key={s.source}>{s.source}: <RateValue rate={s.rate} /></li>
                ))}
              </ul>
            </Panel>
          </>
        )}

        <Panel title={t('followUpsTitle')}>
          {followUps.length === 0 ? (
            <StateCard icon={<ShieldIcon size={20} />} title={t('followUpsEmpty')} body={t('followUpsEmptyBody')} />
          ) : (
            followUps.map((f) => (
              <div key={`${f.dealId}:${f.stage}`} className="surface-card u-p-3 u-mb-2 u-flex u-gap-2 u-items-center">
                {/* The ROLE, not the raw `deal:9f3c…` id — the user has to know
                    which application is waiting on them to act on it. */}
                <span className="u-flex-1">{f.dealTitle} — {f.stage}</span>
                <Button size="sm" variant="secondary" onClick={() => { void onComplete(f); }}>{t('followUpDone')}</Button>
              </div>
            ))
          )}
        </Panel>

        <Panel title={t('draftsTitle')}>
          {/* Stated plainly: a user who assumed an approved reply was sent would
              lose the interview waiting for a response that never went out. */}
          <div className="u-mb-2"><Notice variant="info">{t('draftsNeverSent')}</Notice></div>
          {drafts.length === 0 ? (
            <StateCard icon={<ShieldIcon size={20} />} title={t('draftsEmpty')} body={t('draftsEmptyBody')} />
          ) : (
            drafts.map((d) => (
              <div key={`${d.dealId}:${d.kind}`} className="surface-card u-p-3 u-mb-2">
                <div className="u-flex u-gap-2 u-items-center">
                  <strong className="u-flex-1">{kindLabel(d.kind)} — {d.dealTitle}</strong>
                  {d.approvedAt
                    ? <StatusBadge status="success" label={t('draftApproved')} />
                    : <Button size="sm" onClick={() => { void onApprove(d); }}>{t('draftApprove')}</Button>}
                </div>
                <p className="muted u-text-sm u-mt-1">{d.body}</p>
              </div>
            ))
          )}
        </Panel>
      </OrgSelectionState>
    </div>
  );
}
