import { Button } from '../ui/Button.js';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveByRun } from '../client/interruptsClient.js';
import { TextField } from '../ui/Field.js';
import { Notice } from '../ui/index.js';
import { decideErrorMessage } from './decideErrorMessage.js';
import { useReviewStatusByRunNode } from '../chat/reviews/reviewStatusStore.js';
import { confirm } from '../ui/confirm.js';
import { GateEvidence, isBrowserActionGate } from '../chat/reviews/GateEvidence.js';

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
  // ADR 0778 (`APUX-6`, WCAG 2.1.2) — NO focus trap. This card renders INLINE
  // (the run page, `/inbox`, one per action-needed row), not as a modal: a
  // trap here held Tab inside whichever card mounted last, so a keyboard user
  // could not reach the rest of the page. DESIGN.md §11 is corrected to trap
  // only modal presentations.
  const headingId = useId();
  const commentRef = useRef<HTMLInputElement>(null);
  // CHAT-5: the `disabled={submitting}` guard relies on a re-render; a
  // same-tick double-click (or a synthetic double-fire) can pass it twice and
  // resolve the interrupt twice. A synchronous ref closes that window — the
  // second call is dropped before it reaches the network.
  const inFlight = useRef(false);

  const prompt = ((data as { prompt?: string })?.prompt) ?? t('approvalDefaultPrompt');
  // ADR 0778 (`APUX-7`) — a gate may declare verbs beyond the five this card
  // knows (`accept`, …). They used to be cast into the known set and rendered
  // `t(undefined)`: a button with no accessible name (WCAG 4.1.2).
  const allowedActions = ((data as { actions?: readonly string[] })?.actions ?? APPROVAL_ACTIONS) as readonly string[];
  const actionLabel = (action: string): string =>
    action in ACTION_LABEL_KEYS ? t(ACTION_LABEL_KEYS[action as ApprovalAction]) : action.charAt(0).toUpperCase() + action.slice(1).replace(/[-_]/g, ' ');

  // ADR 0074 — reflect a decision made on another surface/client live: the
  // shared store learns of it via the broadcast signal (matched by run+node),
  // so disable the now-stale actions before this page's own run SSE resolves.
  const liveStatus = useReviewStatusByRunNode(runId, nodeId);
  // Closing review B2 — this card's OWN decision also flips the shared status
  // (the broadcast can beat the parent's refetch), and it must not then be
  // announced as "resolved elsewhere".
  const [decidedHere, setDecidedHere] = useState(false);
  const resolvedElsewhere = !decidedHere && liveStatus !== undefined && liveStatus !== 'pending';
  const disabled = submitting || resolvedElsewhere;

  async function send(action: string) {
    if (inFlight.current) return;
    // ADR 0600 §7 (`ISU-12`) — REJECT is the irreversible verb and it was one
    // unconfirmed click straight to the network. It fails the run (a rejected
    // `core.approvalGate` appends `run.failed` with `approval_rejected` and
    // never resolves the suspend), discarding whatever the run already spent —
    // a warehouse query, an LLM call, and this person's attention. Run DELETION
    // on the very next surface over already confirms; this did not. Approve is
    // deliberately NOT gated: it continues a run the user asked for, and a
    // confirm on the common path is the kind of friction people learn to click
    // through, which would weaken this one.
    // ADR 0894 — a browser-action gate's reject ends the browser SESSION, not
    // the run (the decide node records the denial and the run completes), so
    // the generic "fail the run" copy would misdescribe it.
    const browserGate = isBrowserActionGate(data);
    if (action === 'reject' && !(await confirm({
      title: t(browserGate ? 'cuRejectConfirmTitle' : 'rejectConfirmTitle'),
      body: t(browserGate ? 'cuRejectConfirmBody' : 'rejectConfirmBody'),
      danger: true,
      confirmLabel: t('actionReject'),
    }))) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await resolveByRun(runId, nodeId, { action, comment: comment || undefined });
      setDecidedHere(true);
      onResolved();
    } catch (err) {
      setError(decideErrorMessage(t, err)); // ADR 0778 (`APUX-5`) — never the raw server text
      // Only release the guard on failure — a success unmounts/!resolves the
      // card, so we never want to allow a second resolve after a 2xx.
      inFlight.current = false;
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card" role="group" aria-labelledby={headingId}>
      <h2 id={headingId}>{t('approvalRequired')}</h2>
      <p>{prompt}</p>
      {/* ADR 0600 §2 (`ISU-10`) — THE evidence. This card is where the interrupt
          notification's `actionUrl: '/inbox'` actually lands, and it used to read
          exactly two keys (`prompt`, `actions`): "Confirm the variance figures"
          with no figures, "Review the recognition draft" with no draft. The
          artifact was on the wire the whole time — `executor.ts` binds
          `artifactId`/`revisionId` onto the interrupt and `listOpenInterrupts`
          returns them verbatim. Shared with the chat card so the two surfaces
          cannot drift apart again. */}
      <GateEvidence data={data} title={prompt} />
      <TextField label={t('commentLabel')} ref={commentRef} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t('commentPlaceholder')} />
      {resolvedElsewhere && <Notice variant="info" announce={t('resolvedElsewhere')}>{t('resolvedElsewhere')}</Notice>}
      {error && <Notice variant="error" announce={error}>{error}</Notice>}
      <div className="button-row">
        {allowedActions.map((action) => (
          <Button
            key={action}
            disabled={disabled}
            variant={action === 'approve' ? 'accent-solid' : 'secondary'}
            onClick={() => send(action)}
          >
            {actionLabel(action)}
          </Button>
        ))}
      </div>
    </div>
  );
}
