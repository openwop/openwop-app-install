/**
 * KickTodo metrics (ADR 0432 P4).
 *
 * The representation is a TABLE, not a chart with a table fallback: the app
 * ships no charting primitive, and for these numbers a captioned table IS the
 * accessible answer (§14) rather than a lesser one.
 *
 * Two honesty rules the UI enforces visually:
 *  - a withheld cell says WHY (too few participants) and never renders a value;
 *  - every rate shows its contributor count, so no percentage carries an
 *    implied denominator.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChartIcon } from '../../ui/icons/index.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { formatDate } from '../../i18n/format.js';
import {
  getActivation,
  getEngagement,
  getFactory,
  getVerifierQuality,
  type ActivationMetrics,
  type EngagementMetrics,
  type FactoryMetrics,
  type FlooredCell,
  type VerifierQuality,
} from '../../client/kicktodoMetricsClient.js';

interface MetricRow {
  key: string;
  label: string;
  cell: FlooredCell<number>;
  format: 'count' | 'rate' | 'days';
}

/** Literal keys per KNOWN candidate state (KTUX-9); an unknown state falls
 *  back to the raw interpolation key rather than a wrong label. */
function stateKeyOf(state: string): string {
  switch (state) {
    case 'intake': return 'candidateState_intake';
    case 'researched': return 'candidateState_researched';
    case 'planned': return 'candidateState_planned';
    case 'published': return 'candidateState_published';
    case 'withdrawn': return 'candidateState_withdrawn';
    default: return 'candidateState';
  }
}

export function MetricsPage() {
  const { t } = useTranslation('kicktodo-metrics');
  const [loaded, setLoaded] = useState(false);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [activation, setActivation] = useState<ActivationMetrics | null>(null);
  const [engagement, setEngagement] = useState<EngagementMetrics | null>(null);
  const [factory, setFactory] = useState<FactoryMetrics | null>(null);
  const [verifier, setVerifier] = useState<VerifierQuality | null>(null);

  const reload = useCallback(async () => {
    try {
      setError(false);
      // ONE batched load — four sequential reads on mount would be an
      // unnecessary step toward the per-IP read budget.
      const [a, e, f, v] = await Promise.all([
        getActivation(),
        getEngagement(),
        getFactory(),
        getVerifierQuality(),
      ]);
      setActivation(a);
      setEngagement(e);
      setFactory(f);
      setVerifier(v);
    } catch {
      setError(true);
    } finally {
      setLoaded(true); setAsOf(new Date().toISOString());
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const formatValue = (row: MetricRow): string => {
    const v = row.cell.value;
    if (v === null) return '';
    if (row.format === 'rate') return t('ratePercent', { percent: Math.round(v * 100) });
    if (row.format === 'days') return t('daysValue', { days: v });
    return String(v);
  };

  const columns: DataColumn<MetricRow>[] = [
    { key: 'label', header: t('colMetric'), render: (r) => r.label, width: '2fr' },
    {
      key: 'value',
      header: t('colValue'),
      align: 'right',
      render: (r) =>
        r.cell.value === null ? (
          <span className="chip chip--muted">{t('withheld')}</span>
        ) : (
          <strong>{formatValue(r)}</strong>
        ),
    },
    {
      key: 'contributors',
      header: t('colContributors'),
      align: 'right',
      cellClassName: 'muted',
      render: (r) => t('contributorCount', { count: r.cell.contributors }),
    },
  ];

  const activationRows: MetricRow[] = activation
    ? [
        { key: 'firstAction', label: t('mDaysToFirstAction'), cell: activation.daysToFirstCompletedActionP50, format: 'days' },
        { key: 'anyCompletion', label: t('mWithAnyCompletion'), cell: activation.enrollmentsWithAnyCompletion, format: 'count' },
      ]
    : [];

  const engagementRows: MetricRow[] = engagement
    ? [
        { key: 'northStar', label: t('mNorthStar'), cell: engagement.weeklyMeaningfulProgress, format: 'count' },
        { key: 'd7', label: t('mRetentionD7'), cell: engagement.retentionD7, format: 'rate' },
        { key: 'd30', label: t('mRetentionD30'), cell: engagement.retentionD30, format: 'rate' },
        { key: 'completion', label: t('mCompletionRate'), cell: engagement.completionRate, format: 'rate' },
        { key: 'abandonment', label: t('mAbandonmentRate'), cell: engagement.abandonmentRate, format: 'rate' },
        { key: 'recovery', label: t('mRecoveryRate'), cell: engagement.recoveryRate7d, format: 'rate' },
      ]
    : [];

  const factoryRows: MetricRow[] = factory ? [{ key: 'publishRate', label: t('mPublishRate'), cell: factory.publishRate, format: 'rate' }] : [];

  return (
    <div className="page" data-walkthrough="kicktodo-metrics.page">
      <header className="page-header">
        <h1 className="page-header__title">{t('title')}</h1>
        <p className="page-header__lede">{t('lede')}</p>
      </header>

      {asOf && <p className="muted u-fs-13">{t('asOfNote', { when: formatDate(asOf, { timeStyle: 'short' }) })}</p>}

      {error && <Notice variant="error">{t('loadError')}</Notice>}
      {!loaded && !error && <StateCard loading title={t('title')} />}

      {loaded && !error && (
        <>
          <Notice variant="info">{t('privacyNote')}</Notice>

          <section className="surface-card" aria-label={t('activationHeading')}>
            <h2>{t('activationHeading')}</h2>
            <p className="muted">{t('enrollmentsStarted', { count: activation?.enrollmentsStarted ?? 0 })}</p>
            <DataTable
              caption={t('activationHeading')}
              columns={columns}
              rows={activationRows}
              rowKey={(r) => r.key}
              stack
              empty={<StateCard icon={<BarChartIcon aria-hidden />} title={t('emptyTitle')} body={t('emptyBody')} />}
            />
          </section>

          <section className="surface-card" aria-label={t('engagementHeading')}>
            <h2>{t('engagementHeading')}</h2>
            <p className="muted">{t('northStarNote')}</p>
            <DataTable
              caption={t('engagementHeading')}
              columns={columns}
              rows={engagementRows}
              rowKey={(r) => r.key}
              stack
              empty={<StateCard icon={<BarChartIcon aria-hidden />} title={t('emptyTitle')} body={t('emptyBody')} />}
            />
          </section>

          <section className="surface-card" aria-label={t('factoryHeading')}>
            <h2>{t('factoryHeading')}</h2>
            <div className="action-bar">
              {Object.entries(factory?.candidatesByState ?? {}).map(([state, count]) => (
                <span key={state} className="chip">{t(stateKeyOf(state), { count, state })}</span>
              ))}
            </div>
            <DataTable
              caption={t('factoryHeading')}
              columns={columns}
              rows={factoryRows}
              rowKey={(r) => r.key}
              stack
              empty={<StateCard icon={<BarChartIcon aria-hidden />} title={t('emptyTitle')} body={t('emptyBody')} />}
            />
          </section>

          <section className="surface-card" aria-label={t('verifierHeading')}>
            <h2>{t('verifierHeading')}</h2>
            <p className="muted">{t('verifierDenominator', { resolved: verifier?.resolved ?? 0, sampled: verifier?.sampled ?? 0 })}</p>
            {verifier && verifier.resolved === 0 ? (
              <Notice variant="info">{t('verifierUngraded')}</Notice>
            ) : (
              <div className="action-bar">
                <span className="chip">{t('verifierAgreed', { count: verifier?.agreed ?? 0 })}</span>
                <span className="chip">{t('verifierFalsePositives', { count: verifier?.falsePositives ?? 0 })}</span>
                <span className="chip">{t('verifierFalseNegatives', { count: verifier?.falseNegatives ?? 0 })}</span>
                {verifier?.disagreementRate !== null && verifier !== null && (
                  <span className="chip chip--muted">
                    {t('verifierDisagreement', { percent: Math.round((verifier.disagreementRate ?? 0) * 100) })}
                  </span>
                )}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
