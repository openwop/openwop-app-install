/**
 * Built-in card registrations: the 4 OpenWOP interrupt kinds.
 *
 * Adopters who want to override one of these can call `registerCard()`
 * with the same cardType — the second registration wins (with a
 * console.warn).
 */

import { Button } from '../../ui/Button.js';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveByRun } from '../../client/interruptsClient.js';
import { registerCard } from './CardRegistry.js';
import type { CardProps } from './types.js';
import { ConnectionRequiredCard } from '../cards/ConnectionRequiredCard.js';
import { TextField, TextareaField } from '../../ui/Field.js';
import { GateEvidence, hasGateEvidence } from '../reviews/GateEvidence.js';
import { Notice } from '../../ui/index.js';
import { useReviewStatusByRunNode } from '../reviews/reviewStatusStore.js';
import { confirm } from '../../ui/confirm.js';
import i18n from '../../i18n/index.js';

interface ApprovalOption {
  key: string;
  label: string;
  content: string;
}

interface InterruptPayload {
  data?: {
    prompt?: string;
    question?: string;
    actions?: readonly string[];
    current?: unknown;
    reason?: string;
    /** When set, the approval node has bundled its upstream input ports
     *  as discrete options the approver should pick between. Rendered
     *  as expandable cards with a per-option "Pick" button. The chosen
     *  option's `content` becomes the resume value so downstream nodes
     *  receive the selected text directly.
     *
     *  **Producer↔consumer coupling** — the BE `approvalGateNode`
     *  (`backend/typescript/src/bootstrap/nodes.ts`)
     *  bundles this array when 2+ string-valued input ports land on the
     *  approval node. This consumer (`ApprovalCard` below) renders it
     *  as a per-option picker. Both sides MUST move together when the
     *  shape changes — there's no spec/v1 schema for this field yet
     *  (sample-app contract; spec promotion is a follow-up). */
    options?: readonly ApprovalOption[];
    /** ADR 0083 — the durable run-artifact the gate persisted for THIS suspend
     *  (the upstream output being approved). Lets the card preview ANY content
     *  type (object outputs like an email draft / variance result that aren't a
     *  string `option`) by fetching the artifact revision on demand. */
    artifactId?: string;
    revisionId?: string;
    /** ADR 0193 — a `kind:'approval'` suspend raised by `core.email.send` before
     *  it sends AS the connected human. `profile` discriminates this from an
     *  ordinary gate (mirrors ADR 0189's `openwop-connection`); `message` carries
     *  the rendered, about-to-be-sent envelope so the approver sees EXACTLY what
     *  will leave their mailbox — the approved-bytes-verbatim preview. */
    profile?: string;
    message?: {
      to?: string | readonly string[];
      subject?: string;
      bodyPreview?: string;
      html?: string;
      provider?: string;
    };
  };
}

/** The gate's friendly name (builder label, e.g. "Legal review") as a card
 *  eyebrow — so a reviewer always knows WHICH gate a card is, even for a single
 *  gate (the prior per-stack chip only showed when ≥2 gates were open). */
export function GateEyebrow({ name }: { name?: string | undefined }): JSX.Element | null {
  if (!name) return null;
  return <div className="approval-card-eyebrow">{name}</div>;
}

// ── interrupt.approval ─────────────────────────────────────────────────

// Localized labels for the canonical approval actions — shared with the
// run-detail twin via the `interrupts` namespace (CHAT-2). Unknown actions
// (hosts may extend `data.actions`) fall back to the raw string.
const ACTION_LABEL_KEYS: Record<string, string> = {
  approve: 'interrupts:actionApprove',
  reject: 'interrupts:actionReject',
  'request-changes': 'interrupts:actionRequestChanges',
  defer: 'interrupts:actionDefer',
  escalate: 'interrupts:actionEscalate',
};

function ApprovalCard({ payload, onAction, isLoading, context }: CardProps): JSX.Element {
  const { t } = useTranslation('chat');
  const data = (payload as InterruptPayload).data ?? {};
  const [comment, setComment] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // DESIGN.md §11 (CHAT-4): move focus into the response form when the gate
  // appears, mirroring the run-detail cards' focus behavior — a keyboard/SR
  // user is taken to the new gate instead of discovering it by scroll.
  const focusRef = useRef<HTMLInputElement>(null);
  useEffect(() => { focusRef.current?.focus(); }, []);
  const prompt = data.prompt ?? t('pleaseApprove');
  const actions = (data.actions ?? ['approve', 'reject', 'request-changes', 'defer', 'escalate']);
  const options = data.options ?? [];
  // Picker only makes sense when there are ≥2 alternatives to choose
  // between. A single string input on the approval node falls through
  // to the plain approve/reject path — the approver has nothing to
  // *pick* among, just to approve or reject the run continuing.
  const hasOptions = options.length >= 2;
  // ADR 0083 — the concrete content under review. String input ports arrive inline as
  // `options`; everything else (an email-draft object, a variance result, an LLM draft) is
  // fetched on demand from the durable run-artifact the gate persisted (`data.artifactId`),
  // so the approver ALWAYS sees what they're approving — never a dead-end card.
  // The single-content approve/reject case shows the content INLINE (auto-loaded)
  // so the reviewer never has to click into a modal just to see what they're
  // approving. The ≥2-options case keeps the per-option picker below instead.
  // ADR 0600 §Correction 1 — the ADR 0193 send-approval envelope used to be a
  // SECOND preview block open-coded right here, and `interrupts/ApprovalCard`
  // had no copy of it. That is precisely the drift §2 said one shared component
  // would end; §2 shared the artifact/options lanes and left this one behind, so
  // the inbox card rendered "Nothing was captured for this gate" over a payload
  // holding the exact bytes about to be sent as the user. `GateEvidence` owns
  // the envelope now, `hasGateEvidence` counts it, and this card has no private
  // rendering left to drift with.
  const showInlinePreview = !hasOptions && hasGateEvidence(data);


  // ADR 0074 — if this review was decided on ANOTHER surface (Reviews tab, Runs
  // screen, another client), the shared store knows before this run's SSE swaps
  // the card for the resolved decision. Disable the now-stale actions and say so,
  // so a click can't 409. Matched by the run/node index the broadcast carries.
  const liveStatus = useReviewStatusByRunNode(context.runId, context.nodeId);
  const resolvedElsewhere = liveStatus !== undefined && liveStatus !== 'pending';
  const disabled = isLoading || resolvedElsewhere;

  // ADR 0600 §Correction 5 (`ISU-12`) — §7 confirmed REJECT on
  // `interrupts/ApprovalCard` and left THIS card, which is the other half of the
  // same pair §2 had just finished unifying. The verb is identical on both: a
  // rejected `core.approvalGate` appends `run.failed` with `approval_rejected`
  // and never resolves the suspend, discarding the query, the model call and the
  // reviewer's attention. A confirm on one of two surfaces is not a confirm.
  // APPROVE stays ungated here for §7's stated reason — friction on the common
  // path is what teaches people to click through the one that matters — and the
  // ≥2-option "Pick this" button is an approve, so it is ungated too.
  async function resolveWithRejectConfirm(action: string): Promise<void> {
    if (action === 'reject' && !(await confirm({
      title: t('interrupts:rejectConfirmTitle'),
      body: t('interrupts:rejectConfirmBody'),
      danger: true,
      confirmLabel: t('interrupts:actionReject'),
    }))) return;
    await onAction('resolve', { action, comment: comment || undefined });
  }

  return (
    <div className="card u-bg-surface-2 approval-card">
      <GateEyebrow name={context?.nodeName} />
      <h3 className="u-mbox-b2 u-fs-13">{t('approvalRequired')}</h3>
      {context?.workflowName ? (
        <p className="muted u-fs-11 u-mbox-b1">{t('reviewFromWorkflow', { workflow: context.workflowName })}</p>
      ) : null}
      <p className="u-mbox-b2 u-fs-13">{prompt}</p>
      {resolvedElsewhere && <Notice variant="info">{t('reviewResolvedElsewhere')}</Notice>}

      {/* ADR 0600 §2 — the evidence block is now ONE component shared with
          `interrupts/ApprovalCard`, which rendered none of this. The ≥2-option
          PICKER below stays here: it chooses a resume VALUE, which only this
          card can carry. */}
      {showInlinePreview ? <GateEvidence data={data} title={prompt} /> : null}

      {hasOptions && (
        <div className="defcards-options">
          {options.map((opt) => {
            const isOpen = expanded[opt.key] ?? false;
            return (
              <div key={opt.key} className="defcards-option">
                <div className="u-flex u-justify-between u-items-center u-gap-2">
                  <span className="u-fw-600 u-fs-12">{opt.label}</span>
                  <div className="u-flex u-gap-1-5">
                    <Button
                      variant="secondary" className="u-fs-11 u-pad-2x8"
                      onClick={() => setExpanded((s) => ({ ...s, [opt.key]: !isOpen }))}
                      aria-expanded={isOpen}
                    >
                      {isOpen ? t('hide') : t('view')}
                    </Button>
                    <Button
                      variant="primary" className="u-fs-11 u-pad-2x10"
                      disabled={disabled}
                      // Resume payload shape is wedged between two
                      // constraints:
                      //   1. BE `validateResumeValue` (routes/interrupts.ts
                      //      §approval) REQUIRES `resumeValue.action`
                      //      to be one of `data.actions` (`approve` /
                      //      `reject`). A bare string is rejected with
                      //      400 and the workflow stays suspended.
                      //   2. Downstream consumers read the approval
                      //      node's output as `{output: <resumeValue>}`
                      //      via the standard edge path. We want the
                      //      *picked content* to be what the next
                      //      uppercase / chat / final-format node sees
                      //      on its input port.
                      // Solution: send `{action: 'approve', content,
                      // selectedKey, ...}`. `action` satisfies #1;
                      // `content` is the nested key the executor's
                      // findFirstStringValue() walks last (`['prompt',
                      // 'text', 'message', 'content', 'completion']`),
                      // so downstream nodes pull the picked text out
                      // automatically. `selectedKey` rides along for
                      // audit / debugging.
                      onClick={() => onAction('resolve', {
                        action: 'approve',
                        content: opt.content,
                        selectedKey: opt.key,
                        ...(comment ? { comment } : {}),
                      })}
                    >
                      {t('pickThis')}
                    </Button>
                  </div>
                </div>
                {isOpen && (
                  <pre className="defcards-option-content">{opt.content}</pre>
                )}
              </div>
            );
          })}
        </div>
      )}

      <TextField
        ref={focusRef}
        label={t('commentOptional')}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder={t('visibleInAuditTrail')}
      />
      <div className="button-row u-wrap u-gap-1-5">
        {actions
          // When the picker is active, hide the bottom "approve"
          // button — its semantics are contradictory (downstream
          // would forward the literal string "approve" instead of
          // any critic's content). Force the user to either Pick
          // one or Reject. Other actions (`reject`, `request-changes`,
          // etc.) still render.
          .filter((action) => !(hasOptions && action === 'approve'))
          .map((action) => (
            <Button
              key={action}
              variant={action === 'approve' && !hasOptions ? 'primary' : 'secondary'}
              disabled={disabled}
              onClick={() => { void resolveWithRejectConfirm(action); }}
            >
              {ACTION_LABEL_KEYS[action] ? t(ACTION_LABEL_KEYS[action]) : action}
            </Button>
          ))}
      </div>
    </div>
  );
}

// ── interrupt.clarification ────────────────────────────────────────────

// ADR 0189 — a connection prompt rides the clarification kind but carries a
// distinct profile; dispatch to the connect-to-continue card instead of the
// free-text answer field. The dispatcher is HOOK-FREE so both branches obey
// rules-of-hooks (the old inline guard made every hook below it conditional).
function ClarificationCard(props: CardProps): JSX.Element {
  const profile = ((props.payload as InterruptPayload).data as { profile?: unknown } | undefined)?.profile;
  if (profile === 'openwop-connection') {
    return <ConnectionRequiredCard {...props} />;
  }
  return <FreeTextClarificationCard {...props} />;
}

function FreeTextClarificationCard(props: CardProps): JSX.Element {
  const { payload, onAction, isLoading, context } = props;
  const { t } = useTranslation('chat');
  const data = (payload as InterruptPayload).data ?? {};
  const [answer, setAnswer] = useState('');
  // Labeled field + focus-on-appear, mirroring the run-detail
  // ClarificationDialog (CHAT-1 / CHAT-4).
  const focusRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { focusRef.current?.focus(); }, []);
  return (
    <div className="card u-bg-surface-2">
      <GateEyebrow name={context?.nodeName} />
      <h3 className="u-mbox-b2 u-fs-13">{t('clarificationNeeded')}</h3>
      <p className="u-mbox-b2 u-fs-13">{data.question ?? t('pleaseClarify')}</p>
      <TextareaField ref={focusRef} label={t('interrupts:answerLabel')} rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} />
      <div className="button-row">
        <Button variant="primary" disabled={isLoading || !answer.trim()} onClick={() => onAction('resolve', { answer })}>
          {t('submit')}
        </Button>
      </div>
    </div>
  );
}

// ── interrupt.refinement ───────────────────────────────────────────────

function RefinementCard({ payload, onAction, isLoading, context }: CardProps): JSX.Element {
  const { t } = useTranslation('chat');
  const seed = (payload as InterruptPayload).data?.current ?? '';
  const [draft, setDraft] = useState(typeof seed === 'string' ? seed : JSON.stringify(seed, null, 2));
  // Labeled field + focus-on-appear, mirroring the run-detail RefinementForm
  // (CHAT-1 / CHAT-4).
  const focusRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { focusRef.current?.focus(); }, []);
  return (
    <div className="card u-bg-surface-2">
      <GateEyebrow name={context?.nodeName} />
      <h3 className="u-mbox-b2 u-fs-13">{t('refinementRequested')}</h3>
      <TextareaField ref={focusRef} label={t('interrupts:draftLabel')} rows={6} value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
      <div className="button-row">
        <Button variant="primary"
          disabled={isLoading}
          onClick={() => {
            let parsed: unknown = draft;
            try { parsed = JSON.parse(draft); } catch { /* tolerate non-JSON */ }
            onAction('resolve', { refinement: parsed });
          }}
        >
          {t('submitRefinement')}
        </Button>
      </div>
    </div>
  );
}

// ── interrupt.cancellation ─────────────────────────────────────────────

function CancellationCard({ payload, onAction, isLoading, context }: CardProps): JSX.Element {
  const { t } = useTranslation('chat');
  const reason = (payload as InterruptPayload).data?.reason ?? t('cancellationRequestedBody');
  return (
    <div className="card u-bg-surface-2">
      <GateEyebrow name={context?.nodeName} />
      <h3 className="u-mbox-b2 u-fs-13">{t('cancellationRequested')}</h3>
      <div className="alert warning u-mb-2">{reason}</div>
      <div className="button-row">
        <Button variant="primary" disabled={isLoading} onClick={() => onAction('resolve', { acknowledged: true, confirm: true })}>
          {t('confirmCancel')}
        </Button>
        <Button variant="secondary" disabled={isLoading} onClick={() => onAction('resolve', { acknowledged: true, confirm: false })}>
          {t('decline')}
        </Button>
      </div>
    </div>
  );
}

// ── canonical resolver: bubbles up the action to the openwop interrupt API ──

async function resolveInterrupt(actionPayload: unknown, ctx: { runId: string; nodeId?: string }): Promise<boolean> {
  if (!ctx.nodeId) return false;
  await resolveByRun(ctx.runId, ctx.nodeId, actionPayload);
  return true;
}

// ── default registrations ──────────────────────────────────────────────

let registered = false;

export function registerDefaultCards(): void {
  if (registered) return;
  registerCard({
    cardType: 'interrupt.approval',
    label: i18n.t('chat:cardLabelApproval'),
    Component: ApprovalCard,
    actionHandlers: { resolve: resolveInterrupt },
  });
  registerCard({
    cardType: 'interrupt.clarification',
    label: i18n.t('chat:cardLabelClarification'),
    Component: ClarificationCard,
    actionHandlers: { resolve: resolveInterrupt },
  });
  registerCard({
    cardType: 'interrupt.refinement',
    label: i18n.t('chat:cardLabelRefinement'),
    Component: RefinementCard,
    actionHandlers: { resolve: resolveInterrupt },
  });
  registerCard({
    cardType: 'interrupt.cancellation',
    label: i18n.t('chat:cardLabelCancellation'),
    Component: CancellationCard,
    actionHandlers: { resolve: resolveInterrupt },
  });
  registered = true;
}
