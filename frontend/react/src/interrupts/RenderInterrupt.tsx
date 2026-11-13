/**
 * Shared interrupt renderer — maps an OpenInterrupt to the correct
 * resume UI (approve/reject, clarification, refinement, cancellation)
 * and calls `/resume` via the card. Used by both the per-run detail
 * page and the cross-run HITL inbox so the kind→card mapping lives in
 * one place.
 */

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { OpenInterrupt } from '../client/interruptsClient.js';
import { formatDateTime } from '../i18n/format.js';
import { ApprovalCard } from './ApprovalCard.js';
import { ClarificationDialog } from './ClarificationDialog.js';
import { ConnectionRequiredDialog } from './ConnectionRequiredDialog.js';
import { RefinementForm } from './RefinementForm.js';
import { CancellationBanner } from './CancellationBanner.js';
import { requestWords } from './requestWords.js';

/** CC-UI-2 — when a `timer` interrupt resumes, mirroring the backend's
 *  `timerDeadlineMs` (executor/timerResume.ts): `until` is an absolute
 *  timestamp; otherwise `createdAt + seconds`. Null when neither is usable. */
export function timerResumesAt(i: OpenInterrupt): Date | null {
  const d = (i.data ?? {}) as { kind?: unknown; seconds?: unknown; timestamp?: unknown };
  if (d.kind === 'until' && typeof d.timestamp === 'string') {
    const t = Date.parse(d.timestamp);
    return Number.isFinite(t) ? new Date(t) : null;
  }
  const created = Date.parse(i.createdAt);
  if (typeof d.seconds === 'number' && d.seconds >= 0 && Number.isFinite(created)) return new Date(created + d.seconds * 1000);
  return null;
}

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
    // CC-UI-2 — neither waits on a reply from this page, so neither gets a card;
    // both say plainly what the run is waiting for.
    case 'timer': {
      const at = timerResumesAt(active);
      return (
        <div role="status" className="alert">
          {at ? t('timerWaitsUntil', { when: formatDateTime(at) }) : t('timerWaits')}
        </div>
      );
    }
    case 'walkthrough-step':
    case 'tour-step':
      return (
        <div role="status" className="alert">
          {t('walkthroughStepBody')} <Link to="/walkthroughs">{t('walkthroughStepLink')}</Link>
        </div>
      );
    default: {
      // ADR 1109 D7 — say what the step asks, even when this app cannot answer it.
      // No buttons: guessing a resume value for a schema the app cannot read could
      // resolve the step wrongly.
      const words = requestWords(active.data);
      return (
        <div role="status" className="alert warning">
          {words.title ? <p className="u-m-0"><strong>{words.title}</strong></p> : null}
          {words.text ? <p className="u-m-0">{words.text}</p> : null}
          <p className="u-m-0">{t('unknownKindBody', { kind: active.kind })}</p>
        </div>
      );
    }
  }
}
