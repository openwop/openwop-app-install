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
import { ConnectionRequiredDialog } from './ConnectionRequiredDialog.js';
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
  // ADR 0755 D3 — no token means this caller may read the gate but not answer it
  // (`approvals:respond`); show that instead of cards whose submit must fail.
  if (!active.token) {
    return <div role="status" className="alert">{t('noRespondPermission')}</div>;
  }
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
      // ADR 0189 — a connection prompt rides the clarification kind but carries
      // the `openwop-connection` profile; render the connect-to-continue dialog
      // (Connect/Skip) instead of the free-text answer field. Mirrors the chat
      // feed's ClarificationCard discrimination so both interrupt surfaces agree.
      return (active.data as { profile?: unknown } | null)?.profile === 'openwop-connection'
        ? <ConnectionRequiredDialog {...props} />
        : <ClarificationDialog {...props} />;
    case 'refinement':
      return <RefinementForm {...props} />;
    case 'cancellation':
      return <CancellationBanner {...props} />;
    default:
      return (
        <div role="status" className="alert warning">
          {t('unknownKindBody', { kind: active.kind })}
        </div>
      );
  }
}
