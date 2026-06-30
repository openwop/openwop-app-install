/**
 * RunCostPanel — per-run token & cost aggregation.
 *
 * Reads `provider.usage` events (RFC 0026) off the run's event log and
 * rolls them up per (provider, model): call count, input/output tokens,
 * and USD. Cost prefers the host's advisory `costEstimateUsd` on the
 * event; when absent it falls back to the static per-1K rates in
 * providers.json (same table the chat cost helper uses). The advisory
 * caveat is surfaced — these are estimates, not billing.
 *
 * Renders nothing when a run emitted no usage events.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { RunEventDoc } from '@openwop/openwop';
import { getProvider } from '../byok/lib/providers.js';
import { formatUsd } from '../chat/lib/cost.js';
import { DataTable, type DataColumn } from '../ui/DataTable.js';
import i18n from '../i18n/index.js';
import { formatNumber } from '../i18n/format.js';

interface Props {
  events: readonly RunEventDoc[];
}

interface Row {
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** True when at least one call's cost came from the local rate table
   *  rather than the host's advisory estimate. */
  estimatedLocally: boolean;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function localRate(provider: string, model: string, inT: number, outT: number): number | null {
  try {
    const p = getProvider(provider);
    const m = p.models.find((mm) => mm.id === model);
    if (!m?.cost) return null;
    return (inT * m.cost.input + outT * m.cost.output) / 1000;
  } catch {
    return null;
  }
}

function aggregate(events: readonly RunEventDoc[]): { rows: Row[]; total: Row } {
  const byKey = new Map<string, Row>();
  for (const ev of events) {
    if (ev.type !== 'provider.usage') continue;
    const p = asRecord(ev.payload);
    const provider = String(p.provider ?? 'unknown');
    const model = String(p.model ?? 'unknown');
    const inT = Number(p.inputTokens ?? 0) || 0;
    const outT = Number(p.outputTokens ?? 0) || 0;
    const key = `${provider}::${model}`;
    const row = byKey.get(key) ?? {
      provider, model, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, estimatedLocally: false,
    };
    row.calls += 1;
    row.inputTokens += inT;
    row.outputTokens += outT;
    if (typeof p.costEstimateUsd === 'number') {
      row.costUsd += p.costEstimateUsd as number;
    } else {
      const local = localRate(provider, model, inT, outT);
      if (local != null) { row.costUsd += local; row.estimatedLocally = true; }
    }
    byKey.set(key, row);
  }
  const rows = [...byKey.values()].sort((a, b) => b.costUsd - a.costUsd);
  const total: Row = {
    provider: '', model: i18n.t('runs:costTotalRow'), calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0,
    estimatedLocally: rows.some((r) => r.estimatedLocally),
  };
  for (const r of rows) {
    total.calls += r.calls;
    total.inputTokens += r.inputTokens;
    total.outputTokens += r.outputTokens;
    total.costUsd += r.costUsd;
  }
  return { rows, total };
}

/** Columns for the cost rollup DataTable. Factory so the bar width is relative
 *  to the run's max per-model cost. Order-preserving (no sortValue). */
function COST_COLUMNS(maxCost: number): DataColumn<Row>[] {
  return [
    {
      key: 'model',
      header: i18n.t('runs:costColModel'),
      render: (r) => (
        <>
          <span className="muted">{r.provider}/</span>{r.model}
          {r.estimatedLocally && <span className="muted" title={i18n.t('runs:costLocalRateTitle')}> *</span>}
        </>
      ),
    },
    { key: 'calls', header: i18n.t('runs:costColCalls'), align: 'right', cellClassName: 'tabular-nums', render: (r) => formatNumber(r.calls) },
    { key: 'in', header: i18n.t('runs:costColIn'), align: 'right', cellClassName: 'tabular-nums', render: (r) => formatNumber(r.inputTokens) },
    { key: 'out', header: i18n.t('runs:costColOut'), align: 'right', cellClassName: 'tabular-nums', render: (r) => formatNumber(r.outputTokens) },
    { key: 'cost', header: i18n.t('runs:costColCost'), align: 'right', cellClassName: 'tabular-nums', render: (r) => formatUsd(r.costUsd) },
    {
      key: 'bar',
      header: '',
      width: '80px',
      render: (r) => <span className="cost-bar" style={{ width: `${(r.costUsd / maxCost) * 100}%` }} />,
    },
  ];
}

export function RunCostPanel({ events }: Props) {
  const { t } = useTranslation('runs');
  const { rows, total } = useMemo(() => aggregate(events), [events]);
  if (rows.length === 0) return null;
  const maxCost = Math.max(...rows.map((r) => r.costUsd), 1e-9);

  return (
    <div className="card">
      <div className="u-flex u-items-baseline u-gap-2">
        <h2 className="u-flex-1">{t('tokensAndCost')}</h2>
        <strong className="runcost-total">{formatUsd(total.costUsd)}</strong>
        <span className="muted u-fs-12">
          {t('costTokensSummary', {
            tokens: formatNumber(total.inputTokens + total.outputTokens),
            calls: formatNumber(total.calls),
          })}
        </span>
      </div>
      <DataTable<Row>
        caption={t('costTableCaption')}
        rows={rows}
        rowKey={(r) => `${r.provider}::${r.model}`}
        columns={COST_COLUMNS(maxCost)}
      />
      <p className="muted u-fs-11 u-mt-1-5">
        {t('costAdvisoryPre')}<span title={t('costLocalRateTableTitle')}>*</span>{t('costAdvisoryPost')}
      </p>
    </div>
  );
}
