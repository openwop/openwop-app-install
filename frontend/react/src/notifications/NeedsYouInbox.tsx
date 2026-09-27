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
import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Notice } from '../ui/Notice.js';
import { toast } from '../ui/toast.js';
import { AgentAvatar } from '../agents/AgentAvatar.js';
import { roleThemeForAgent, workflowName } from '../agents/roleTemplates.js';
import { loadAgentViews, statusRingColor, type AgentView } from '../agents/agentViewModel.js';
import { relativeLabel } from './relativeLabel.js';
import {
  listApprovals, claimApproval, rejectApproval, editAssistantAction, approvalErrorInfo,
  type PendingApproval, type AssistantActionView,
} from '../agents/approvalsClient.js';
import { ContentReviewContext, ApprovalDecideBar } from './ContentReviewContext.js';
import { ScaleIcon, CheckIcon, XIcon, ClockIcon, ColumnsIcon, BoxesIcon, ListIcon } from '../ui/icons/index.js';
import { subscribeReviewSignal } from './signalBus.js';

type ViewMode = 'list' | 'grid';
const isAssistantAction = (a: PendingApproval): boolean => a.kind === 'assistant-action' || !!a.actionId;
/** R2 IB-SP-4 — only a RUN proposal may be rendered with run-proposal copy.
 *  Everything else used to fall into that branch: 'Approve & run' on a
 *  campaign-spend or content-publish approval that would actually apply
 *  spend / publish a page. Unknown kinds get the honest generic card. */
const isRunProposal = (a: PendingApproval): boolean => !isAssistantAction(a) && (!a.kind || a.kind === 'run-proposal');
const isContentPublish = (a: PendingApproval): boolean => a.kind === 'content-publish';
const isStrategyActivation = (a: PendingApproval): boolean => a.kind === 'strategy-activation';
// R2 IB-SP-7 — the English `.replace(' ago','')` surgery is gone: ages now
// come from the shared localized `relativeLabel` (already compact).

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
      {age ? <span className="chip chip--warning"><ClockIcon size={11} aria-hidden /> {age}</span> : null}
    </div>
  );
}

export function NeedsYouInbox({ onResolved }: { onResolved?: () => void }): JSX.Element | null {
  const { t } = useTranslation('notifications');
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
    } catch {
      setError(t('needsYouLoadFailed')); // R2 IB-SP-8 — no raw API strings
    }
  }, [t]);
  useEffect(() => { void refresh(); }, [refresh]);
  // ADR 0074 — when a review is decided on ANY surface/client, the broadcast
  // signal lands here; re-pull the pending list so a resolved approval drops out
  // live (the inbox owns a separate approvals list, so it reconciles by refetch).
  useEffect(() => subscribeReviewSignal(() => { void refresh(); }), [refresh]);

  const after = useCallback(async () => { await refresh(); onResolved?.(); }, [refresh, onResolved]);

  // ADR 0593 D3 (CMSAU-2) — the shared decide-failure mapper (see ApprovalsInbox).
  const decideError = useCallback((err: unknown, fallbackKey: string): string => {
    const info = approvalErrorInfo(err);
    if (info) return t(info.key, info.options ?? {});
    return err instanceof Error && err.message ? err.message : t(fallbackKey);
  }, [t]);

  const approve = useCallback(async (a: PendingApproval) => {
    setBusy(a.approvalId);
    try {
      const { runId } = await claimApproval(a.approvalId);
      // R2 IB-SP-4 — the toast must describe what APPROVING DID, per kind
      // (the ApprovalsInbox ladder): published / activated / carried / ran.
      toast.success(
        isContentPublish(a) ? t('toastApprovedPublished')
          : isStrategyActivation(a) ? t('toastApprovedActivated')
          : isAssistantAction(a) ? t('toastApprovedCarry', { persona: a.persona })
          : isRunProposal(a) ? t('toastApprovedRunning', { persona: a.persona })
          : t('toastApprovedGeneric'),
      );
      await after();
      if (runId) nav(`/runs/${encodeURIComponent(runId)}`);
    } catch (err) {
      toast.error(decideError(err, 'toastCouldNotApprove'));
    } finally { setBusy(null); }
  }, [after, nav, t, decideError]);

  // ADR 0593 D4 (CMSAU-5 / CMSAU-13) — a content-publish reject carries the
  // reviewer's REASON and says what it did ("back in draft"), instead of the
  // kind-blind "Dismissed." the approve ladder was given honesty and reject
  // never was.
  const reject = useCallback(async (a: PendingApproval, note?: string): Promise<boolean> => {
    setBusy(a.approvalId);
    try {
      await rejectApproval(a.approvalId, note);
      // SGU-3 — a rejected activation returns the strategy to draft (resubmittable),
      // which "Dismissed." did not say.
      toast.info(
        isContentPublish(a) ? t('toastRejectedToDraft')
          : isStrategyActivation(a) ? t('toastStrategyRejectedToDraft')
            : t('toastDismissed'),
      );
      await after();
      return true;
    }
    // F7(5) — a failed reject must not unmount the reason step.
    catch (err) { toast.error(decideError(err, 'toastCouldNotRejectShort')); return false; }
    finally { setBusy(null); }
  }, [after, t, decideError]);

  const saveEdit = useCallback(async (a: PendingApproval) => {
    if (!a.actionId) return;
    setBusy(a.approvalId);
    try {
      await editAssistantAction(a.actionId, { draft });
      toast.success(t('toastDraftUpdated'));
      setEditing(null);
      await refresh();
    } catch (err) { toast.error(err instanceof Error ? err.message : t('toastEditFailed')); }
    finally { setBusy(null); }
  }, [draft, refresh, t]);

  const viewByRoster = new Map(views.map((v) => [v.entry.rosterId, v]));
  const blockers = views.filter((v) => v.status === 'waiting');
  const total = (approvals?.length ?? 0) + blockers.length;

  // All clear → a single quiet line (don't dominate the inbox with an empty card).
  if (approvals !== null && total === 0 && !error) {
    return (
      <div className="surface-card u-flex u-flex-row u-items-center u-gap-2 u-fs-12">
        <CheckIcon size={14} />
        <span className="muted">{t('needsYouAllClear')}</span>
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
        <ItemHead persona={a.persona} role={view?.entry.label} ringColor="var(--color-warning)" avatarUrl={view?.entry.avatarUrl} theme={theme} age={relativeLabel(a.createdAt, t)} />
        {isAssistantAction(a) && action ? (
          <>
            <div className="u-flex u-items-center u-gap-2 u-wrap">
              <span className="chip">{action.kind}</span>
              {action.riskLevel ? (
                <span className={`chip ${action.riskLevel === 'high' ? 'chip--danger' : action.riskLevel === 'medium' ? 'chip--warning' : 'chip--muted'}`}>{t('riskChip', { level: action.riskLevel })}</span>
              ) : null}
              {action.derivedFromUntrusted ? <span className="chip chip--muted">{t('needsYouFromUntrusted')}</span> : null}
            </div>
            {destinationOf(action) ? <p className="muted u-m-0 u-fs-13">{t('destinationTo', { destination: destinationOf(action) })}</p> : null}
            {isEditing ? (
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} aria-label={t('editDraftLabel')} />
            ) : (
              <p className="u-m-0">{action.draft}</p>
            )}
            {action.reason ? <p className="muted u-m-0 u-fs-13">{t('whyPrefix', { reason: action.reason })}</p> : null}
            {action.sourceRefs && action.sourceRefs.length > 0 ? (
              <p className="muted u-m-0 u-fs-12">{t('sourcesPrefix')}{action.sourceRefs.map((s, i) => (
                <span key={`${s.externalId}-${i}`}>{i > 0 ? ' · ' : ''}{safeHref(s.url) ? <a href={safeHref(s.url)} target="_blank" rel="noreferrer">{s.kind}</a> : s.kind}</span>
              ))}</p>
            ) : null}
            <div className="action-bar u-justify-end">
              {isEditing ? (
                <>
                  <Button variant="primary" size="sm" disabled={busy === a.approvalId} onClick={() => void saveEdit(a)}>{t('saveEdit')}</Button>
                  <Button variant="secondary" size="sm" disabled={busy === a.approvalId} onClick={() => setEditing(null)}>{t('common:cancel')}</Button>
                </>
              ) : (
                <>
                  <Button variant="accent-solid" size="sm" disabled={busy === a.approvalId} onClick={() => void approve(a)}><CheckIcon size={13} /> {t('approveLabel')}</Button>
                  <Button variant="secondary" size="sm" disabled={busy === a.approvalId} onClick={() => void reject(a)}><XIcon size={13} /> {t('rejectLabel')}</Button>
                  <Button variant="secondary" size="sm" disabled={busy === a.approvalId} onClick={() => { setEditing(a.approvalId); setDraft(action.draft); }}>{t('common:edit')}</Button>
                </>
              )}
            </div>
          </>
        ) : isRunProposal(a) ? (
          // Run-proposal: a compact row. ONLY this kind earns "Approve & run".
          <>
            <p className="u-m-0"><Trans t={t} i18nKey="approvalsRunWorkflow" values={{ name: workflowName(a.workflowId) }} components={{ 1: <strong /> }} />{a.cardTitle ? <span className="muted"> {t('approvalsOnCard', { title: a.cardTitle })}</span> : null}</p>
            <div className="action-bar u-justify-end">
              <Button variant="accent-solid" size="sm" disabled={busy === a.approvalId} onClick={() => void approve(a)}><CheckIcon size={13} /> {t('approveAndRun')}</Button>
              <Button variant="secondary" size="sm" disabled={busy === a.approvalId} onClick={() => void reject(a)}><XIcon size={13} /> {t('rejectLabel')}</Button>
            </div>
          </>
        ) : (
          // R2 IB-SP-4 — every other kind renders the server-authored
          // proposal (already kind-correct prose) with a plain Approve: the
          // button must not promise a run the claim will not start.
          <>
            <div className="u-flex u-items-center u-gap-2 u-wrap">
              <span className="chip chip--warning">{t(
                isContentPublish(a) ? 'approvalsContentGroup'
                  : isStrategyActivation(a) ? 'approvalsStrategyGroup'
                  : a.kind === 'campaign-spend' ? 'approvalsSpendGroup'
                  : 'approvalsOtherGroup',
              )}</span>
            </div>
            <p className="u-m-0">{a.proposal}</p>
            {/* ADR 0593 D4 (CMSAU-1) — BOTH deciding surfaces get the same
                context and the same affordances; they used to disagree. */}
            {isContentPublish(a) && <ContentReviewContext a={a} />}
            <div className={isContentPublish(a) ? '' : 'action-bar u-justify-end'}>
              {isContentPublish(a) ? (
                <ApprovalDecideBar
                  busy={busy === a.approvalId}
                  onApprove={() => void approve(a)}
                  onReject={(note) => reject(a, note)}
                />
              ) : (
                <>
                  <Button variant="accent-solid" size="sm" disabled={busy === a.approvalId} aria-busy={busy === a.approvalId} onClick={() => void approve(a)}><CheckIcon size={13} /> {t('approveLabel')}</Button>
                  <Button variant="secondary" size="sm" disabled={busy === a.approvalId} aria-busy={busy === a.approvalId} onClick={() => void reject(a)}><XIcon size={13} /> {t('rejectLabel')}</Button>
                </>
              )}
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
        <ItemHead persona={v.entry.persona} role={v.entry.label} ringColor={statusRingColor('waiting')} avatarUrl={v.entry.avatarUrl} theme={theme} age={card?.updatedAt ? relativeLabel(card.updatedAt, t) : null} />
        <p className="u-m-0">{card?.title ?? t('blockerDefaultTitle')}</p>
        <p className="muted u-m-0 u-fs-13">
          {card?.blockerNote
            ?? (card?.workflowId
                ? t('blockerWaitingWorkflow', { workflow: workflowName(card.workflowId) })
                : t('blockerDefaultNote'))}
        </p>
        <div className="action-bar u-justify-end">
          <Button variant="accent-solid" size="sm" onClick={() => nav(`/agents/${encodeURIComponent(v.entry.rosterId)}?tab=board`)}><ColumnsIcon size={13} /> {t('openBoard')}</Button>
        </div>
      </article>
    );
  };

  return (
    <div className="surface-card">
      <div className="u-flex u-items-center u-gap-2 u-mb-2">
        <ScaleIcon size={16} />
        <h2 className="u-flex-1 u-m-0">{t('needsYouTitle')}</h2>
        {total > 0 && <span className="chip chip--warning">{total}</span>}
        <div className="action-bar" role="group" aria-label={t('viewModeLabel')}>
          <Button variant={mode === 'list' ? 'primary' : 'secondary'} size="sm" aria-pressed={mode === 'list'} title={t('viewModeList')} onClick={() => setMode('list')}><ListIcon size={14} aria-hidden /> {t('viewModeList')}</Button>
          <Button variant={mode === 'grid' ? 'primary' : 'secondary'} size="sm" aria-pressed={mode === 'grid'} title={t('viewModeGrid')} onClick={() => setMode('grid')}><BoxesIcon size={14} aria-hidden /> {t('viewModeGrid')}</Button>
        </div>
      </div>
      <p className="muted approvals-lede">
        {t('needsYouLede')}
      </p>
      {error && <Notice variant="error">{error}</Notice>}
      <div className={mode === 'grid' ? 'card-grid' : 'u-grid u-gap-2'}>
        {(approvals ?? []).map(ApprovalItem)}
        {blockers.map(BlockerItem)}
      </div>
    </div>
  );
}
