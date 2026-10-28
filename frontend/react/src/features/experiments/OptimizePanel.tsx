/**
 * ADR 0949 P4b — the Optimize screens: the config (reward, floor, cadence) and
 * the allocation view. Optimize vocabulary only: "probability best" and
 * "expected loss", labelled a model estimate. Never a verdict, a p-value or a
 * "significant" flag, and no winner: an Optimize experiment shifts traffic to
 * what is working now; deciding needs a Decide experiment (ADR 0949 D2).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { useFormat } from '../../i18n/useFormat.js';
import type { Experiment, OptimizeConfig, OptimizeResults } from './experimentsClient.js';

interface Props {
  experiment: Experiment;
  results: OptimizeResults | null;
  busy: boolean;
  onSaveConfig: (config: OptimizeConfig) => void;
  onReallocate: () => void;
  onRefresh: () => void;
}

export function OptimizeConfigForm({ experiment, busy, onSaveConfig }: Pick<Props, 'experiment' | 'busy' | 'onSaveConfig'>): JSX.Element {
  const { t } = useTranslation('experiments');
  const cfg = experiment.optimize;
  const editable = experiment.status === 'draft' && !experiment.legacy;
  const [reward, setReward] = useState(cfg?.rewardMetric.name ?? 'conversion');
  const [floor, setFloor] = useState(String(cfg?.floorPct ?? 5));
  const [hours, setHours] = useState(String((cfg?.epochMinutes ?? 1440) / 60));
  const submit = (): void => onSaveConfig({ rewardMetric: { kind: 'conversion', name: reward.trim() || 'conversion' }, floorPct: Number(floor), epochMinutes: Math.round(Number(hours) * 60) });
  return (
    <form className="surface-card u-p-4 surface-form" aria-label={t('optimizeConfigTitle')} onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <h2 className="u-m-0">{t('optimizeConfigTitle')}</h2>
      <p className="u-label-sm muted u-m-0">{t('optimizeConfigLede')}</p>
      <label className="u-grid u-gap-1">
        <span className="u-label-sm">{t('fieldReward')}</span>
        <input value={reward} onChange={(e) => setReward(e.target.value)} disabled={!editable} />
      </label>
      <label className="u-grid u-gap-1">
        <span className="u-label-sm">{t('fieldFloor')}</span>
        <input inputMode="numeric" value={floor} onChange={(e) => setFloor(e.target.value)} disabled={!editable} />
        <span className="u-label-sm muted">{t('fieldFloorHelp')}</span>
      </label>
      <label className="u-grid u-gap-1">
        <span className="u-label-sm">{t('fieldEpochHours')}</span>
        <input inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} disabled={!editable} />
        <span className="u-label-sm muted">{t('fieldEpochHoursHelp')}</span>
      </label>
      {editable ? <Button type="submit" variant="secondary" disabled={busy}>{t('saveConfig')}</Button> : null}
    </form>
  );
}

export function OptimizeResultsPanel({ experiment, results, busy, onReallocate, onRefresh }: Omit<Props, 'onSaveConfig'>): JSX.Element | null {
  const { t } = useTranslation('experiments');
  const fmt = useFormat();
  if (!results) return null;
  const share = (r: number): string => fmt.percent(r, { maximumFractionDigits: 1 });
  return (
    <div className="surface-card u-p-4 u-grid u-gap-2">
      <span className="action-bar">
        <h2 className="u-m-0">{t('allocationTitle')}</h2>
        <Button variant="quiet" disabled={busy} onClick={onRefresh}>{t('refreshResults')}</Button>
        {experiment.status === 'running' ? <Button variant="secondary" disabled={busy} onClick={onReallocate}>{t('reallocateNow')}</Button> : null}
      </span>
      <p className="u-label-sm muted u-m-0">{t('optimizeEstimateNote')}</p>
      {results.coverage.status === 'partial' ? <Notice variant="warning">{t('coverageNotice')}</Notice> : null}
      {results.stickinessCapped ? <Notice variant="info">{t('stickinessCappedNotice')}</Notice> : null}
      <table className="data-table">
        <caption>{t('captionAllocation', { epoch: fmt.number(results.epoch) })}</caption>
        <thead><tr>
          <th scope="col">{t('colArm')}</th><th scope="col">{t('colTraffic')}</th><th scope="col">{t('colVisitors')}</th>
          <th scope="col">{t('colRate')}</th><th scope="col">{t('colProbabilityBest')}</th><th scope="col">{t('colExpectedLoss')}</th>
        </tr></thead>
        <tbody>{results.arms.map((a) => (
          <tr key={a.key}>
            <td>{a.key}</td>
            <td>{fmt.percent((results.weights[a.key] ?? 0) / 100)}</td>
            <td>{fmt.number(a.units)}</td>
            <td>{share(a.rate)}</td>
            <td>{share(a.probabilityBest)}</td>
            <td>{t('lossPts', { v: fmt.number(a.expectedLoss * 100, { maximumFractionDigits: 2 }) })}</td>
          </tr>
        ))}</tbody>
      </table>
      <p className="u-label-sm muted u-m-0">{t('floorNote', { floor: fmt.number(results.floorPct) })}</p>
      <p className="u-label-sm muted u-m-0">{t('computedAt', { when: fmt.dateTime(results.computedAt) })}</p>
    </div>
  );
}
