import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveByRun } from '../client/interruptsClient.js';
import { TextField } from '../ui/Field.js';
import { Notice } from '../ui/index.js';
import { useFocusTrap } from '../ui/useFocusTrap.js';
import { useReviewStatusByRunNode } from '../chat/reviews/reviewStatusStore.js';

interface Props {
  runId: string;
  nodeId: string;
  token: string;
  data: unknown;
  onResolved: () => void;
}

const APPROVAL_ACTIONS = ['approve', 'reject', 'request-changes', 'defer', 'escalate'] as const;
type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

const ACTION_LABEL_KEYS: Record<ApprovalAction, string> = {
  approve: 'actionApprove',
  reject: 'actionReject',
  'request-changes': 'actionRequestChanges',
  defer: 'actionDefer',
  escalate: 'actionEscalate',
};

export function ApprovalCard({ runId, nodeId, data, onResolved }: Props) {
  const { t } = useTranslation('interrupts');
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // HITL a11y (GAP-ANALYSIS E6, DESIGN §11): the approval card traps focus into
  // the response form on render — the hook focuses the first focusable (the
  // comment input) and cycles Tab/Shift+Tab within the card, releasing focus
  // only on submission / dismissal. The comment input stays label-associated.
  const headingId = useId();
  const commentRef = useRef<HTMLInputElement>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(true);
  // CHAT-5: the `disabled={submitting}` guard relies on a re-render; a
  // same-tick double-click (or a synthetic double-fire) can pass it twice and
  // resolve the interrupt twice. A synchronous ref closes that window — the
  // second call is dropped before it reaches the network.
  const inFlight = useRef(false);

  const prompt = ((data as { prompt?: string })?.prompt) ?? t('approvalDefaultPrompt');
  const allowedActions = ((data as { actions?: readonly string[] })?.actions ?? APPROVAL_ACTIONS) as readonly ApprovalAction[];

  // ADR 0074 — reflect a decision made on another surface/client live: the
  // shared store learns of it via the broadcast signal (matched by run+node),
  // so disable the now-stale actions before this page's own run SSE resolves.
  const liveStatus = useReviewStatusByRunNode(runId, nodeId);
  const resolvedElsewhere = liveStatus !== undefined && liveStatus !== 'pending';
  const disabled = submitting || resolvedElsewhere;

  async function send(action: ApprovalAction) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await resolveByRun(runId, nodeId, { action, comment: comment || undefined });
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Only release the guard on failure — a success unmounts/!resolves the
      // card, so we never want to allow a second resolve after a 2xx.
      inFlight.current = false;
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card" role="group" aria-labelledby={headingId} ref={trapRef}>
      <h2 id={headingId}>{t('approvalRequired')}</h2>
      <p>{prompt}</p>
      <TextField label={t('commentLabel')} ref={commentRef} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t('commentPlaceholder')} />
      {resolvedElsewhere && <Notice variant="info">{t('resolvedElsewhere')}</Notice>}
      {error && <div className="alert error">{error}</div>}
      <div className="button-row">
        {allowedActions.map((action) => (
          <button
            key={action}
            disabled={disabled}
            className={action === 'approve' ? 'btn-accent-solid' : 'secondary'}
            onClick={() => send(action)}
          >
            {t(ACTION_LABEL_KEYS[action])}
          </button>
        ))}
      </div>
    </div>
  );
}
