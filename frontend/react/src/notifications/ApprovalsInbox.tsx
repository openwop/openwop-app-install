/**
 * ApprovalsInbox — the "agents propose, humans dispose" queue, embedded in the
 * /inbox page. It is the ONE approval surface for every roster member, and it
 * renders polymorphically on the approval's kind:
 *
 *   - run-proposal   — a review-mode heartbeat picked work but didn't run it.
 *     A compact DataTable row: "Run workflow X on card Y". CLAIMING starts the
 *     proposed run (the output + its provenance show up on that run, not here),
 *     so the copy says so and the row navigates to the new run.
 *
 *   - assistant-action — an agent (the Chief of Staff) drafted an outbound
 *     action (email/invite/reschedule/nudge) from connected content. A rich
 *     ActionCard: kind + destination, risk tier, taint banner, draft preview,
 *     recipient diff, why-recommended, and source citations — everything an
 *     approver needs to decide with confidence. APPROVING decides the action
 *     through the same claim path (it does NOT start a workflow run, so there
 *     is nothing to navigate to); EDIT re-drafts and re-queues it for approval.
 *
 * Both kinds share the single durable queue + claim/reject routes
 * (host/approvalService.ts); the rich card metadata rides on the approval row
 * (`a.action`), projected by the assistant feature.
 */

import { useCallback, useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { formatDateTime } from '../i18n/format.js';
import { DataTable, type DataColumn } from '../ui/DataTable.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { Notice } from '../ui/Notice.js';
import { toast } from '../ui/toast.js';
import { ScaleIcon, CheckIcon, XIcon } from '../ui/icons/index.js';
import {
  listApprovals,
  claimApproval,
  rejectApproval,
  editAssistantAction,
  type PendingApproval,
  type AssistantActionView,
} from '../agents/approvalsClient.js';
import { workflowName } from '../agents/roleTemplates.js';
import { relativeTime } from '../agents/agentViewModel.js';

const isAssistantAction = (a: PendingApproval): boolean => a.kind === 'assistant-action' || !!a.actionId;
const isContentPublish = (a: PendingApproval): boolean => a.kind === 'content-publish';

/** SECURITY — source URLs come from provider-derived (explicitly untrusted)
 *  content; only http(s) schemes may bind to an href (a `javascript:` URL
 *  would execute on click). Anything else renders as plain text. */
const safeHref = (u?: string): string | undefined => (u && /^https?:\/\//i.test(u) ? u : undefined);

function destinationOf(action: AssistantActionView): string | null {
  const to = action.payload?.to;
  if (Array.isArray(to)) return to.filter((x): x is string => typeof x === 'string').join(', ');
  return typeof to === 'string' ? to : null;
}

/**
 * Rich action card (ADR 0023 §12 T4): kind + destination, risk tier, taint
 * banner, draft preview, recipient diff, why-recommended, source citations —
 * everything an approver needs to decide an outbound action with confidence.
 */
function ActionCard({ approval, busy, onApprove, onReject, onSaveEdit }: {
  approval: PendingApproval;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onSaveEdit: (draft: string) => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation('notifications');
  const action = approval.action;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(action?.draft ?? '');

  // The action vanished between list and render (rare race) — fall back to the
  // approval's one-line summary so the row is still actionable.
  if (!action) {
    return (
      <article className="surface-card u-grid u-gap-2">
        <header className="u-flex u-items-center u-gap-2">
          <strong>{approval.persona}</strong>
          <span className="muted u-fs-12">{approval.proposal}</span>
        </header>
        <span className="action-bar">
          <button type="button" className="primary btn-sm" disabled={busy} onClick={onApprove}>
            <CheckIcon size={13} /> {t('approveLabel')}
          </button>
          <button type="button" className="secondary btn-sm" disabled={busy} onClick={onReject}>
            <XIcon size={13} /> {t('rejectLabel')}
          </button>
        </span>
      </article>
    );
  }

  const destination = destinationOf(action);
  return (
    <article className="surface-card u-grid u-gap-2">
      <header className="u-flex u-items-center u-gap-2">
        <strong>{approval.persona}</strong>
        <span className="chip">{action.kind}</span>
        {action.riskLevel ? (
          // Severity rides the functional-token axis with a visible label
          // (DESIGN.md §5.3) — chips, not run-state strings: high reads danger,
          // medium warning, low neutral (never success-green).
          <span className={`chip ${action.riskLevel === 'high' ? 'chip--danger' : action.riskLevel === 'medium' ? 'chip--warning' : 'chip--muted'}`}>
            {t('riskChip', { level: action.riskLevel })}
          </span>
        ) : null}
        {action.derivedFromUntrusted ? <span className="chip chip--muted">{t('derivedFromUntrusted')}</span> : null}
        {action.editedAt ? <span className="chip chip--muted">{t('editedAt', { when: formatDateTime(action.editedAt) })}</span> : null}
      </header>
      {destination ? <p className="muted u-m-0">{t('destinationTo', { destination })}</p> : null}
      {editing ? (
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={5} aria-label={t('editDraftLabel')} />
      ) : (
        <p className="u-m-0">{action.draft}</p>
      )}
      {action.recipientDiff ? (
        <p className="muted u-m-0">
          {t('recipientsPrefix')}{action.recipientDiff.before.join(', ') || t('recipientsEmpty')} → <strong>{action.recipientDiff.after.join(', ') || t('recipientsEmpty')}</strong>
        </p>
      ) : null}
      {action.reason ? <p className="muted u-m-0">{t('whyPrefix', { reason: action.reason })}</p> : null}
      {action.sourceRefs && action.sourceRefs.length > 0 ? (
        <p className="muted u-m-0">
          {t('sourcesPrefix')}
          {action.sourceRefs.map((s, i) => (
            <span key={`${s.externalId}-${i}`}>
              {i > 0 ? ' · ' : ''}
              {safeHref(s.url) ? <a href={safeHref(s.url)} target="_blank" rel="noreferrer">{s.kind}</a> : s.kind}
            </span>
          ))}
        </p>
      ) : null}
      <span className="action-bar">
        {editing ? (
          <>
            <button type="button" className="primary btn-sm" disabled={busy} onClick={() => { void onSaveEdit(draft).then(() => setEditing(false)); }}>{t('saveEdit')}</button>
            <button type="button" className="secondary btn-sm" disabled={busy} onClick={() => { setDraft(action.draft); setEditing(false); }}>{t('common:cancel')}</button>
          </>
        ) : (
          <>
            <button type="button" className="primary btn-sm" disabled={busy} onClick={onApprove}>
              <CheckIcon size={13} /> {t('approveLabel')}
            </button>
            <button type="button" className="secondary btn-sm" disabled={busy} onClick={onReject}>
              <XIcon size={13} /> {t('rejectLabel')}
            </button>
            <button type="button" className="secondary btn-sm" disabled={busy} onClick={() => setEditing(true)}>{t('common:edit')}</button>
          </>
        )}
      </span>
    </article>
  );
}

export function ApprovalsInbox({ onResolved }: { onResolved?: () => void }): JSX.Element {
  const { t } = useTranslation('notifications');
  const nav = useNavigate();
  const [items, setItems] = useState<PendingApproval[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setItems(await listApprovals('pending'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const claim = useCallback(async (a: PendingApproval) => {
    setBusy(a.approvalId);
    try {
      const { runId } = await claimApproval(a.approvalId);
      toast.success(
        isContentPublish(a)
          ? t('toastApprovedPublished')
          : isAssistantAction(a)
            ? t('toastApprovedCarry', { persona: a.persona })
            : t('toastApprovedRunning', { persona: a.persona }),
      );
      await refresh();
      onResolved?.();
      // Only a run-proposal yields a run to navigate to; an assistant-action
      // returns { actionId } and has no run page (it decides the draft in place).
      if (runId) nav(`/runs/${encodeURIComponent(runId)}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('toastCouldNotClaim'));
    } finally {
      setBusy(null);
    }
  }, [refresh, onResolved, nav, t]);

  const reject = useCallback(async (a: PendingApproval) => {
    setBusy(a.approvalId);
    try {
      await rejectApproval(a.approvalId);
      toast.info(t('toastProposalDismissed'));
      await refresh();
      onResolved?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('toastCouldNotReject'));
    } finally {
      setBusy(null);
    }
  }, [refresh, onResolved, t]);

  const saveEdit = useCallback(async (a: PendingApproval, draft: string) => {
    if (!a.actionId) return;
    setBusy(a.approvalId);
    try {
      await editAssistantAction(a.actionId, { draft });
      toast.success(t('toastDraftUpdated'));
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('toastEditFailed'));
      throw err;
    } finally {
      setBusy(null);
    }
  }, [refresh, t]);

  const columns: DataColumn<PendingApproval>[] = [
    {
      key: 'persona',
      header: t('approvalsColAgent'),
      width: '140px',
      render: (a) => <strong>{a.persona}</strong>,
      sortValue: (a) => a.persona,
    },
    {
      key: 'proposal',
      header: t('approvalsColProposes'),
      width: '1fr',
      render: (a) => (
        <div>
          <div><Trans t={t} i18nKey="approvalsRunWorkflow" values={{ name: workflowName(a.workflowId) }} components={{ 1: <strong /> }} /></div>
          {a.cardTitle && <div className="muted u-fs-12">{t('approvalsOnCard', { title: a.cardTitle })}</div>}
        </div>
      ),
    },
    {
      key: 'createdAt',
      header: t('approvalsColProposed'),
      width: '120px',
      cellClassName: 'muted',
      render: (a) => relativeTime(a.createdAt),
      sortValue: (a) => a.createdAt,
    },
    {
      key: 'actions',
      header: '',
      width: '200px',
      align: 'right',
      render: (a) => (
        <div className="action-bar u-justify-end">
          <button type="button" className="btn-accent-solid btn-sm" onClick={() => void claim(a)} disabled={busy === a.approvalId}>
            <CheckIcon size={13} /> {t('approveAndRun')}
          </button>
          <button type="button" className="secondary" onClick={() => void reject(a)} disabled={busy === a.approvalId}>
            <XIcon size={13} /> {t('rejectLabel')}
          </button>
        </div>
      ),
    },
  ];

  // Empty + settled: collapse to a single discoverable line rather than a full
  // card, so the inbox isn't dominated by an empty section for users who never
  // enable review mode.
  if (items !== null && items.length === 0 && !error) {
    return (
      <div className="card u-flex u-items-center u-gap-2 u-fs-12">
        <ScaleIcon size={14} />
        <span className="muted">
          {t('approvalsEmpty')}
        </span>
      </div>
    );
  }

  const actions = items?.filter(isAssistantAction) ?? [];
  const contentPublish = items?.filter(isContentPublish) ?? [];
  const runs = items?.filter((a) => !isAssistantAction(a) && !isContentPublish(a)) ?? [];

  return (
    <div className="card">
      <div className="u-flex u-items-center u-gap-2 u-mb-2">
        <ScaleIcon size={16} />
        <h2 className="u-flex-1 u-m-0">{t('approvalsTitle')}</h2>
        {items && items.length > 0 && <span className="chip chip--warning">{t('approvalsPending', { count: items.length })}</span>}
      </div>
      <p className="muted approvals-lede">
        {t('approvalsLede')}
      </p>

      {error && <Notice variant="error">{error}</Notice>}
      {items === null ? (
        <SkeletonRows rows={2} columns={['140px', '1fr', '120px', '200px']} />
      ) : (
        <div className="u-grid u-gap-3">
          {contentPublish.length > 0 && (
            <div className="u-grid u-gap-2">
              <h3 className="u-m-0 u-fs-12 muted">{t('approvalsContentGroup')}</h3>
              {contentPublish.map((a) => (
                // u-grid stacks the action-bar below the proposal so the row
                // degrades gracefully on narrow viewports (matches ActionCard).
                <article key={a.approvalId} className="surface-card u-grid u-gap-2">
                  <div className="u-flex u-items-center u-gap-2">
                    <span className="u-flex-1">{a.proposal}</span>
                    <span className="muted u-fs-12">{relativeTime(a.createdAt)}</span>
                  </div>
                  <span className="action-bar">
                    <button type="button" className="primary btn-sm" disabled={busy === a.approvalId} onClick={() => void claim(a)}>
                      <CheckIcon size={13} /> {t('approveLabel')}
                    </button>
                    <button type="button" className="secondary btn-sm" disabled={busy === a.approvalId} onClick={() => void reject(a)}>
                      <XIcon size={13} /> {t('rejectLabel')}
                    </button>
                  </span>
                </article>
              ))}
            </div>
          )}
          {actions.length > 0 && (
            <div className="u-grid u-gap-2">
              {actions.map((a) => (
                <ActionCard
                  key={a.approvalId}
                  approval={a}
                  busy={busy === a.approvalId}
                  onApprove={() => void claim(a)}
                  onReject={() => void reject(a)}
                  onSaveEdit={(draft) => saveEdit(a, draft)}
                />
              ))}
            </div>
          )}
          {runs.length > 0 && (
            <DataTable
              columns={columns}
              rows={runs}
              rowKey={(a) => a.approvalId}
              density="compact"
              caption={t('approvalsTableCaption')}
            />
          )}
        </div>
      )}
    </div>
  );
}
