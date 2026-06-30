import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';
import { claimApproval, rejectApproval, type PendingApproval } from './approvalsClient.js';
import { statusMeta, statusRingColor, relativeTime, type AgentView } from './agentViewModel.js';
import { workflowName, roleThemeForAgent } from './roleTemplates.js';
import { AgentAvatar } from './AgentAvatar.js';
import { AgentBoardPanel } from './AgentBoardPanel.js';
import { AgentActivityTab } from './AgentActivityTab.js';
import { Markdown } from '../ui/Markdown.js';
import { handleTablistKeyDown } from '../ui/rovingTabs.js';
import { IconButton } from '../ui/IconButton.js';
import { AutonomyMeter } from './AutonomyMeter.js';
import { toast } from '../ui/toast.js';
import { XIcon, CheckIcon, ClockIcon, MessageSquareIcon, AlertIcon, ArrowRightIcon } from '../ui/icons/index.js';
import { ModalPortal } from '../ui/ModalPortal.js';

/**
 * Agent quick-look drawer (agents-workforce redesign PR 2) — a right
 * slide-over so reviewing an agent doesn't navigate away from the roster.
 *
 * Composes EXISTING components (architect delta: `AgentBoardPanel` and
 * `AgentActivityTab` are already standalone — no workspace refactor needed):
 *   Overview — the pending ask (real approve/send-back via the Inbox's own
 *              APIs), facts, description, lane counts
 *   Board    — the same embedded board the workspace renders
 *   Activity — the same per-agent run feed
 *
 * Chat intentionally LINKS OUT to the pre-routed chat (`/?agent=`) — there is
 * no chat tab to reuse and the drawer must not grow a second chat surface.
 * The footer always offers the full workspace; the drawer is a quick-look,
 * not a replacement.
 *
 * Deep-linkable: the owner (AgentDashboardPage) stores `?agent=&tab=` in the
 * URL and renders the drawer from it (the prototype's contract).
 */

export type DrawerTab = 'overview' | 'board' | 'activity';
const TABS: ReadonlyArray<{ key: DrawerTab; labelKey: string }> = [
  { key: 'overview', labelKey: 'drawerTabOverview' },
  { key: 'board', labelKey: 'drawerTabBoard' },
  { key: 'activity', labelKey: 'drawerTabActivity' },
];

function cadence(ms: number | undefined, t: TFunction): string {
  if (!ms || ms <= 0) return t('drawerCadenceManual');
  const mins = Math.round(ms / 60_000);
  return mins < 60 ? t('drawerCadenceMinutes', { minutes: mins }) : t('drawerCadenceHours', { hours: Math.round(mins / 60) });
}

export function AgentDrawer({ view, approvals, tab, onTab, onClose, onCheckNow, busy, onResolved, onChat }: {
  view: AgentView;
  /** Pending approvals for THIS agent. */
  approvals: PendingApproval[];
  tab: DrawerTab;
  onTab: (tab: DrawerTab) => void;
  onClose: () => void;
  onCheckNow: () => void;
  busy: boolean;
  onResolved: () => void;
  onChat: () => void;
}): JSX.Element {
  const { t } = useTranslation('agents');
  const { entry } = view;
  const sm = statusMeta(view.status);
  const theme = roleThemeForAgent(entry.agentRef?.agentId, entry.workflows, entry.roleKey);
  const [resolving, setResolving] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);

  // Esc closes; focus moves into the dialog when the drawer opens.
  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const approve = async (a: PendingApproval): Promise<void> => {
    setResolving(a.approvalId);
    try {
      const { runId } = await claimApproval(a.approvalId);
      // Polymorphic: a run-proposal yields a runId; an assistant-action decides
      // a drafted action in place (no run to cite).
      toast.success(runId ? t('drawerApprovedRun', { persona: a.persona, runId: runId.slice(0, 8) }) : t('drawerApprovedCarrying', { persona: a.persona }));
      onResolved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('drawerClaimError'));
    } finally {
      setResolving(null);
    }
  };
  const sendBack = async (a: PendingApproval): Promise<void> => {
    setResolving(a.approvalId);
    try {
      await rejectApproval(a.approvalId);
      toast.info(t('drawerSentBack', { persona: a.persona }));
      onResolved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('drawerRejectError'));
    } finally {
      setResolving(null);
    }
  };

  const waitingCard = view.cards.find((c) => c.columnId === 'waiting');

  return (
    <ModalPortal>
    <div
      className="agent-drawer-scrim"
      role="button"
      tabIndex={0}
      aria-label={t('drawerClose')}
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      {/* role="dialog" is a window/structure role the a11y plugin treats as
          non-interactive; the onClick only stops the click from bubbling to
          the scrim so a click inside the drawer doesn't close it. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events */}
      <aside
        ref={dialogRef}
        tabIndex={-1}
        className="agent-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={t('drawerQuickLook', { persona: entry.persona })}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="agent-drawer-head">
          <AgentAvatar persona={entry.persona} avatarUrl={entry.avatarUrl} roleTheme={theme} size={44} showBadge={false} ring={statusRingColor(view.status)} />
          <div className="agent-drawer-id">
            <div className="agent-drawer-name-line">
              <span className="agent-drawer-name">{entry.persona}</span>
              <span className={`chip ${sm.chip}`} title={sm.help}><span className="chip-dot" aria-hidden />{sm.label}</span>
            </div>
            <div className="agent-drawer-role">{entry.label ?? t('drawerRoleFallback')}</div>
          </div>
          <div className="action-bar agent-drawer-headactions">
            <button type="button" className="secondary btn-sm" disabled={busy || !entry.enabled} onClick={onCheckNow}>
              {busy ? t('drawerChecking') : t('drawerCheckNow')}
            </button>
            <button type="button" className="secondary btn-sm" onClick={onChat} title={t('drawerChatTitle', { persona: entry.persona })}>
              <MessageSquareIcon size={14} aria-hidden /> {t('drawerChat')}
            </button>
            <IconButton label={t('drawerCloseQuickLook')} icon={<XIcon size={16} />} onClick={onClose} />
          </div>
        </header>

        <div role="tablist" className="agent-drawer-tabs" onKeyDown={handleTablistKeyDown}>
          {TABS.map((tabDef) => (
            <button
              key={tabDef.key}
              role="tab"
              type="button"
              aria-selected={tab === tabDef.key}
              tabIndex={tab === tabDef.key ? 0 : -1}
              className={tab === tabDef.key ? 'agent-drawer-tab is-active' : 'agent-drawer-tab'}
              onClick={() => onTab(tabDef.key)}
            >
              {t(tabDef.labelKey)}
            </button>
          ))}
        </div>

        <div className="agent-drawer-body">
          {tab === 'overview' ? (
            <div className="agent-drawer-overview">
              {approvals.map((a) => (
                <div className="agent-drawer-ask" key={a.approvalId}>
                  <div className="agent-drawer-ask-eyebrow">
                    <AlertIcon size={13} aria-hidden /> {t('drawerWaitingOnYou', { when: relativeTime(a.createdAt) ?? t('drawerNow') })}
                  </div>
                  <div className="agent-drawer-ask-title">{a.cardTitle ?? a.proposal}</div>
                  <div className="agent-drawer-ask-detail">{t('drawerProposesToRun', { workflow: workflowName(a.workflowId) })}</div>
                  <div className="action-bar u-mt-2">
                    <button type="button" className="btn-accent-solid btn-sm" disabled={resolving === a.approvalId} onClick={() => void approve(a)}>
                      <CheckIcon size={14} aria-hidden /> {t('drawerApproveResume')}
                    </button>
                    <button type="button" className="secondary btn-sm" disabled={resolving === a.approvalId} onClick={() => void sendBack(a)}>
                      {t('drawerSendBack')}
                    </button>
                  </div>
                </div>
              ))}
              {approvals.length === 0 && waitingCard ? (
                <div className="agent-drawer-ask">
                  <div className="agent-drawer-ask-eyebrow">
                    <ClockIcon size={13} aria-hidden /> {t('drawerInWaitingSince', { when: relativeTime(waitingCard.updatedAt) ?? '—' })}
                  </div>
                  <div className="agent-drawer-ask-title">{waitingCard.title}</div>
                  <div className="agent-drawer-ask-detail">
                    {waitingCard.blockerNote
                      ?? (waitingCard.workflowId
                          ? t('drawerBlockerWorkflow', { workflow: workflowName(waitingCard.workflowId) })
                          : t('drawerBlockerFallback'))}
                  </div>
                  <div className="action-bar u-mt-2">
                    <button type="button" className="primary btn-sm" onClick={() => onTab('board')}>{t('drawerOpenBoard')}</button>
                  </div>
                </div>
              ) : null}

              <dl className="agent-drawer-facts">
                <div><dt>{t('drawerAutonomy')}</dt><dd><AutonomyMeter autonomyLevel={entry.autonomyLevel} /></dd></div>
                <div><dt>{t('drawerHeartbeat')}</dt><dd>{cadence(entry.heartbeatIntervalMs, t)}</dd></div>
                <div><dt>{t('drawerLastCheck')}</dt><dd>{relativeTime(entry.lastHeartbeatAt) ?? t('drawerNever')}</dd></div>
                <div><dt>{t('drawerPortfolio')}</dt><dd>{t('workflowCount', { count: entry.workflows.length })}</dd></div>
              </dl>

              {entry.description ? <Markdown className="u-fs-12">{entry.description}</Markdown> : null}

              <div className="agent-drawer-lanes">
                {([['drawerLaneTodo', view.laneCounts.todo], ['drawerLaneWorking', view.laneCounts.working], ['drawerLaneWaiting', view.laneCounts.waiting], ['drawerLaneDone', view.laneCounts.done]] as const).map(([laneKey, n]) => (
                  <div key={laneKey}><span className="agent-drawer-lane-n">{n}</span><span className="agent-drawer-lane-l">{t(laneKey)}</span></div>
                ))}
              </div>

              {view.nextSchedule ? (
                <p className="agent-drawer-next">
                  {t('drawerNextScheduled', { workflow: workflowName(view.nextSchedule.workflowId ?? entry.workflows[0] ?? ''), label: String(view.nextSchedule.metadata?.label ?? view.nextSchedule.cronExpr) })}
                </p>
              ) : null}
            </div>
          ) : null}

          {tab === 'board' ? (
            view.board
              ? <AgentBoardPanel boardId={view.board.id} persona={entry.persona} avatarUrl={entry.avatarUrl} roleTheme={theme} workflows={entry.workflows} refreshSignal={0} onChanged={onResolved} />
              : <p className="agent-drawer-empty">{t('drawerNoBoard', { persona: entry.persona })}</p>
          ) : null}

          {tab === 'activity' ? (
            <AgentActivityTab rosterId={entry.rosterId} persona={entry.persona} refreshSignal={0} />
          ) : null}
        </div>

        <footer className="agent-drawer-foot">
          <Link to={`/agents/${encodeURIComponent(entry.rosterId)}`} className="agent-drawer-full">
            {t('drawerOpenFullWorkspace')} <ArrowRightIcon size={14} aria-hidden />
          </Link>
        </footer>
      </aside>
    </div>
    </ModalPortal>
  );
}
