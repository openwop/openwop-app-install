/**
 * ADR 0773 G-02a/b — the near-selection toolbar for a MULTI-selection (the
 * single-node one lives on BaseNode). Anchored to the selection's bounds by
 * xyflow's NodeToolbar. Quick actions:
 *  - Ask — an inline ask whose chips already cite every selected node;
 *  - Label as a group — a sticky-note header placed above the selection (the
 *    builder has no group primitive; the client-only sticky note is its
 *    annotation, and it is ONE undo step);
 *  - Extract as sub-chain — asks the Architect to SUGGEST the split (a
 *    `core.subWorkflow` proposal to review), never a direct write;
 *  - Explain.
 */

import { useEffect, useState } from 'react';
import { NodeToolbar, Position } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { MessageCircleIcon } from '../../ui/icons/index.js';
import { useBuilderStore } from '../store/builderStore.js';
import { QuickAsk } from './QuickAsk.js';
import { usePairStore } from './pairStore.js';

export function SelectionToolbar({ ids }: { ids: readonly string[] }): JSX.Element {
  const { t } = useTranslation('builder');
  const [asking, setAsking] = useState(false);
  // P11 — ⌘. with a multi-selection opens the prompt at the selection.
  const inlineAskFor = usePairStore((s) => s.inlineAskFor);
  useEffect(() => {
    if (inlineAskFor !== '*') return;
    setAsking(true);
    usePairStore.getState().requestInlineAsk(null);
  }, [inlineAskFor]);
  const nodes = useBuilderStore((s) => s.nodes);
  const picked = nodes.filter((n) => ids.includes(n.id));
  const names = picked.map((n) => n.name).join(', ');
  const ask = usePairStore((s) => s.ask);

  const labelGroup = (): void => {
    if (picked.length === 0) return;
    const minX = Math.min(...picked.map((n) => n.position.x));
    const minY = Math.min(...picked.map((n) => n.position.y));
    useBuilderStore.getState().applyEditOps([{
      kind: 'addNode', nodeId: `n_${crypto.randomUUID().slice(0, 8)}`, typeId: 'local.sticky-note',
      name: t('pairGroupLabelName'), config: { content: t('pairGroupLabelContent', { count: picked.length }) },
      position: { x: minX, y: minY - 110 },
    }]);
  };

  return (
    <NodeToolbar nodeId={[...ids]} isVisible position={Position.Top} className="pair-node-toolbar">
      {asking ? (
        <QuickAsk autoFocus inline framing={t('pairSelectionFraming', { names })} onDone={() => setAsking(false)} />
      ) : (
        <div role="group" aria-label={t('pairSelectionToolbarAria', { count: ids.length })} className="pair-node-toolbar__row">
          <Button size="sm" variant="accent" onClick={() => setAsking(true)}>
            <MessageCircleIcon size={12} aria-hidden /> {t('pairAsk')}
          </Button>
          <Button size="sm" variant="quiet" onClick={labelGroup}>{t('pairLabelGroup')}</Button>
          <Button size="sm" variant="quiet" onClick={() => ask(t('pairExtractPrompt', { names }), { inline: true })}>{t('pairExtract')}</Button>
          <Button size="sm" variant="quiet" onClick={() => ask(t('pairExplainManyPrompt', { names }), { inline: true })}>{t('pairExplain')}</Button>
        </div>
      )}
    </NodeToolbar>
  );
}
