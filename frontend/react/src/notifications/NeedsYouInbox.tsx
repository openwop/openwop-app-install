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
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Notice } from '../ui/Notice.js';
import { toast } from '../ui/toast.js';
import { AgentAvatar } from '../agents/AgentAvatar.js';
import { roleThemeForAgent, workflowName } from '../agents/roleTemplates.js';
import { loadAgentViews, statusRingColor, type AgentView } from '../agents/agentViewModel.js';
import { relativeLabel } from './relativeLabel.js';
import {
  listApprovals, claimApproval, rejectApproval, editAssistantAction, approvalErrorInfo, ApprovalApiError,
  type PendingApproval,
} from '../agents/approvalsClient.js';
import { ContentReviewContext, ApprovalDecideBar, StrategyActivationSnapshot } from './ContentReviewContext.js';
import { ScaleIcon, CheckIcon, XIcon, ClockIcon, ColumnsIcon, BoxesIcon, ListIcon } from '../ui/icons/index.js';
import { subscribeReviewSignal } from './signalBus.js';
import { scrollBehavior } from '../ui/motion.js';

// ADR 0862 D3 — the fields the approver must see (lazy: only assistant-action cards).
const AssistantActionFields = lazy(() => import('../assistantAction/AssistantActionFields.js'));
const CreativeReviewDecision = lazy(() => import('./CreativeReviewDecision.js'));
const FunnelPublishDecision = lazy(() => import('./FunnelPublishDecision.js'));

type ViewMode = 'list' | 'grid';
const isAssistantAction = (a: PendingApproval): boolean => a.kind === 'assistant-action' || !!a.actionId;
/** R2 IB-SP-4 — only a RUN proposal may be rendered with run-proposal copy.
 *  Everything else used to fall into that branch: 'Approve & run' on a
 *  campaign-spend or content-publish approval that would actually apply
 *  spend / publish a page. Unknown kinds get the honest generic card. */
const isRunProposal = (a: PendingApproval): boolean => !isAssistantAction(a) && (!a.kind || a.kind === 'run-proposal');
const isContentPublish = (a: PendingApproval): boolean => a.kind === 'content-publish';
const isStrategyActivation = (a: PendingApproval): boolean => a.kind === 'strategy-activation';
/** ADR 0785 P4 — the user's own Claude Code asking to use a tool. Approving ALLOWS it. */
const isClaudeCodePermission = (a: PendingApproval): boolean => a.kind === 'claude-code-permission';
// R2 IB-SP-7 — the English `.replace(' ago','')` surgery is gone: ages now
// come from the shared localized `relativeLabel` (already compact).

/** http(s)-only guard for provider-derived (untrusted) source URLs. */
const safeHref = (u?: string): string | undefined => (u && /^https?:\/\//i.test(u) ? u : undefined);

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

export function NeedsYouInbox({ onResolved, focusApprovalId, onApprovalFocused }: {
  onResolved?: () => void;
  /** ADR 0862 — `/inbox?approval=<id>`: scroll to + focus THIS approval's card (the one
   *  that shows its fields and its decide buttons), once the list has loaded. */
  focusApprovalId?: string;
  /** Called once the card took focus, so the page does not also focus a notification row. */
  onApprovalFocused?: () => void;
}): JSX.Element | null {
  const { t } = useTranslation('notifications');
  // ADR 0862 — load the lazy `assistantAction` namespace (its decide-failure copy) WITHOUT
  // suspending: listing it in the main hook blanked the whole page on a first visit.
  useTranslation('assistantAction', { useSuspense: false });
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

  // ADR 0862 (UX Blocker) — the agent drawer's "Review" link lands here. One-shot per id:
  // a later refresh must not yank focus back while the human works the list.
  const focusedFor = useRef('');
  useEffect(() => {
    if (!focusApprovalId || focusedFor.current === focusApprovalId || !approvals) return;
    if (!approvals.some((a) => a.approvalId === focusApprovalId)) return;
    const el = document.getElementById(`approval-card-${focusApprovalId}`);
    if (!el) return;
    focusedFor.current = focusApprovalId;
    el.scrollIntoView?.({ block: 'center', behavior: scrollBehavior() });
    el.focus({ preventScroll: true });
    onApprovalFocused?.();
  }, [focusApprovalId, approvals, onApprovalFocused]);

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
      // ADR 0862 D1 — an assistant action approves the exact version this card shows.
      const { runId } = await claimApproval(a.approvalId, undefined, a.action?.contentHash);
      // R2 IB-SP-4 — the toast must describe what APPROVING DID, per kind
      // (the ApprovalsInbox ladder): published / activated / carried / ran.
      toast.success(
        isContentPublish(a) ? t('toastApprovedPublished')
          : a.kind === 'funnel-publish' ? t('toastApprovedFunnelPublish')
          : isStrategyActivation(a) ? t('toastApprovedActivated')
          : isAssistantAction(a) ? t('toastApprovedCarry', { persona: a.persona })
          : isRunProposal(a) ? t('toastApprovedRunning', { persona: a.persona })
          : t('toastApprovedGeneric'),
      );
      await after();
      if (runId) nav(`/runs/${encodeURIComponent(runId)}`);
    } catch (err) {
      toast.error(decideError(err, 'toastCouldNotApprove'));
      // ADR 0845 — a 409/404 means the server closed or resolved the row (e.g. a
      // strategy whose content changed): re-read so the dead card drops out.
      if (err instanceof ApprovalApiError && (err.status === 409 || err.status === 404)) void refresh();
    } finally { setBusy(null); }
  }, [after, refresh, nav, t, decideError]);

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
      // ADR 0862 D2 — edit the version this card shows; the re-read picks up the new hash.
      const card = await editAssistantAction(a.actionId, { draft }, a.action?.contentHash);
      // Adopt the returned card (with its NEW hash) at once — see ApprovalsInbox.
      setApprovals((prev) => prev?.map((x) => (x.approvalId === a.approvalId ? { ...x, action: card } : x)) ?? prev);
      toast.success(t('toastDraftUpdated'));
      setEditing(null);
      await refresh();
    } catch (err) {
      toast.error(decideError(err, 'toastEditFailed'));
      if (err instanceof ApprovalApiError && err.status === 409) void refresh();
    }
    finally { setBusy(null); }
  }, [draft, refresh, t, decideError]);

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
      <article className="surface-card u-gap-2" key={a.approvalId} id={`approval-card-${a.approvalId}`} tabIndex={-1}>
        <ItemHead persona={a.persona} role={view?.entry.label} ringColor="var(--color-warning)" avatarUrl={view?.entry.avatarUrl} theme={theme} age={relativeLabel(a.createdAt, t)} />
        {isAssistantAction(a) && action?.withheld ? (
          // ADR 0862 — withheld from a reader who cannot send it: no draft, no decision.
          <p className="muted u-m-0">{t('assistantAction:actionWithheld')}</p>
        ) : isAssistantAction(a) && action ? (
          <Suspense fallback={<p role="status">{t('common:loading')}</p>}>
            <div className="u-flex u-items-center u-gap-2 u-wrap">
              <span className="chip">{action.kind}</span>
              {action.riskLevel ? (
                <span className={`chip ${action.riskLevel === 'high' ? 'chip--danger' : action.riskLevel === 'medium' ? 'chip--warning' : 'chip--muted'}`}>{t('riskChip', { level: action.riskLevel })}</span>
              ) : null}
              {action.derivedFromUntrusted ? <span className="chip chip--muted">{t('needsYouFromUntrusted')}</span> : null}
            </div>
            {/* ADR 0862 D3 — every field the action will send, not just its recipient. */}
            <AssistantActionFields payload={action.payload} />
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
          </Suspense>
        ) : isAssistantAction(a) ? (
          // ADR 0862 — an assistant action whose row is gone: nothing to show, no hash to
          // approve against. Reject only.
          <>
            <p className="muted u-m-0">{t('assistantAction:actionUnavailable')}</p>
            <div className="action-bar u-justify-end">
              <Button variant="secondary" size="sm" disabled={busy === a.approvalId} onClick={() => void reject(a)}><XIcon size={13} /> {t('rejectLabel')}</Button>
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
                  : isClaudeCodePermission(a) ? 'approvalsClaudeCodeGroup'
                  : a.kind === 'creative-publish-review' ? 'approvalsCreativeReviewGroup'
                  : a.kind === 'funnel-publish' ? 'approvalsFunnelPublishGroup'
                  : 'approvalsOtherGroup',
              )}</span>
            </div>
            {isClaudeCodePermission(a) && a.claudeCodePermission ? (
              <>
                <p className="u-m-0">{t('approvalsClaudeCodeAsk', { device: a.claudeCodePermission.deviceLabel, tool: a.claudeCodePermission.tool })}</p>
                <pre className="u-m-0"><code>{a.claudeCodePermission.summary}</code></pre>
              </>
            ) : (
              <p className="u-m-0">{a.proposal}</p>
            )}
            {/* ADR 0593 D4 (CMSAU-1) — BOTH deciding surfaces get the same
                context and the same affordances; they used to disagree. */}
            {isContentPublish(a) && <ContentReviewContext a={a} />}
            {/* ADR 0845 D6 — both deciding surfaces show what a strategy approval binds to. */}
            {isStrategyActivation(a) && <StrategyActivationSnapshot strategyId={a.strategyId} strategyTitle={a.strategyTitle} snapshot={a.strategySnapshot} />}
            {a.kind === 'funnel-publish' ? (
              <Suspense fallback={<p role="status">{t('common:loading')}</p>}>
                <FunnelPublishDecision approval={a} busy={busy === a.approvalId} onApprove={() => void approve(a)} onReject={(note) => reject(a, note)} />
              </Suspense>
            ) : a.kind === 'creative-publish-review' ? (
              <Suspense fallback={<p role="status">{t('common:loading')}</p>}>
                <CreativeReviewDecision approval={a} busy={busy === a.approvalId} onApprove={() => void approve(a)} onReject={(note) => reject(a, note)} />
              </Suspense>
            ) : (
            <div className={isContentPublish(a) || isClaudeCodePermission(a) || isStrategyActivation(a) ? '' : 'action-bar u-justify-end'}>
              {/* STR3UX-9 — strategy activations get the same reason-capable bar here as in the full inbox (SGU-2). */}
              {isContentPublish(a) || isClaudeCodePermission(a) || isStrategyActivation(a) ? (
                // ADR 0785 P4 — a deny REASON goes back to Claude Code verbatim.
                <ApprovalDecideBar
                  busy={busy === a.approvalId}
                  onApprove={() => void approve(a)}
                  onReject={(note) => reject(a, note)}
                  {...(isClaudeCodePermission(a) ? { approveLabel: t('approvalsClaudeCodeAllow'), rejectLabel: t('approvalsClaudeCodeDeny') } : {})}
                />
              ) : (
                <>
                  <Button variant="accent-solid" size="sm" disabled={busy === a.approvalId} aria-busy={busy === a.approvalId} onClick={() => void approve(a)}><CheckIcon size={13} /> {t('approveLabel')}</Button>
                  <Button variant="secondary" size="sm" disabled={busy === a.approvalId} aria-busy={busy === a.approvalId} onClick={() => void reject(a)}><XIcon size={13} /> {t('rejectLabel')}</Button>
                </>
              )}
            </div>
            )}
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
