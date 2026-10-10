/**
 * ADR 0773 G-01a — the status edge's truthful suggestion context: how many
 * changes are waiting and how to review them; P11 adds the sheet's counts and
 * the selection.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useBuilderStore } from '../store/builderStore.js';
import { liveOpStatuses } from './suggestionModel.js';
import { usePairStore } from './pairStore.js';

export function PairStatus(): JSX.Element | null {
  const { t } = useTranslation('builder');
  const suggestion = usePairStore((s) => s.suggestion);
  const opState = usePairStore((s) => s.opState);
  const workflowId = useBuilderStore((s) => s.workflowId);
  const nodes = useBuilderStore((s) => s.nodes);
  const edges = useBuilderStore((s) => s.edges);
  const pending = useMemo(
    () => (suggestion && suggestion.workflowId === workflowId ? liveOpStatuses(suggestion, { nodes, edges }, opState).filter((x) => x === 'pending').length : 0),
    [suggestion, workflowId, nodes, edges, opState],
  );
  const selectedIds = useBuilderStore((s) => s.selectedNodeIds);
  const selectedName = selectedIds.length === 1 ? nodes.find((n) => n.id === selectedIds[0])?.name : undefined;
  // P11 — the sheet at a glance: steps, connections, what is selected, then
  // the review hint while changes wait.
  return (
    <span className="pair-status">
      {t('pairStatusSteps', { count: nodes.length })} · {t('pairStatusConnections', { count: edges.length })}
      {selectedName ? <> · {t('pairStatusSelected', { name: selectedName })}</> : selectedIds.length > 1 ? <> · {t('pairStatusSelectedMany', { count: selectedIds.length })}</> : null}
      {pending > 0 ? (
        <> · <span className="pair-status__pending">{t('pairStatusPending', { count: pending })}</span> · <kbd>J</kbd>/<kbd>K</kbd> {t('pairStatusReview')} · <kbd>Esc</kbd> {t('pairStatusHide')}</>
      ) : null}
    </span>
  );
}
