/**
 * NeedsYouInbox — the ONE "needs you" list in the Inbox (IA refresh 2026-06).
 * Replaces the two stacked lists (ApprovalsInbox "Awaiting sign-off" +
 * WaitingBlockers "Waiting on the board"): a single list that merges
 *   - pending APPROVALS — a review-mode run-proposal (Approve & run) or an
 *     assistant-action draft (Approve / Reject / Edit, with risk + taint +
 *     citations), AND
 *   - board BLOCKERS — a task parked in an agent's Waiting lane (Open board; no
 *     resume API, so the action is honestly just navigation).
 *
 * A List / Grid toggle sits at the TOP (matching the agents page). Every item is
 * a `.surface-card` whose CONTENT is a horizontal row — so it reads identically
 * stacked full-width (list) or in a `.card-grid` (grid); no per-item layout
 * branch, and no new CSS.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Notice } from '../ui/Notice.js';
import { toast } from '../ui/toast.js';
import { AgentAvatar } from '../agents/AgentAvatar.js';
import { roleThemeForAgent, workflowName } from '../agents/roleTemplates.js';
import { loadAgentViews, relativeTime, statusRingColor, type AgentView } from '../agents/agentViewModel.js';
import {
  listApprovals, claimApproval, rejectApproval, editAssistantAction,
  type PendingApproval, type AssistantActionView,
} from '../agents/approvalsClient.js';
import { ScaleIcon, CheckIcon, XIcon, ClockIcon, ColumnsIcon, BoxesIcon, ListIcon } from '../ui/icons/index.js';

type ViewMode = 'list' | 'grid';
const isAssistantAction = (a: PendingApproval): boolean => a.kind === 'assistant-action' || !!a.actionId;
const compact = (rel: string | null): string => (rel ? rel.replace(' ago', '') : 'now');

/** http(s)-only guard for provider-derived (untrusted) source URLs. */
const safeHref = (u?: string): string | undefined => (u && /^https?:\/\//i.test(u) ? u : undefined);
function destinationOf(action: AssistantActionView): string | null {
  const to = action.payload?.to;
  if (Array.isArray(to)) return to.filter((x): x is string => typeof x === 'string').join(', ');
  return typeof to === 'string' ? to : null;
}

/** The avatar + identity + age — the shared left/top of every item. */
function ItemHead({ persona, role, ringColor, avatarUrl, theme, age }: {
  persona: string; role?: string | undefined; ringColor: string; avatarUrl?: string | undefined; theme: ReturnType<typeof roleThemeForAgent>; age: string | null;
}): JSX.Element {
  return (
    <div className="u-flex u-items-center u-gap-2 u-wrap">
      <AgentAvatar persona={persona} avatarUrl={avatarUrl} roleTheme={theme} size={36} showBadge={false} ring={ringColor} />
      <span className="roster-name">{persona}</span>
      {role ? <span className="muted u-fs-12">{role}</span> : null}
      {age ? <span className="chip chip--warning"><ClockIcon size={11} aria-hidden /> {compact(age)}</span> : null}
    </div>
  );
}

export function NeedsYouInbox({ onResolved }: { onResolved?: () => void }): JSX.Element | null {
  const nav = useNavigate();
  const [approvals, setApprovals] = useState<PendingApproval[] | null>(null);
  const [views, setViews] = useState<AgentView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>('list');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [ap, vs] = await Promise.all([listApprovals('pending'), loadAgentViews().catch(() => [] as AgentView[])]);
      setApprovals(ap); setViews(vs); setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const after = useCallback(async () => { await refresh(); onResolved?.(); }, [refresh, onResolved]);

  const approve = useCallback(async (a: PendingApproval) => {
    setBusy(a.approvalId);
    try {
      const { runId } = await claimApproval(a.approvalId);
      toast.success(isAssistantAction(a) ? `Approved — ${a.persona} will carry it out.` : `Approved — ${a.persona} is running it now.`);
      await after();
      if (runId) nav(`/runs/${encodeURIComponent(runId)}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not approve.');
    } finally { setBusy(null); }
  }, [after, nav]);

  const reject = useCallback(async (a: PendingApproval) => {
    setBusy(a.approvalId);
    try { await rejectApproval(a.approvalId); toast.info('Dismissed.'); await after(); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Could not reject.'); }
    finally { setBusy(null); }
  }, [after]);

  const saveEdit = useCallback(async (a: PendingApproval) => {
    if (!a.actionId) return;
    setBusy(a.approvalId);
    try {
      await editAssistantAction(a.actionId, { draft });
      toast.success('Draft updated — it will face you again for approval.');
      setEditing(null);
      await refresh();
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Edit failed.'); }
    finally { setBusy(null); }
  }, [draft, refresh]);

  const viewByRoster = new Map(views.map((v) => [v.entry.rosterId, v]));
  const blockers = views.filter((v) => v.status === 'waiting');
  const total = (approvals?.length ?? 0) + blockers.length;

  // All clear → a single quiet line (don't dominate the inbox with an empty card).
  if (approvals !== null && total === 0 && !error) {
    return (
      <div className="card u-flex u-items-center u-gap-2 u-fs-12">
        <CheckIcon size={14} />
        <span className="muted">You&rsquo;re all caught up — nothing needs your sign-off or a board action right now.</span>
      </div>
    );
  }

  /** One approval as a card whose body is a horizontal row (list/grid agnostic). */
  const ApprovalItem = (a: PendingApproval): JSX.Element => {
    const view = viewByRoster.get(a.rosterId);
    const theme = roleThemeForAgent(view?.entry.agentRef?.agentId, view?.entry.workflows ?? []);
    const action = a.action;
    const isEditing = editing === a.approvalId;
    return (
      <article className="surface-card u-gap-2" key={a.approvalId}>
        <ItemHead persona={a.persona} role={view?.entry.label} ringColor="var(--color-warning)" avatarUrl={view?.entry.avatarUrl} theme={theme} age={relativeTime(a.createdAt)} />
        {isAssistantAction(a) && action ? (
          <>
            <div className="u-flex u-items-center u-gap-2 u-wrap">
              <span className="chip">{action.kind}</span>
              {action.riskLevel ? (
                <span className={`chip ${action.riskLevel === 'high' ? 'chip--danger' : action.riskLevel === 'medium' ? 'chip--warning' : 'chip--muted'}`}>risk: {action.riskLevel}</span>
              ) : null}
              {action.derivedFromUntrusted ? <span className="chip chip--muted">from connected (untrusted) content</span> : null}
            </div>
            {destinationOf(action) ? <p className="muted u-m-0 u-fs-13">To: {destinationOf(action)}</p> : null}
            {isEditing ? (
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} aria-label="Edit draft" />
            ) : (
              <p className="u-m-0">{action.draft}</p>
            )}
            {action.reason ? <p className="muted u-m-0 u-fs-13">Why: {action.reason}</p> : null}
            {action.sourceRefs && action.sourceRefs.length > 0 ? (
              <p className="muted u-m-0 u-fs-12">Sources: {action.sourceRefs.map((s, i) => (
                <span key={`${s.externalId}-${i}`}>{i > 0 ? ' · ' : ''}{safeHref(s.url) ? <a href={safeHref(s.url)} target="_blank" rel="noreferrer">{s.kind}</a> : s.kind}</span>
              ))}</p>
            ) : null}
            <div className="action-bar u-justify-end">
              {isEditing ? (
                <>
                  <button type="button" className="primary btn-sm" disabled={busy === a.approvalId} onClick={() => void saveEdit(a)}>Save edit</button>
                  <button type="button" className="secondary btn-sm" disabled={busy === a.approvalId} onClick={() => setEditing(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <button type="button" className="btn-accent-solid btn-sm" disabled={busy === a.approvalId} onClick={() => void approve(a)}><CheckIcon size={13} /> Approve</button>
                  <button type="button" className="secondary btn-sm" disabled={busy === a.approvalId} onClick={() => void reject(a)}><XIcon size={13} /> Reject</button>
                  <button type="button" className="secondary btn-sm" disabled={busy === a.approvalId} onClick={() => { setEditing(a.approvalId); setDraft(action.draft); }}>Edit</button>
                </>
              )}
            </div>
          </>
        ) : (
          // Run-proposal: a compact row.
          <>
            <p className="u-m-0">Run <strong>{workflowName(a.workflowId)}</strong>{a.cardTitle ? <span className="muted"> on “{a.cardTitle}”</span> : null}</p>
            <div className="action-bar u-justify-end">
              <button type="button" className="btn-accent-solid btn-sm" disabled={busy === a.approvalId} onClick={() => void approve(a)}><CheckIcon size={13} /> Approve &amp; run</button>
              <button type="button" className="secondary btn-sm" disabled={busy === a.approvalId} onClick={() => void reject(a)}><XIcon size={13} /> Reject</button>
            </div>
          </>
        )}
      </article>
    );
  };

  /** One board blocker as a card. */
  const BlockerItem = (v: AgentView): JSX.Element => {
    const card = v.cards.find((c) => c.columnId === 'waiting');
    const theme = roleThemeForAgent(v.entry.agentRef?.agentId, v.entry.workflows, v.entry.roleKey);
    return (
      <article className="surface-card u-gap-2" key={v.entry.rosterId}>
        <ItemHead persona={v.entry.persona} role={v.entry.label} ringColor={statusRingColor('waiting')} avatarUrl={v.entry.avatarUrl} theme={theme} age={card?.updatedAt ? relativeTime(card.updatedAt) : null} />
        <p className="u-m-0">{card?.title ?? 'A task is parked in the Waiting lane'}</p>
        <p className="muted u-m-0 u-fs-13">{card?.blockerNote ?? 'A person needs to act on the board before this can move on.'}</p>
        <div className="action-bar u-justify-end">
          <button type="button" className="btn-accent-solid btn-sm" onClick={() => nav(`/agents/${encodeURIComponent(v.entry.rosterId)}?tab=board`)}><ColumnsIcon size={13} /> Open board</button>
        </div>
      </article>
    );
  };

  return (
    <div className="card">
      <div className="u-flex u-items-center u-gap-2 u-mb-2">
        <ScaleIcon size={16} />
        <h2 className="u-flex-1 u-m-0">Needs you</h2>
        {total > 0 && <span className="chip chip--warning">{total}</span>}
        <div className="action-bar" role="group" aria-label="View mode">
          <button type="button" className={mode === 'list' ? 'primary btn-sm' : 'secondary btn-sm'} aria-pressed={mode === 'list'} title="List" onClick={() => setMode('list')}><ListIcon size={14} aria-hidden /> List</button>
          <button type="button" className={mode === 'grid' ? 'primary btn-sm' : 'secondary btn-sm'} aria-pressed={mode === 'grid'} title="Grid" onClick={() => setMode('grid')}><BoxesIcon size={14} aria-hidden /> Grid</button>
        </div>
      </div>
      <p className="muted approvals-lede">
        Proposals to approve, drafted actions, and board blockers from your agents — everything waiting on a decision, in one place.
      </p>
      {error && <Notice variant="error">{error}</Notice>}
      <div className={mode === 'grid' ? 'card-grid' : 'u-grid u-gap-2'}>
        {(approvals ?? []).map(ApprovalItem)}
        {blockers.map(BlockerItem)}
      </div>
    </div>
  );
}
