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
import { useNavigate } from 'react-router-dom';
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
            <CheckIcon size={13} /> Approve
          </button>
          <button type="button" className="secondary btn-sm" disabled={busy} onClick={onReject}>
            <XIcon size={13} /> Reject
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
            risk: {action.riskLevel}
          </span>
        ) : null}
        {action.derivedFromUntrusted ? <span className="chip chip--muted">derived from connected (untrusted) content</span> : null}
        {action.editedAt ? <span className="chip chip--muted">edited {new Date(action.editedAt).toLocaleString()}</span> : null}
      </header>
      {destination ? <p className="muted u-m-0">To: {destination}</p> : null}
      {editing ? (
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={5} aria-label="Edit draft" />
      ) : (
        <p className="u-m-0">{action.draft}</p>
      )}
      {action.recipientDiff ? (
        <p className="muted u-m-0">
          Recipients: {action.recipientDiff.before.join(', ') || '—'} → <strong>{action.recipientDiff.after.join(', ') || '—'}</strong>
        </p>
      ) : null}
      {action.reason ? <p className="muted u-m-0">Why: {action.reason}</p> : null}
      {action.sourceRefs && action.sourceRefs.length > 0 ? (
        <p className="muted u-m-0">
          Sources:{' '}
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
            <button type="button" className="primary btn-sm" disabled={busy} onClick={() => { void onSaveEdit(draft).then(() => setEditing(false)); }}>Save edit</button>
            <button type="button" className="secondary btn-sm" disabled={busy} onClick={() => { setDraft(action.draft); setEditing(false); }}>Cancel</button>
          </>
        ) : (
          <>
            <button type="button" className="primary btn-sm" disabled={busy} onClick={onApprove}>
              <CheckIcon size={13} /> Approve
            </button>
            <button type="button" className="secondary btn-sm" disabled={busy} onClick={onReject}>
              <XIcon size={13} /> Reject
            </button>
            <button type="button" className="secondary btn-sm" disabled={busy} onClick={() => setEditing(true)}>Edit</button>
          </>
        )}
      </span>
    </article>
  );
}

export function ApprovalsInbox({ onResolved }: { onResolved?: () => void }): JSX.Element {
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
        isAssistantAction(a)
          ? `Approved — ${a.persona} will carry it out.`
          : `Approved — ${a.persona} is running it now.`,
      );
      await refresh();
      onResolved?.();
      // Only a run-proposal yields a run to navigate to; an assistant-action
      // returns { actionId } and has no run page (it decides the draft in place).
      if (runId) nav(`/runs/${encodeURIComponent(runId)}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not claim the proposal.');
    } finally {
      setBusy(null);
    }
  }, [refresh, onResolved, nav]);

  const reject = useCallback(async (a: PendingApproval) => {
    setBusy(a.approvalId);
    try {
      await rejectApproval(a.approvalId);
      toast.info('Proposal dismissed.');
      await refresh();
      onResolved?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not reject the proposal.');
    } finally {
      setBusy(null);
    }
  }, [refresh, onResolved]);

  const saveEdit = useCallback(async (a: PendingApproval, draft: string) => {
    if (!a.actionId) return;
    setBusy(a.approvalId);
    try {
      await editAssistantAction(a.actionId, { draft });
      toast.success('Draft updated — it will face you again for approval.');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Edit failed.');
      throw err;
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const columns: DataColumn<PendingApproval>[] = [
    {
      key: 'persona',
      header: 'Agent',
      width: '140px',
      render: (a) => <strong>{a.persona}</strong>,
      sortValue: (a) => a.persona,
    },
    {
      key: 'proposal',
      header: 'Proposes to',
      width: '1fr',
      render: (a) => (
        <div>
          <div>Run <strong>{workflowName(a.workflowId)}</strong></div>
          {a.cardTitle && <div className="muted u-fs-12">on “{a.cardTitle}”</div>}
        </div>
      ),
    },
    {
      key: 'createdAt',
      header: 'Proposed',
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
            <CheckIcon size={13} /> Approve &amp; run
          </button>
          <button type="button" className="secondary" onClick={() => void reject(a)} disabled={busy === a.approvalId}>
            <XIcon size={13} /> Reject
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
          No agent proposals awaiting sign-off. Set an agent&apos;s autonomy to <strong>review</strong> (on its Roster
          card) to route its heartbeat picks here.
        </span>
      </div>
    );
  }

  const actions = items?.filter(isAssistantAction) ?? [];
  const runs = items?.filter((a) => !isAssistantAction(a)) ?? [];

  return (
    <div className="card">
      <div className="u-flex u-items-center u-gap-2 u-mb-2">
        <ScaleIcon size={16} />
        <h2 className="u-flex-1 u-m-0">Awaiting sign-off</h2>
        {items && items.length > 0 && <span className="chip chip--warning">{items.length} pending</span>}
      </div>
      <p className="muted approvals-lede">
        Proposals from your agents — they picked up work or drafted an action but won&apos;t act without you.
        Approving a run starts it; approving a drafted action carries it out. Nothing is sent until you approve it.
      </p>

      {error && <Notice variant="error">{error}</Notice>}
      {items === null ? (
        <SkeletonRows rows={2} columns={['140px', '1fr', '120px', '200px']} />
      ) : (
        <div className="u-grid u-gap-3">
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
              caption="Pending agent run proposals awaiting human sign-off"
            />
          )}
        </div>
      )}
    </div>
  );
}
