/**
 * Shared interrupt renderer — maps an OpenInterrupt to the correct
 * resume UI (approve/reject, clarification, refinement, cancellation)
 * and calls `/resume` via the card. Used by both the per-run detail
 * page and the cross-run HITL inbox so the kind→card mapping lives in
 * one place.
 */

import { useTranslation } from 'react-i18next';
import type { OpenInterrupt } from '../client/interruptsClient.js';
import { ApprovalCard } from './ApprovalCard.js';
import { ClarificationDialog } from './ClarificationDialog.js';
import { RefinementForm } from './RefinementForm.js';
import { CancellationBanner } from './CancellationBanner.js';

interface Props {
  runId: string;
  active: OpenInterrupt | null;
  onResolved: () => void;
}

export function RenderInterrupt({ runId, active, onResolved }: Props) {
  const { t } = useTranslation('interrupts');
  if (!active) return null;
  const props = {
    runId,
    nodeId: active.nodeId,
    token: active.token,
    data: active.data,
    onResolved,
  };
  switch (active.kind) {
    case 'approval':
      return <ApprovalCard {...props} />;
    case 'clarification':
      return <ClarificationDialog {...props} />;
    case 'refinement':
      return <RefinementForm {...props} />;
    case 'cancellation':
      return <CancellationBanner {...props} />;
    default:
      return (
        <div className="alert warning">
          {t('unknownKindPrefix')} <code>{active.kind}</code> {t('unknownKindMid')}
          <code> RenderInterrupt</code> {t('unknownKindTail')} <code>interrupts/RenderInterrupt.tsx</code>.
        </div>
      );
  }
}
