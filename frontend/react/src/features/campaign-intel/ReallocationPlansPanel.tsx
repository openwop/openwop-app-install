/**
 * Reallocation plans (ADR 0952 D3) on the Campaign Intelligence page. A plan is
 * proposed by the Budget Reallocation workflow and approved in the Inbox (the one
 * campaign-spend approval queue). This panel shows each plan's before/after
 * changes and, once approved, applies it. Decreases apply first; the outcome of
 * every change is shown. Renders nothing until a plan exists.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { formatDate, formatNumber } from '../../i18n/format.js';
import { applyReallocationPlan, listReallocations, type ApplyReallocationOutcome, type ReallocationPlanDto, type ReallocationStatus } from './campaignIntelClient.js';

const STATUS_CHIP: Record<ReallocationStatus, string> = {
  proposed: 'chip chip--warning', approved: 'chip chip--warning', applying: 'chip chip--muted',
  applied: 'chip chip--success', partial: 'chip chip--danger', rejected: 'chip chip--muted', expired: 'chip chip--muted',
};

/** Known reason/error codes → localized text; the raw code stays as a suffix for support. */
function useReason(): (code: string) => string {
  const { t } = useTranslation('campaign-intel');
  return (code: string): string => {
    const head = code.split(':')[0] ?? code;
    const key = head.startsWith('cap_') ? 'reallocReason_cap' : `reallocReason_${head}`;
    const label = t(key, { defaultValue: '' });
    return label ? `${label} (${code})` : code;
  };
}

function changePct(from: number | null, to: number): string | null {
  if (from === null || from <= 0) return null;
  const p = ((to - from) / from) * 100;
  return `${p > 0 ? '+' : ''}${formatNumber(p, { maximumFractionDigits: 0 })}%`;
}

export function ReallocationPlansPanel({ orgId, refreshKey = 0 }: { orgId: string; refreshKey?: number }): JSX.Element | null {
  const { t } = useTranslation('campaign-intel');
  const reason = useReason();
  const [plans, setPlans] = useState<ReallocationPlanDto[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ planId: string; outcome: ApplyReallocationOutcome | 'error'; message?: string } | null>(null);

  const load = useCallback(async () => {
    try { setPlans(await listReallocations(orgId)); setLoadFailed(false); } catch { setPlans(null); setLoadFailed(true); }
  }, [orgId]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const apply = async (planId: string): Promise<void> => {
    setBusy(planId);
    setResult(null);
    try {
      const r = await applyReallocationPlan(orgId, planId);
      setResult({ planId, outcome: r.outcome });
      await load();
    } catch (e) {
      setResult({ planId, outcome: 'error', message: e instanceof Error ? e.message : '' });
    } finally { setBusy(null); }
  };

  if (loadFailed) return <p className="muted u-fs-13">{t('reallocLoadFailed')}</p>;
  // Route stamp-backs are history, not decisions: the panel lists proposed plans and their outcomes.
  const shown = (plans ?? []).filter((p) => p.source.kind !== 'route').slice(0, 10);
  if (shown.length === 0) return null;

  return (
    <section className="surface-card u-mb-4" aria-labelledby="realloc-title">
      <h2 id="realloc-title" className="u-mt-0 u-fs-15">{t('reallocTitle')}</h2>
      <p className="muted u-fs-13 u-mt-0">{t('reallocLede')}</p>
      <ul className="u-list-none u-m-0 u-p-0">
        {shown.map((p) => {
          const open = p.status === 'proposed' || p.status === 'approved' || p.status === 'applying';
          return (
            <li key={p.planId} className="u-py-2">
              <div className="u-flex u-items-center u-gap-3 u-flex-wrap">
                <span className={STATUS_CHIP[p.status]}>{t(`reallocStatus_${p.status}`)}</span>
                <span className="u-fs-13 muted">{t('reallocMeta', { count: p.ops.length, date: formatDate(p.createdAt) })}</span>
                {open ? (
                  <span className="u-ml-auto u-flex u-gap-2 u-items-center">
                    <Link to="/inbox" className="u-fs-13">{t('reallocReviewInInbox')}</Link>
                    <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => { void apply(p.planId); }}>
                      {busy === p.planId ? t('reallocApplying') : t('reallocApply')}
                    </Button>
                  </span>
                ) : null}
              </div>
              <div className="table-scroll table--stack">
                <table className="u-w-full u-fs-13">
                  <thead><tr className="muted"><th scope="col" className="u-text-left u-py-1">{t('reallocColCampaign')}</th><th scope="col" className="u-text-right u-py-1">{t('reallocColFrom')}</th><th scope="col" className="u-text-right u-py-1">{t('reallocColTo')}</th><th scope="col" className="u-text-right u-py-1">{t('reallocColChange')}</th><th scope="col" className="u-text-left u-py-1">{t('reallocColOutcome')}</th></tr></thead>
                  <tbody>
                    {p.ops.map((o, i) => {
                      const r = p.results.find((x) => x.opIx === i);
                      return (
                        <tr key={`${o.platform}-${o.campaignId}`}>
                          <td className="u-py-1"><span className="data-stack-label">{t('reallocColCampaign')}</span>{o.campaignName ? <span className="u-fw-600">{o.campaignName}</span> : null}{o.campaignName ? ' · ' : ''}{t(`platform_${o.platform}`, { defaultValue: o.platform })} <span className="muted">{o.campaignId}</span></td>
                          <td className="u-text-right u-py-1"><span className="data-stack-label">{t('reallocColFrom')}</span>{o.fromDailyMinor === null ? t('reallocUnknown') : formatNumber(o.fromDailyMinor)}</td>
                          <td className="u-text-right u-py-1"><span className="data-stack-label">{t('reallocColTo')}</span>{formatNumber(o.toDailyMinor)}</td>
                          <td className="u-text-right u-py-1"><span className="data-stack-label">{t('reallocColChange')}</span>{changePct(o.fromDailyMinor, o.toDailyMinor) ?? t('reallocUnknown')}</td>
                          <td className="u-py-1"><span className="data-stack-label">{t('reallocColOutcome')}</span>{r ? t(`reallocOp_${r.outcome}`) : t('reallocOp_pending')}{r?.error ? ` — ${reason(r.error)}` : ''}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {p.dropped.length > 0 ? <p className="muted u-fs-13 u-mb-0">{t('reallocDropped', { list: p.dropped.map((d) => `${d.campaignId}: ${reason(d.reason)}`).join('; ') })}</p> : null}
              {result?.planId === p.planId ? (() => {
                const text = result.outcome === 'error' ? (result.message || t('reallocApplyFailed')) : t(`reallocResult_${result.outcome}`);
                // Mounted with its text already inside, so it speaks through the global live region.
                return (
                  <Notice announce={text} variant={result.outcome === 'applied' ? 'success' : result.outcome === 'error' || result.outcome === 'partial' ? 'error' : 'info'}>
                    {text}
                  </Notice>
                );
              })() : null}
            </li>
          );
        })}
      </ul>
      <p className="muted u-fs-13 u-mb-0">{t('reallocUnitsNote')}</p>
    </section>
  );
}
