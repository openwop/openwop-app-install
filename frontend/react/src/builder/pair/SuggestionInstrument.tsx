/**
 * ADR 0773 D5 — the edge-docked suggestion instrument at the top of the sheet
 * (DESIGN.md §7.1.2 permits edge-docked board instruments; no panel floats
 * mid-sheet). It states that nothing is saved yet, names the focused change,
 * and carries the review verbs; the same verbs are registered commands
 * (J/K, ⌘⏎ keep, ⌘⌫ drop, ⇧⌘⏎ keep all) in the shared shortcut registry.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { ChevronLeftIcon, ChevronRightIcon } from '../../ui/icons/index.js';
import { announce } from '../../ui/announce.js';
import { useBuilderStore } from '../store/builderStore.js';
import { liveOpStatuses } from './suggestionModel.js';
import { usePairStore } from './pairStore.js';
import { opSummary } from './opSummary.js';

export function SuggestionInstrument(): JSX.Element | null {
  const { t } = useTranslation('builder');
  const reviewOpen = usePairStore((s) => s.reviewOpen);
  const suggestion = usePairStore((s) => s.suggestion);
  const opState = usePairStore((s) => s.opState);
  const focusedOp = usePairStore((s) => s.focusedOp);
  const workflowId = useBuilderStore((s) => s.workflowId);
  const nodes = useBuilderStore((s) => s.nodes);
  const edges = useBuilderStore((s) => s.edges);
  const statuses = useMemo(
    () => (suggestion ? liveOpStatuses(suggestion, { nodes, edges }, opState) : []),
    [suggestion, nodes, edges, opState],
  );
  const pending = statuses.filter((s) => s === 'pending').length;
  if (!suggestion || suggestion.workflowId !== workflowId || pending === 0 || !reviewOpen) return null;
  const store = usePairStore.getState;
  const focused = focusedOp !== null ? suggestion.ops[focusedOp] : undefined;
  const drafting = usePairStore.getState().phase === 'drafting';
  const planned = suggestion.plannedOps;

  return (
    <div className="pair-instrument" role="group" aria-label={t('pairInstrumentAria')}>
      <span className="pair-instrument__swatch" aria-hidden />
      <span className="pair-instrument__text">
        <strong>{t('pairInstrumentTitle')}</strong>
        {' · '}
        {t('pairInstrumentCount', { count: pending })}
        {drafting && planned ? <> · {t('pairPlacing', { n: suggestion.ops.length, total: Math.max(planned, suggestion.ops.length) })}</> : null}
        {focused && focusedOp !== null ? <> · <span className="pair-instrument__focus">{focusedOp + 1}. {opSummary(focused, { ops: suggestion.ops, nodes })}</span></> : null}
      </span>
      {/* G-03c — one segment per change, by status; the words are in the list,
          so the bar is decorative for assistive tech. */}
      <span className="pair-instrument__segments" aria-hidden>
        {statuses.map((st, i) => <span key={i} className={`pair-seg pair-seg--${st}${focusedOp === i ? ' is-focused' : ''}`} />)}
      </span>
      <Button size="sm" variant="quiet" className="pair-instrument__btn" aria-label={t('pairPrevChange')} onClick={() => store().step(-1)}><ChevronLeftIcon size={14} aria-hidden /></Button>
      <Button size="sm" variant="quiet" className="pair-instrument__btn" aria-label={t('pairNextChange')} onClick={() => store().step(1)}><ChevronRightIcon size={14} aria-hidden /></Button>
      <Button size="sm" variant="quiet" className="pair-instrument__btn" onClick={() => { store().dropAll(); announce(t('pairAnnDroppedAll')); }}>{t('pairDropAll')}</Button>
      <Button
        size="sm"
        variant="accent-solid"
        onClick={() => { const r = store().keepAll(); announce(t('pairAnnKept', { count: r.kept.length })); }}
      >
        {t('pairKeepAll')}
      </Button>
    </div>
  );
}
