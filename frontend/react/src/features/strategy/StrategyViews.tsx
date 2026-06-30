/**
 * Strategy Card + Row — the two cells of the §4.5 collection-view canon (rule 11)
 * for the Strategy portfolio. The Card fills a `.card-grid`; the Row fills a
 * `.surface-card.list-view`. Both derive their chips + sub-line from the SAME
 * helpers below (`StrategyChips` + `strategySubLine`), so the grid and list views
 * never diverge (the `primaryAction`/`subLine` precedent on `/agents`). Composed
 * from existing primitives — no bespoke CSS.
 */
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { FlagIcon } from '../../ui/icons/index.js';
import type { Strategy, StrategyStatus, StrategyConfidence, StrategyRisk, StrategyHealthState } from './strategyClient.js';

// Chip families (verbatim from the portfolio card — preserve the exact mappings).
const STATUS_CHIP: Record<StrategyStatus, string> = { draft: 'chip--muted', active: 'chip--success', paused: 'chip--warning', completed: 'chip--accent', archived: 'chip--muted' };
const RISK_CHIP: Record<StrategyRisk, string> = { low: 'chip--success', medium: 'chip--warning', high: 'chip--danger' };
const CONFIDENCE_CHIP: Record<StrategyConfidence, string> = { high: 'chip--success', medium: 'chip--warning', low: 'chip--danger' };
const HEALTH_CHIP: Record<StrategyHealthState, string> = { 'on-track': 'chip--success', 'at-risk': 'chip--warning', 'off-track': 'chip--danger' };

function HealthChip({ state, t }: { state: StrategyHealthState; t: TFunction }): JSX.Element {
  return <span className={`chip ${HEALTH_CHIP[state]}`}>{t(`health_${state}`)}</span>;
}
function ScopeChip({ scope, t }: { scope: Strategy['scope']; t: TFunction }): JSX.Element {
  return <span className="chip chip--muted">{t(`scope_${scope}`)}</span>;
}
function StatusChip({ status, t }: { status: StrategyStatus; t: TFunction }): JSX.Element {
  return <span className={`chip ${STATUS_CHIP[status]}`}>{t(`status_${status}`)}</span>;
}

/** The contextual one-liner from REAL fields — the strategy summary, else a
 *  no-summary fallback. Shared by Card + Row. */
export function strategySubLine(s: Strategy, t: TFunction): string {
  return s.summary || t('subNoSummary');
}

/** The full chip set — health (from the rollup map), status, scope, KB-index
 *  state, horizon, confidence, risk, objectives count. Shared by Card + Row so
 *  the two views carry identical metadata (rule 11). */
export function StrategyChips({
  s, health, kbEnabled, t,
}: { s: Strategy; health: Map<string, StrategyHealthState>; kbEnabled: boolean; t: TFunction }): JSX.Element {
  const h = health.get(s.id);
  return (
    <>
      {h ? <HealthChip state={h} t={t} /> : null}
      <StatusChip status={s.status} t={t} />
      <ScopeChip scope={s.scope} t={t} />
      {s.scope === 'user'
        ? <span className="chip chip--muted" title={t('notIndexedTitle')}>{t('notIndexed')}</span>
        : (kbEnabled && s.status !== 'archived' ? <span className="chip chip--muted" title={t('indexedTitle')}><FlagIcon size={11} aria-hidden /> {t('indexedForAgents')}</span> : null)}
      <span className="chip chip--muted">{t(`horizon_${s.planningHorizon}`)}</span>
      {s.confidence ? <span className={`chip ${CONFIDENCE_CHIP[s.confidence]}`}>{t('confidenceLabel', { level: t(`level_${s.confidence}`) })}</span> : null}
      {s.risk ? <span className={`chip ${RISK_CHIP[s.risk]}`}>{t('riskLabel', { level: t(`level_${s.risk}`) })}</span> : null}
      <span className="chip chip--muted">{t('objectivesCount', { count: s.objectives.length })}</span>
    </>
  );
}

type CellProps = {
  s: Strategy;
  health: Map<string, StrategyHealthState>;
  kbEnabled: boolean;
  onOpen: (id: string) => void;
};

export function StrategyCard({ s, health, kbEnabled, onOpen }: CellProps): JSX.Element {
  const { t } = useTranslation('strategy');
  return (
    <button type="button" className="surface-card u-text-left" onClick={() => onOpen(s.id)}>
      <div className="u-flex u-items-center u-justify-between u-gap-2">
        <h3 className="u-fs-14 u-fw-600 u-m-0">{s.title}</h3>
        <span className="u-flex u-gap-1 u-items-center">
          {(() => { const h = health.get(s.id); return h ? <HealthChip state={h} t={t} /> : null; })()}
          <StatusChip status={s.status} t={t} />
        </span>
      </div>
      {s.summary ? <p className="muted u-fs-13 u-mt-2 u-mb-2">{s.summary}</p> : null}
      <div className="u-flex u-gap-2 u-flex-wrap u-mt-2">
        <ScopeChip scope={s.scope} t={t} />
        {s.scope === 'user'
          ? <span className="chip chip--muted" title={t('notIndexedTitle')}>{t('notIndexed')}</span>
          : (kbEnabled && s.status !== 'archived' ? <span className="chip chip--muted" title={t('indexedTitle')}><FlagIcon size={11} aria-hidden /> {t('indexedForAgents')}</span> : null)}
        <span className="chip chip--muted">{t(`horizon_${s.planningHorizon}`)}</span>
        {s.confidence ? <span className={`chip ${CONFIDENCE_CHIP[s.confidence]}`}>{t('confidenceLabel', { level: t(`level_${s.confidence}`) })}</span> : null}
        {s.risk ? <span className={`chip ${RISK_CHIP[s.risk]}`}>{t('riskLabel', { level: t(`level_${s.risk}`) })}</span> : null}
        <span className="chip chip--muted">{t('objectivesCount', { count: s.objectives.length })}</span>
      </div>
    </button>
  );
}

export function StrategyRow({ s, health, kbEnabled, onOpen }: CellProps): JSX.Element {
  const { t } = useTranslation('strategy');
  return (
    <div className="list-row">
      <button type="button" className="list-row-id" title={t('openStrategy', { title: s.title })} onClick={() => onOpen(s.id)}>
        <FlagIcon size={18} aria-hidden />
        <span className="list-row-name-wrap">
          <span className="list-row-name-line">
            <span className="list-row-name">{s.title}</span>
          </span>
          <span className="list-row-sub">{strategySubLine(s, t)}</span>
        </span>
      </button>
      <div className="list-row-meta">
        <StrategyChips s={s} health={health} kbEnabled={kbEnabled} t={t} />
      </div>
      <div className="list-row-actions action-bar">
        <button type="button" className="secondary btn-sm" onClick={() => onOpen(s.id)}>{t('openStrategyAction')}</button>
      </div>
    </div>
  );
}
