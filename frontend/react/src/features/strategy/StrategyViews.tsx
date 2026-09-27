/**
 * Strategy Card + Row — the two cells of the §4.5 collection-view canon (rule 11)
 * for the Strategy portfolio. The Card fills a `.card-grid`; the Row fills a
 * `.surface-card.list-view`. Both derive their chips + sub-line from the SAME
 * helpers below (`StrategyChips` + `strategySubLine`), so the grid and list views
 * never diverge (the `primaryAction`/`subLine` precedent on `/agents`). Composed
 * from existing primitives — no bespoke CSS.
 *
 * SPU-12 — that paragraph was FALSE for the Card, which re-inlined the whole chip
 * set and rendered `{s.summary ? … : null}` instead of `strategySubLine`. The
 * visible consequence: a strategy with no summary showed "No summary yet" in LIST
 * view and a blank gap in GRID view — precisely the divergence the comment said
 * was impossible. The latent one is worse: two chip sets that can now drift with
 * nothing to catch it, under a docblock that keeps asserting they cannot.
 *
 * The Card's split layout is deliberate and is kept — health + status ride the
 * title row — so `StrategyChips` takes `withLead`, and the two views share ONE
 * implementation of every chip rather than the Card owning a second copy.
 */
import { Link } from 'react-router-dom';
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
  s, health, kbEnabled, parentTitle, withLead = true, t,
}: { s: Strategy; health: Map<string, StrategyHealthState>; kbEnabled: boolean; parentTitle?: string;
  /** `false` when the caller already renders health + status elsewhere (the
   *  Card's title row). Everything else stays shared — see the docblock. */
  withLead?: boolean; t: TFunction }): JSX.Element {
  const h = health.get(s.id);
  return (
    <>
      {withLead && h ? <HealthChip state={h} t={t} /> : null}
      {withLead ? <StatusChip status={s.status} t={t} /> : null}
      {/* SGU-4 — a strategy awaiting activation approval is still `draft`, so the list
          rendered it identically to one nobody has submitted. The detail page has shown
          this chip since ADR 0230; the portfolio — where a reviewer actually scans for
          work — did not, and the data was already on the row. */}
      {s.activationPending ? <span className="chip chip--warning" title={t('activationPendingTitle')}>{t('activationPending')}</span> : null}
      <ScopeChip scope={s.scope} t={t} />
      {parentTitle ? <span className="chip chip--accent">{t('partOf', { parent: parentTitle })}</span> : null}
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
  /** ADR 0235 §D3 — the parent strategy's title when it is in the readable
   *  list; absent ⇒ ungrouped (silent-ungroup posture). */
  parentTitle?: string;
};

/** Every strategy has its own URL (`/strategy/:strategyId`) — cells are real
 *  links (cmd-click / middle-click / share), the ProjectViews precedent. */
const strategyHref = (s: Strategy): string => `/strategy/${encodeURIComponent(s.id)}`;

export function StrategyCard({ s, health, kbEnabled, parentTitle }: CellProps): JSX.Element {
  const { t } = useTranslation('strategy');
  return (
    <Link to={strategyHref(s)} className="surface-card u-text-left">
      <div className="u-flex u-items-center u-justify-between u-gap-2">
        <h3 className="u-fs-14 u-fw-600 u-m-0">{s.title}</h3>
        <span className="u-flex u-gap-1 u-items-center">
          {(() => { const h = health.get(s.id); return h ? <HealthChip state={h} t={t} /> : null; })()}
          <StatusChip status={s.status} t={t} />
        </span>
      </div>
      <p className="muted u-fs-13 u-mt-2 u-mb-2">{strategySubLine(s, t)}</p>
      <div className="u-flex u-gap-2 u-flex-wrap u-mt-2">
        <StrategyChips s={s} health={health} kbEnabled={kbEnabled} withLead={false} {...(parentTitle ? { parentTitle } : {})} t={t} />
      </div>
    </Link>
  );
}

export function StrategyRow({ s, health, kbEnabled, parentTitle }: CellProps): JSX.Element {
  const { t } = useTranslation('strategy');
  const href = strategyHref(s);
  return (
    <div className="list-row">
      <Link to={href} className="list-row-id" title={t('openStrategy', { title: s.title })}>
        <span className="list-row-name-wrap">
          <span className="list-row-name-line">
            <span className="list-row-name">{s.title}</span>
          </span>
          <span className="list-row-sub">{strategySubLine(s, t)}</span>
        </span>
      </Link>
      <div className="list-row-meta">
        <StrategyChips s={s} health={health} kbEnabled={kbEnabled} {...(parentTitle ? { parentTitle } : {})} t={t} />
      </div>
      <div className="list-row-actions action-bar">
        <Link to={href} className="btn secondary btn-sm">{t('openStrategyAction')}</Link>
      </div>
    </div>
  );
}
