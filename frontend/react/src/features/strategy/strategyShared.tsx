/**
 * Shared strategy-feature vocabulary — the enum option lists, chip mappings, and
 * tiny chip components used by BOTH the portfolio page (`StrategyPage`) and the
 * routed detail page (`StrategyDetailPage`). Kept out of either page so the two
 * routes never drift on how a scope/status/health value is named or colored.
 */
import { useTranslation } from 'react-i18next';
import type {
  StrategyScope, PlanningHorizon, StrategyStatus, StrategyConfidence, StrategyRisk, StrategyHealthState,
} from './strategyClient.js';

export const SCOPES: StrategyScope[] = ['user', 'workspace', 'org'];
export const HORIZONS: PlanningHorizon[] = ['quarter', 'half-year', 'annual', 'multi-year', 'custom'];
export const STATUSES: StrategyStatus[] = ['draft', 'active', 'paused', 'completed', 'archived'];
export const CONFIDENCES: StrategyConfidence[] = ['high', 'medium', 'low'];
export const RISKS: StrategyRisk[] = ['low', 'medium', 'high'];

export const STATUS_CHIP: Record<StrategyStatus, string> = { draft: 'chip--muted', active: 'chip--success', paused: 'chip--warning', completed: 'chip--accent', archived: 'chip--muted' };
// Linked-project health → chip (mirrors the projects feature's mapping, ADR 0054).
export const PROJECT_HEALTH_CHIP: Record<string, string> = { 'on-track': 'chip--success', 'at-risk': 'chip--warning', 'off-track': 'chip--danger' };
// Strategy health (ADR 0080) — the portfolio Card/Row chip lives in StrategyViews;
// the detail editor only needs the health-OVERRIDE option list.
export const HEALTH_STATES: StrategyHealthState[] = ['on-track', 'at-risk', 'off-track'];

export const uid = (): string => `tmp-${Math.random().toString(36).slice(2, 10)}`;

export type TFn = ReturnType<typeof useTranslation>['t'];

export function ScopeChip({ scope, t }: { scope: StrategyScope; t: TFn }): JSX.Element {
  return <span className="chip chip--muted">{t(`scope_${scope}`)}</span>;
}
export function StatusChip({ status, t }: { status: StrategyStatus; t: TFn }): JSX.Element {
  return <span className={`chip ${STATUS_CHIP[status]}`}>{t(`status_${status}`)}</span>;
}
