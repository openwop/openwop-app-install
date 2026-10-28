/**
 * ADR 0950 P0 — the promotion gate checklist (read-only). Each gate is a
 * labelled status chip (never colour alone, DESIGN.md §5.3) with the reason it
 * failed and the numbers it read. Rendered on the experiment page and inside the
 * CMS manual-promote confirm, where it warns and does not block.
 */
import { useTranslation } from 'react-i18next';
import { useFormat } from '../../i18n/useFormat.js';

export type GateStatus = 'pass' | 'fail' | 'not_evaluable';
export interface GateResult { id: 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'G8'; status: GateStatus; reason?: string; value: Record<string, unknown> }
export interface GateReport {
  experimentId: string; winner: string | null; gates: GateResult[]; allPass: boolean;
  snapshot: { planHash: string | null; cellsHash: string; computedAt: string };
}

const tone: Record<GateStatus, string> = { pass: 'chip chip--success', fail: 'chip chip--danger', not_evaluable: 'chip chip--muted' };

export function GateChecklist({ report }: { report: GateReport }): JSX.Element {
  const { t } = useTranslation('experiments');
  const fmt = useFormat();
  const reasonText = (g: GateResult): string | null => {
    if (!g.reason) return null;
    const key = `gateReason_${g.reason}`;
    const text = t(key, {
      smallest: fmt.number(Number(g.value.smallestArm ?? 0)), min: fmt.number(Number(g.value.minSamplePerArm ?? 0)),
      days: fmt.number(Number(g.value.days ?? 0)), minDays: fmt.number(Number(g.value.minDays ?? 0)),
    });
    return text === key ? t('gateReasonOther', { reason: g.reason }) : text;
  };
  return (
    <ul className="list-plain u-grid u-gap-1" aria-label={t('gatesTitle')}>
      {report.gates.map((g) => (
        <li key={g.id} className="action-bar">
          <span className={tone[g.status]}>{t(`gateStatus_${g.status}`)}</span>
          <span>{t(`gate_${g.id}`)}</span>
          {reasonText(g) ? <span className="u-label-sm muted">{reasonText(g)}</span> : null}
        </li>
      ))}
    </ul>
  );
}
