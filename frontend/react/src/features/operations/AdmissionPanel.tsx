/**
 * ADR 0987 D6 — the run-admission panel on the Operations hub.
 *
 * Its own read and its own outcome state (the UX-OPS-1 rule the hub's other panels
 * follow): a 403 or a failure here never speaks for the panels beside it, and it
 * never raises the hub's page-level error.
 *
 * Honesty rules this panel keeps:
 *  - the refusal counts are THIS instance's since it booted, and the panel says so;
 *  - the holding count is bounded, so a reading at the bound says "at least";
 *  - the two concurrency families show no per-family refusals: the store counts
 *    them together, and a "0" there would claim a split nobody measured;
 *  - the posture is a word in a chip, never colour alone (WCAG 1.4.1).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Notice, StateCard } from '../../ui/index.js';
import { formatNumber } from '../../i18n/format.js';
import { getAdmissionSummary, OperationsRequestError, type AdmissionFamily, type AdmissionSummary } from '../../client/operationsClient.js';

/** The i18n key for a family's label; an unknown family renders its own id. */
const FAMILY_KEY: Record<string, string> = {
  'concurrency.session': 'admissionFamilyConcurrencySession',
  'concurrency.key': 'admissionFamilyConcurrencyKey',
  'runs.session.minute': 'admissionFamilyRunsSessionMinute',
  'runs.session.day': 'admissionFamilyRunsSessionDay',
  'runs.key.day': 'admissionFamilyRunsKeyDay',
  'runs.ip.day': 'admissionFamilyRunsIpDay',
  'plan.monthly': 'admissionFamilyPlanMonthly',
};

const POSTURE: Record<AdmissionFamily['posture'], { key: string; chip: string }> = {
  transactional: { key: 'admissionPostureTransactional', chip: 'chip chip--muted' },
  closed: { key: 'admissionPostureClosed', chip: 'chip chip--success' },
  open: { key: 'admissionPostureOpen', chip: 'chip chip--warning' },
};

/** Reads whenever `refreshToken` changes, so the hub's first load, its Refresh
 *  and its timer reach this panel too. 0 is "the hub has not loaded yet", which
 *  keeps the mount from reading twice. */
export function AdmissionPanel({ refreshToken }: { refreshToken: number }): JSX.Element {
  const { t } = useTranslation('operations');
  const [summary, setSummary] = useState<AdmissionSummary | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setSummary(await getAdmissionSummary());
      setForbidden(false);
      setFailed(false);
    } catch (e) {
      // Structurally by status, never by message text.
      const is403 = e instanceof OperationsRequestError && e.status === 403;
      setForbidden(is403);
      setFailed(!is403);
    }
  }, []);

  useEffect(() => { if (refreshToken > 0) void load(); }, [load, refreshToken]);

  let body: JSX.Element;
  if (forbidden) {
    body = <StateCard title={t('operatorOnlyTitle')} body={t('operatorOnlyBody')} />;
  } else if (failed && !summary) {
    body = (
      <StateCard
        announce
        title={t('admissionUnavailableTitle')}
        body={t('admissionUnavailableBody')}
        action={<Button variant="secondary" size="sm" onClick={() => void load()}>{t('refresh')}</Button>}
      />
    );
  } else if (!summary) {
    body = <StateCard loading title={t('loading')} />;
  } else {
    const concurrencyTotal = Object.values(summary.concurrencyRefusals).reduce((a, b) => a + b, 0);
    body = (
      <article className="surface-card">
        {failed ? <Notice variant="warning" announce={t('admissionStale')}>{t('admissionStale')}</Notice> : null}
        <header className="action-bar">
          <span className={summary.profile === 'strict' ? 'chip chip--success' : 'chip chip--warning'}>
            {summary.profile === 'strict' ? t('admissionProfileStrict') : t('admissionProfileEvaluation')}
          </span>
          <span className="chip chip--muted">
            {summary.holding.atLeast
              ? t('admissionHoldingAtLeast', { n: formatNumber(summary.holding.count) })
              : t('admissionHolding', { n: formatNumber(summary.holding.count) })}
          </span>
          {summary.perInstance ? <span className="chip chip--warning">{t('admissionPerInstance')}</span> : null}
        </header>
        <ul>
          {summary.families.map((f) => {
            const label = FAMILY_KEY[f.family];
            const posture = POSTURE[f.posture] as (typeof POSTURE)[AdmissionFamily['posture']] | undefined;
            return (
            <li key={f.family} className="action-bar">
              <span>{label ? t(label) : f.family}</span>
              <span className="chip chip--muted">
                {f.cap === null ? t('admissionCapPerPlan') : f.cap === 0 ? t('admissionCapOff') : t('admissionCap', { n: formatNumber(f.cap) })}
              </span>
              <span className={posture?.chip ?? 'chip chip--muted'}>{posture ? t(posture.key) : f.posture}</span>
              {f.refusals === null ? null : Object.keys(f.refusals).length === 0 ? (
                <span className="chip chip--muted">{t('admissionNoRefusals')}</span>
              ) : (
                Object.entries(f.refusals).map(([reason, n]) => (
                  <span key={reason} className="chip chip--danger">{t('admissionRefused', { n: formatNumber(n) })} · <code>{reason}</code></span>
                ))
              )}
            </li>
            );
          })}
        </ul>
        <p>
          <span className={concurrencyTotal > 0 ? 'chip chip--danger' : 'chip chip--muted'}>
            {t('admissionConcurrencyRefusals', { n: formatNumber(concurrencyTotal) })}
          </span>{' '}
          {summary.windowUnavailable > 0 ? (
            <span className="chip chip--danger">{t('admissionWindowUnavailable', { n: formatNumber(summary.windowUnavailable) })}</span>
          ) : null}
        </p>
      </article>
    );
  }

  return (
    <section>
      <h2>{t('admissionHeading')}</h2>
      <p className="muted">{t('admissionHelp')}</p>
      {body}
    </section>
  );
}
