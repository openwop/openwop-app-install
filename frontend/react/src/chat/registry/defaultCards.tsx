/**
 * Built-in card registrations: the 4 OpenWOP interrupt kinds.
 *
 * Adopters who want to override one of these can call `registerCard()`
 * with the same cardType — the second registration wins (with a
 * console.warn).
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveByRun } from '../../client/interruptsClient.js';
import { registerCard } from './CardRegistry.js';
import type { CardProps } from './types.js';
import { TextField } from '../../ui/Field.js';
import { AssetPreview } from '../reviews/AssetPreview.js';
import { AssetPreviewModal } from '../reviews/AssetPreviewModal.js';
import type { ReviewAsset } from '../reviews/reviewClient.js';
import { getArtifactRevision } from '../artifacts/artifactClient.js';
import { FileTextIcon, SearchIcon } from '../../ui/icons/index.js';
import { Notice } from '../../ui/index.js';
import { useReviewStatusByRunNode } from '../reviews/reviewStatusStore.js';
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
  };
}

/** The gate's friendly name (builder label, e.g. "Legal review") as a card
 *  eyebrow — so a reviewer always knows WHICH gate a card is, even for a single
 *  gate (the prior per-stack chip only showed when ≥2 gates were open). */
function GateEyebrow({ name }: { name?: string | undefined }): JSX.Element | null {
  if (!name) return null;
  return <div className="approval-card-eyebrow">{name}</div>;
}

// ── interrupt.approval ─────────────────────────────────────────────────

function ApprovalCard({ payload, onAction, isLoading, context }: CardProps): JSX.Element {
  const { t } = useTranslation('chat');
  const data = (payload as InterruptPayload).data ?? {};
  const [comment, setComment] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [previewOpen, setPreviewOpen] = useState(false);
  const [artifactAssets, setArtifactAssets] = useState<ReviewAsset[] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
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
  const inlineAssets: ReviewAsset[] = options.map((o) => ({ label: o.label, content: o.content }));
  const artifactId = typeof data.artifactId === 'string' ? data.artifactId : undefined;
  const revisionId = typeof data.revisionId === 'string' ? data.revisionId : undefined;
  const canPreview = inlineAssets.length > 0 || !!artifactId;
  const previewAssets: ReviewAsset[] = inlineAssets.length > 0 ? inlineAssets : (artifactAssets ?? []);
  // The single-content approve/reject case shows the content INLINE (auto-loaded)
  // so the reviewer never has to click into a modal just to see what they're
  // approving. The ≥2-options case keeps the per-option picker below instead.
  const showInlinePreview = !hasOptions && canPreview;
  const inlinePreviewAsset = previewAssets[0];

  async function loadArtifact(): Promise<void> {
    if (inlineAssets.length === 0 && artifactId && revisionId && artifactAssets === null) {
      setPreviewLoading(true);
      try {
        const rev = await getArtifactRevision(artifactId, revisionId);
        setArtifactAssets([{ label: prompt, content: rev.content ?? '', artifactId, revisionId }]);
      } catch {
        setArtifactAssets([]); // surface the empty-state inline rather than failing
      } finally {
        setPreviewLoading(false);
      }
    }
  }

  // Auto-load the artifact-backed content for the inline preview on mount, so the
  // approver sees the draft without a click. Inline `options` are already present.
  useEffect(() => {
    if (showInlinePreview) void loadArtifact();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showInlinePreview, artifactId, revisionId]);

  // ADR 0074 — if this review was decided on ANOTHER surface (Reviews tab, Runs
  // screen, another client), the shared store knows before this run's SSE swaps
  // the card for the resolved decision. Disable the now-stale actions and say so,
  // so a click can't 409. Matched by the run/node index the broadcast carries.
  const liveStatus = useReviewStatusByRunNode(context.runId, context.nodeId);
  const resolvedElsewhere = liveStatus !== undefined && liveStatus !== 'pending';
  const disabled = isLoading || resolvedElsewhere;

  return (
    <div className="card u-bg-surface-2 approval-card">
      <GateEyebrow name={context?.nodeName} />
      <h3 className="u-mbox-b2 u-fs-13">{t('approvalRequired')}</h3>
      {context?.workflowName ? (
        <p className="muted u-fs-11 u-mbox-b1">{t('reviewFromWorkflow', { workflow: context.workflowName })}</p>
      ) : null}
      <p className="u-mbox-b2 u-fs-13">{prompt}</p>
      {resolvedElsewhere && <Notice variant="info">{t('reviewResolvedElsewhere')}</Notice>}

      {showInlinePreview ? (
        <div className="approval-preview u-mbox-b2">
          <div className="approval-preview-head">
            <span className="approval-preview-label u-iflex u-items-center u-gap-1-5">
              <FileTextIcon size={13} aria-hidden /> {t('underReview')}
            </span>
            {inlinePreviewAsset?.content ? (
              <button
                type="button"
                className="btn-ghost u-fs-11 u-pad-2x8 u-iflex u-items-center u-gap-1"
                onClick={() => setPreviewOpen(true)}
              >
                <SearchIcon size={12} aria-hidden /> {t('viewFull')}
              </button>
            ) : null}
          </div>
          <div className="approval-preview-body">
            {previewLoading
              ? <p className="muted u-fs-12 u-m-0">{t('previewLoading')}</p>
              : inlinePreviewAsset
                ? <AssetPreview asset={inlinePreviewAsset} hideLabel />
                : <p className="muted u-fs-12 u-m-0">{t('assetPreviewNone')}</p>}
          </div>
        </div>
      ) : null}
      {previewOpen ? (
        <AssetPreviewModal open assets={previewAssets} title={prompt} onClose={() => setPreviewOpen(false)} />
      ) : null}

      {hasOptions && (
        <div className="defcards-options">
          {options.map((opt) => {
            const isOpen = expanded[opt.key] ?? false;
            return (
              <div key={opt.key} className="defcards-option">
                <div className="u-flex u-justify-between u-items-center u-gap-2">
                  <span className="u-fw-600 u-fs-12">{opt.label}</span>
                  <div className="u-flex u-gap-1-5">
                    <button
                      type="button"
                      className="secondary u-fs-11 u-pad-2x8"
                      onClick={() => setExpanded((s) => ({ ...s, [opt.key]: !isOpen }))}
                      aria-expanded={isOpen}
                    >
                      {isOpen ? t('hide') : t('view')}
                    </button>
                    <button
                      type="button"
                      className="u-fs-11 u-pad-2x10"
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
                    </button>
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
            <button
              key={action}
              className={action === 'approve' && !hasOptions ? '' : 'secondary'}
              disabled={disabled}
              onClick={() => onAction('resolve', { action, comment: comment || undefined })}
            >
              {action}
            </button>
          ))}
      </div>
    </div>
  );
}

// ── interrupt.clarification ────────────────────────────────────────────

function ClarificationCard({ payload, onAction, isLoading, context }: CardProps): JSX.Element {
  const { t } = useTranslation('chat');
  const data = (payload as InterruptPayload).data ?? {};
  const [answer, setAnswer] = useState('');
  return (
    <div className="card u-bg-surface-2">
      <GateEyebrow name={context?.nodeName} />
      <h3 className="u-mbox-b2 u-fs-13">{t('clarificationNeeded')}</h3>
      <p className="u-mbox-b2 u-fs-13">{data.question ?? t('pleaseClarify')}</p>
      <div className="form-row">
        <textarea rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} />
      </div>
      <div className="button-row">
        <button disabled={isLoading || !answer.trim()} onClick={() => onAction('resolve', { answer })}>
          {t('submit')}
        </button>
      </div>
    </div>
  );
}

// ── interrupt.refinement ───────────────────────────────────────────────

function RefinementCard({ payload, onAction, isLoading, context }: CardProps): JSX.Element {
  const { t } = useTranslation('chat');
  const seed = (payload as InterruptPayload).data?.current ?? '';
  const [draft, setDraft] = useState(typeof seed === 'string' ? seed : JSON.stringify(seed, null, 2));
  return (
    <div className="card u-bg-surface-2">
      <GateEyebrow name={context?.nodeName} />
      <h3 className="u-mbox-b2 u-fs-13">{t('refinementRequested')}</h3>
      <div className="form-row">
        <textarea rows={6} value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
      </div>
      <div className="button-row">
        <button
          disabled={isLoading}
          onClick={() => {
            let parsed: unknown = draft;
            try { parsed = JSON.parse(draft); } catch { /* tolerate non-JSON */ }
            onAction('resolve', { refinement: parsed });
          }}
        >
          {t('submitRefinement')}
        </button>
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
        <button disabled={isLoading} onClick={() => onAction('resolve', { acknowledged: true, confirm: true })}>
          {t('confirmCancel')}
        </button>
        <button className="secondary" disabled={isLoading} onClick={() => onAction('resolve', { acknowledged: true, confirm: false })}>
          {t('decline')}
        </button>
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
