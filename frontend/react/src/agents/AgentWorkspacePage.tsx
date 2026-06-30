/**
 * `/agents/:rosterId` — the agent workspace (PRD §9). One named coworker's
 * home: header (status, heartbeat, actions) + tabs Overview / Workflows /
 * Board / Schedules / Instructions / Integrations / Activity.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../ui/confirm.js';
import { handleTablistKeyDown } from '../ui/rovingTabs.js';
import type { TFunction } from 'i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { checkAgent, deleteRosterEntry, updateRosterEntry, getAgentProfile } from './rosterClient.js';
import { loadAgentView, statusMeta, relativeTime, type AgentView } from './agentViewModel.js';
import { workflowName, roleThemeForAgent } from './roleTemplates.js';
import { PlayIcon, ColumnsIcon, AlertIcon, PinIcon, CheckIcon, ChevronDownIcon, ArrowLeftIcon, PencilIcon } from '../ui/icons/index.js';
import type { KanbanCard, KanbanColumn } from '../kanban/kanbanClient.js';
import { AgentBoardPanel } from './AgentBoardPanel.js';
import { AgentWorkflowPortfolioPanel } from './AgentWorkflowPortfolioPanel.js';
import { AgentSchedulesPanel } from './AgentSchedulesPanel.js';
import { AgentInstructionsPanel } from './AgentInstructionsPanel.js';
import { AgentVoicePanel } from './AgentVoicePanel.js';
import { AgentTwinPanel } from '../features/twin/AgentTwinPanel.js';
import { AgentKnowledgePanel } from '../features/agent-knowledge/AgentKnowledgePanel.js';
import { AgentMemoryTab } from '../features/agent-knowledge/AgentMemoryTab.js';
import { AgentIntegrationsPanel } from './AgentIntegrationsPanel.js';
import { AgentConnectionStatusPanel } from './AgentConnectionStatusPanel.js';
import { AgentActivityTab } from './AgentActivityTab.js';
import { RecurringTasksPanel } from './RecurringTasksPanel.js';
import { AgentHealthPanel } from './AgentHealthPanel.js';
import { AgentAvatar } from './AgentAvatar.js';
import { getMyProfile, setAgentPinned, setChatAgentPinned } from '../features/profiles/profilesClient.js';
import { AvatarEditor } from './AvatarEditor.js';
import { AgentDetailsEditor } from './AgentDetailsEditor.js';
import { Notice } from '../ui/Notice.js';
import { StateCard } from '../ui/StateCard.js';
import { Markdown } from '../ui/Markdown.js';

/** Human label for an autonomous-heartbeat cadence (ms). 0/absent ⇒ manual. */
function formatHeartbeat(intervalMs: number | undefined, t: TFunction): string {
  if (!intervalMs || intervalMs <= 0) return t('wsHeartbeatManual');
  const mins = Math.round(intervalMs / 60_000);
  if (mins < 60) return t('wsHeartbeatMinutes', { minutes: mins });
  const hrs = Math.round(mins / 60);
  return t('wsHeartbeatHours', { hours: hrs });
}

type TabKey = 'overview' | 'workflows' | 'board' | 'schedules' | 'instructions' | 'knowledge' | 'memory' | 'integrations' | 'activity';
const TABS: ReadonlyArray<{ key: TabKey; labelKey: string }> = [
  { key: 'overview', labelKey: 'wsTabOverview' },
  { key: 'workflows', labelKey: 'wsTabWorkflows' },
  { key: 'board', labelKey: 'wsTabBoard' },
  { key: 'schedules', labelKey: 'wsTabSchedules' },
  // ADR 0101 — the former Profile tab is folded into Instructions as "Guardrails".
  { key: 'instructions', labelKey: 'wsTabInstructions' },
  // ADR 0038 — per-agent knowledge & memory (always-on since 2026-06-16).
  { key: 'knowledge', labelKey: 'wsTabKnowledge' },
  // ADR 0041 — the per-agent memory browser.
  { key: 'memory', labelKey: 'wsTabMemory' },
  { key: 'integrations', labelKey: 'wsTabIntegrations' },
  { key: 'activity', labelKey: 'wsTabActivity' },
];

export function AgentWorkspacePage(): JSX.Element {
  const { t } = useTranslation('agents');
  const { agentId: rosterId } = useParams<{ agentId: string }>();
  const navigate = useNavigate();
  const [view, setView] = useState<AgentView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingAvatar, setEditingAvatar] = useState(false);
  const [editingDetails, setEditingDetails] = useState(false);
  // Bumped on board-affecting actions (Check now) so the embedded board refetches.
  const [boardRefresh, setBoardRefresh] = useState(0);
  // Tab lives in the URL (?tab=board) so refresh / back / share preserve it.
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab: TabKey = TABS.some((t) => t.key === tabParam) ? (tabParam as TabKey) : 'overview';
  const setTab = (next: TabKey): void => {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      if (next === 'overview') p.delete('tab');
      else p.set('tab', next);
      return p;
    }, { replace: true });
  };

  // ADR 0038 — Knowledge + Memory are always-on (graduated off the toggle
  // 2026-06-16); every tab is visible. The backend remains the authority
  // (RBAC + IDOR + profile policy on each knowledge call).
  const visibleTabs = TABS;

  const refresh = useCallback(async () => {
    if (!rosterId) return;
    try {
      setView(await loadAgentView(rosterId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [rosterId]);

  // Pin state (ADR 0023 — pin an agent to the sidebar). Loaded from the
  // caller's own profile; the Sidebar reads the same source, so a pin here
  // shows up there after the profile refetch a pin triggers there.
  const [pinned, setPinned] = useState(false);
  const [chatPinned, setChatPinned] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const v = rosterId ? await loadAgentView(rosterId) : null;
        if (!cancelled) setView(v);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [rosterId]);

  useEffect(() => {
    if (!rosterId) return undefined;
    let cancelled = false;
    void getMyProfile()
      .then((p) => {
        if (cancelled) return;
        setPinned((p.pinnedAgentIds ?? []).includes(rosterId));
        setChatPinned((p.pinnedChatAgentIds ?? []).includes(rosterId));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [rosterId]);

  const onTogglePin = useCallback(async (target: 'sidebar' | 'chat') => {
    if (!rosterId) return;
    setPinBusy(true);
    try {
      if (target === 'sidebar') {
        await setAgentPinned(rosterId, !pinned);
        setPinned((v) => !v);
        // Tell the Sidebar to re-read its pinned list.
        window.dispatchEvent(new Event('openwop:pinned-agents-changed'));
      } else {
        await setChatAgentPinned(rosterId, !chatPinned);
        setChatPinned((v) => !v);
        // Tell the chat welcome panel to re-read its pinned agents.
        window.dispatchEvent(new Event('openwop:pinned-chat-agents-changed'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('wsUpdatePinError'));
    } finally {
      setPinBusy(false);
    }
  }, [rosterId, pinned, chatPinned, t]);

  const onCheckNow = async () => {
    if (!view) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const result = await checkAgent(view.entry.rosterId);
      setNotice(result.picked
        ? t('wsCheckPickedUp', { persona: view.entry.persona, title: result.cardTitle })
        : t('wsNoEligible', { reason: result.reason ?? t('wsIdle') }));
      await refresh();
      setBoardRefresh((n) => n + 1); // make the Board tab reflect the moved card immediately
      if (result.picked) setTab('board');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onTogglePause = async () => {
    if (!view) return;
    try {
      await updateRosterEntry(view.entry.rosterId, { enabled: !view.entry.enabled });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Delete this coworker. The backend cascades the member's board, schedules,
  // pending approvals, org-chart seat, and chat agent (no orphans), so this is
  // a clean removal — and the silent demo auto-seed will NOT resurrect it.
  const onDelete = async () => {
    if (!view) return;
    if (!(await confirm({ title: t('wsDeleteConfirm', { persona: view.entry.persona }), danger: true, confirmLabel: t('common:delete') }))) return;
    setBusy(true);
    setError(null);
    try {
      await deleteRosterEntry(view.entry.rosterId);
      navigate('/agents');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false); // stay on the page so the user can retry; on success we navigate away
    }
  };

  // Persisted the edit-details dialog: close it, refresh the header/tabs from
  // the server, and confirm. The PATCH already landed inside the dialog.
  const onDetailsSaved = async () => {
    setError(null);
    setEditingDetails(false);
    await refresh();
    setNotice(t('wsDetailsUpdated'));
  };

  // Save (string data-URI) or clear (null) the profile photo, then refresh so
  // the header — and, after navigation, the dashboard card — reflect it.
  const onSaveAvatar = async (avatarUrl: string | null) => {
    if (!view) return;
    setNotice(null);
    setError(null);
    try {
      await updateRosterEntry(view.entry.rosterId, { avatarUrl });
      setEditingAvatar(false);
      await refresh();
      setNotice(avatarUrl ? t('wsAvatarUpdated', { persona: view.entry.persona }) : t('wsAvatarRemoved', { persona: view.entry.persona }));
    } catch (err) {
      // Keep the editor open so the user can retry / shrink an oversized image.
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (loading) return <section className="u-p-4"><StateCard title={t('wsLoadingAgent')} loading /></section>;
  if (!view) {
    return (
      <section className="u-p-4">
        <StateCard
          icon={<AlertIcon size={20} />}
          title={t('wsNotFoundTitle')}
          body={t('wsNotFoundBody')}
          action={<Link to="/agents" className="secondary btn-sm">{t('wsBackToAgents')}</Link>}
        />
      </section>
    );
  }

  const { entry } = view;
  const sm = statusMeta(view.status);
  const theme = roleThemeForAgent(entry.agentRef?.agentId, entry.workflows, entry.roleKey);

  return (
    <section>
      <Link to="/agents" className="u-fs-12 muted"><ArrowLeftIcon size={12} /> {t('backToAgents')}</Link>

      {/* Header */}
      <div className="agentws-header">
        <AgentAvatar persona={entry.persona} avatarUrl={entry.avatarUrl} roleTheme={theme} size={48} onEdit={() => setEditingAvatar(true)} />
        <div className="u-flex-1 u-minw-200">
          <h1 className="u-m-0 u-flex u-items-center u-gap-2 u-wrap">
            {entry.persona}
            <button
              type="button"
              className="secondary btn-sm u-iflex u-items-center u-gap-1"
              onClick={() => setEditingDetails(true)}
              title={t('wsEditDetailsTitle', { persona: entry.persona })}
            >
              <PencilIcon size={13} /> {t('wsEditDetails')}
            </button>
          </h1>
          <div className="muted">{entry.label ?? t('agent')}</div>
        </div>
        <div className="action-bar">
          <details className="pin-menu">
            <summary
              className={pinned || chatPinned ? 'btn-accent' : 'secondary'}
              aria-haspopup="menu"
              title={t('wsPinTitle')}
            >
              <PinIcon size={14} style={{ verticalAlign: '-2px', marginInlineEnd: '4px' }} />
              {pinned || chatPinned ? t('wsPinned') : t('wsPin')}
              <ChevronDownIcon size={14} style={{ verticalAlign: '-2px', marginInlineStart: '4px' }} />
            </summary>
            <div className="pin-menu-panel surface-card" role="menu">
              <button
                type="button"
                className="account-menu-item"
                role="menuitemcheckbox"
                aria-checked={pinned}
                disabled={pinBusy}
                onClick={() => void onTogglePin('sidebar')}
              >
                <span className="account-menu-item-icon" aria-hidden>{pinned ? <CheckIcon size={16} /> : <PinIcon size={16} />}</span>
                {pinned ? t('wsPinnedToSidebar') : t('wsPinToSidebar')}
              </button>
              <button
                type="button"
                className="account-menu-item"
                role="menuitemcheckbox"
                aria-checked={chatPinned}
                disabled={pinBusy}
                onClick={() => void onTogglePin('chat')}
              >
                <span className="account-menu-item-icon" aria-hidden>{chatPinned ? <CheckIcon size={16} /> : <PinIcon size={16} />}</span>
                {chatPinned ? t('wsPinnedToChat') : t('wsPinToChat')}
              </button>
            </div>
          </details>
          <span className={`chip ${sm.chip}`} title={sm.help}>{sm.label}</span>
          <span
            className="chip chip--muted"
            title={
              entry.heartbeatIntervalMs && entry.heartbeatIntervalMs > 0
                ? t('wsHeartbeatTitleAuto')
                : t('wsHeartbeatTitleManual')
            }
          >
            {t('wsHeartbeatLabel', { cadence: formatHeartbeat(entry.heartbeatIntervalMs, t) })}
          </span>
        </div>
      </div>

      <div className="action-bar u-mb-3 u-items-center">
        <button
          type="button"
          className="primary"
          onClick={() => void onCheckNow()}
          disabled={busy || !entry.enabled}
          title={t('wsCheckNowTitle', { persona: entry.persona })}
        >
          {busy ? t('wsChecking') : t('wsCheckNow')}
        </button>
        <button type="button" className="secondary" onClick={() => setTab('board')}>{t('wsAddTask')}</button>
        <button type="button" className="secondary" onClick={() => setTab('workflows')}>{t('wsRunWorkflow')}</button>
        <button type="button" className="secondary" onClick={() => void onTogglePause()}>{entry.enabled ? t('wsPause') : t('wsResume')}</button>
        <button type="button" className="secondary" onClick={() => setTab('instructions')}>{t('wsInstructions')}</button>
        <button
          type="button"
          className="secondary u-text-danger"
          onClick={() => void onDelete()}
          disabled={busy}
          title={t('wsDeleteTitle', { persona: entry.persona })}
        >
          {t('wsDelete')}
        </button>
        <span className="muted u-fs-12">
          {entry.lastHeartbeatAt
            ? t('wsLastChecked', { when: relativeTime(entry.lastHeartbeatAt) })
            : t('wsNotChecked')}
          {view.nextSchedule
            ? t('wsNextScheduled', { label: String(view.nextSchedule.metadata?.label ?? view.nextSchedule.cronExpr) })
            : ''}
        </span>
      </div>

      {error ? <Notice variant="error">{error}</Notice> : null}
      {notice ? <Notice variant="success">{notice}</Notice> : null}

      {/* Tabs — the canonical editorial tab strip (DESIGN.md §5 `.tabs`/`.tab`),
          symmetric with the user profile's tabs (ADR 0025). */}
      <div className="tabs u-mb-4 u-wrap" role="tablist" onKeyDown={handleTablistKeyDown}>
        {visibleTabs.map((tabItem) => (
          <button
            key={tabItem.key}
            type="button"
            role="tab"
            aria-selected={tab === tabItem.key}
            tabIndex={tab === tabItem.key ? 0 : -1}
            className="tab"
            onClick={() => setTab(tabItem.key)}
          >
            {t(tabItem.labelKey)}
          </button>
        ))}
      </div>

      {tab === 'overview' ? <OverviewTab view={view} onGoto={setTab} onCheckNow={() => void onCheckNow()} busy={busy} /> : null}
      {tab === 'workflows' ? <AgentWorkflowPortfolioPanel entry={entry} jobs={view.jobs} board={view.board} onChanged={() => void refresh()} /> : null}
      {tab === 'board' ? (view.board ? <AgentBoardPanel boardId={view.board.id} persona={entry.persona} avatarUrl={entry.avatarUrl} roleTheme={theme} workflows={entry.workflows} refreshSignal={boardRefresh} onChanged={() => void refresh()} /> : <NoBoard persona={entry.persona} />) : null}
      {tab === 'schedules' ? <AgentSchedulesPanel entry={entry} /> : null}
      {tab === 'instructions' ? (
        <div className="u-flex u-flex-col u-gap-4">
          <AgentInstructionsPanel entry={entry} onChanged={() => void refresh()} />
          <AgentVoicePanel rosterId={entry.rosterId} />
        </div>
      ) : null}
      {tab === 'knowledge' ? <AgentKnowledgePanel rosterId={entry.rosterId} persona={entry.persona} /> : null}
      {tab === 'memory' ? <AgentMemoryTab rosterId={entry.rosterId} persona={entry.persona} /> : null}
      {tab === 'integrations' ? (
        <div className="u-flex u-flex-col u-gap-4">
          <AgentConnectionStatusPanel rosterId={entry.rosterId} />
          <AgentIntegrationsPanel boardId={view.board?.id ?? null} persona={entry.persona} onChanged={() => void refresh()} />
          {/* ADR 0044 — the "Twin of …" agent↔person recall link (self-gates on
              the twin-recall toggle). Relocated here from the removed Profile tab
              (ADR 0101) — it's an integration-style link, not a governance guardrail. */}
          <AgentTwinPanel rosterId={entry.rosterId} persona={entry.persona} />
        </div>
      ) : null}
      {tab === 'activity' ? <AgentActivityTab rosterId={entry.rosterId} persona={entry.persona} refreshSignal={boardRefresh} /> : null}

      {/* ADR 0023 — the Chief of Staff's recurring tasks (perception loops) +
          operating-health metrics. These are at-a-glance summaries ("what it
          runs on a schedule" + "how it's doing"), so they belong on the
          Overview tab only — previously they rendered after the tab switch and
          repeated at the bottom of EVERY tab. Only this agent owns loops/health;
          the health panel self-hides for non-admins (superadmin-gated endpoint). */}
      {entry.roleKey === 'chief-of-staff' && tab === 'overview' ? (
        <div className="u-mt-4 u-grid u-gap-4">
          <RecurringTasksPanel />
          <AgentHealthPanel persona={entry.persona} />
        </div>
      ) : null}

      <details className="u-mt-5">
        <summary className="muted u-fs-12 u-cursor-pointer">{t('wsAdvancedSummary')}</summary>
        <p className="muted u-fs-12 u-mt-2">
          {t('wsAdvancedDetail', { persona: entry.persona, agentId: entry.agentRef.agentId, rosterId: entry.rosterId })}
          {' '}<button type="button" className="secondary btn-sm" onClick={() => navigate('/roster')}>{t('wsOpenRawRoster')}</button>
        </p>
      </details>

      {editingAvatar ? (
        <AvatarEditor
          personaName={entry.persona}
          currentAvatarUrl={entry.avatarUrl}
          onCancel={() => setEditingAvatar(false)}
          onSave={onSaveAvatar}
        />
      ) : null}

      {editingDetails ? (
        <AgentDetailsEditor
          entry={entry}
          onClose={() => setEditingDetails(false)}
          onSaved={() => { void onDetailsSaved(); }}
        />
      ) : null}
    </section>
  );
}

function NoBoard({ persona }: { persona: string }): JSX.Element {
  const { t } = useTranslation('agents');
  return (
    <StateCard
      icon={<ColumnsIcon size={20} />}
      title={t('wsNoBoardTitle')}
      body={t('wsNoBoardBody', { persona })}
    />
  );
}

const PRIORITY_RANK: Record<string, number> = { high: 0, normal: 1, low: 2 };
function colMatches(col: KanbanColumn, kind: 'todo' | 'working' | 'done'): boolean {
  const id = col.id.toLowerCase();
  const name = col.name.toLowerCase();
  if (kind === 'todo') return id === 'todo' || name === 'to do';
  if (kind === 'done') return id === 'done' || name === 'done';
  return id === 'working' || id === 'doing' || name === 'working' || name === 'doing';
}
function topByPriority(cards: KanbanCard[]): KanbanCard | undefined {
  return [...cards].sort(
    (a, b) => ((PRIORITY_RANK[a.priority ?? 'normal'] ?? 0) - (PRIORITY_RANK[b.priority ?? 'normal'] ?? 0)) || a.order - b.order,
  )[0];
}

/** The dominant "what should I do now?" panel — the most important pending
 *  task, the run in flight, and the next scheduled run, so the workspace opens
 *  on the answer instead of a grid of equal-weight stat cards. */
function PriorityPanel({
  view,
  onGoto,
  onCheckNow,
  busy,
}: {
  view: AgentView;
  onGoto: (t: TabKey) => void;
  onCheckNow: () => void;
  busy: boolean;
}): JSX.Element {
  const { t } = useTranslation('agents');
  const { entry, board, cards, nextSchedule } = view;
  const todoCol = board?.columns.find((c) => colMatches(c, 'todo'));
  const workingCol = board?.columns.find((c) => colMatches(c, 'working'));
  const doneCol = board?.columns.find((c) => colMatches(c, 'done'));
  const topTodo = todoCol ? topByPriority(cards.filter((c) => c.columnId === todoCol.id)) : undefined;
  // "In progress" = a run on a card in the Working lane; fall back to any card
  // with a run that is NOT already Done, so a finished run is never mislabeled
  // as running on a board without a canonical Working lane.
  const running =
    (workingCol ? cards.filter((c) => c.columnId === workingCol.id && c.lastRunId)[0] : undefined) ??
    cards.find((c) => c.lastRunId && c.columnId !== doneCol?.id);

  return (
    <div className="surface-card agentws-priority-card">
      <div className="u-flex u-gap-4 u-wrap">
        <div className="agentws-cell">
          <div className="agentws-stat-label">{t('wsNextUp')}</div>
          {topTodo ? (
            <>
              <div className="u-fw-600 u-fs-14">
                {topTodo.title}
                {topTodo.priority === 'high' ? <span className="chip chip--danger agentws-high-chip">{t('wsHigh')}</span> : null}
              </div>
              <button type="button" className="primary btn-sm u-mt-1-5" onClick={onCheckNow} disabled={busy || !entry.enabled}>
                {busy ? t('wsChecking') : t('wsPickUpNow')}
              </button>
            </>
          ) : (
            <div className="muted u-fs-13">{t('wsNoPendingTasks')} <button type="button" className="secondary btn-sm" onClick={() => onGoto('board')}>{t('wsAddATask')}</button></div>
          )}
        </div>
        <div className="agentws-cell">
          <div className="agentws-stat-label">{t('wsInProgress')}</div>
          {running ? (
            <div className="u-fs-14">
              <div className="u-fw-600">{running.title}</div>
              {running.lastRunId ? <Link to={`/runs/${running.lastRunId}`} className="u-iflex u-items-center u-gap-1 u-fs-13 u-mt-1"><PlayIcon size={12} /> {t('wsViewRun')}</Link> : null}
            </div>
          ) : (
            <div className="muted u-fs-13">{t('wsNothingRunning')}</div>
          )}
        </div>
        <div className="agentws-cell">
          <div className="agentws-stat-label">{t('wsNextScheduledLabel')}</div>
          {nextSchedule ? (
            <div className="u-fs-14">
              <div className="u-fw-600">{workflowName(nextSchedule.workflowId ?? entry.workflows[0] ?? '')}</div>
              <div className="muted u-fs-13 u-mt-1">{String(nextSchedule.metadata?.label ?? nextSchedule.cronExpr)}</div>
            </div>
          ) : (
            <div className="muted u-fs-13">{t('wsNoSchedule')} <button type="button" className="secondary btn-sm" onClick={() => onGoto('schedules')}>{t('wsAddOne')}</button></div>
          )}
        </div>
      </div>
    </div>
  );
}

function OverviewTab({ view, onGoto, onCheckNow, busy }: { view: AgentView; onGoto: (t: TabKey) => void; onCheckNow: () => void; busy: boolean }): JSX.Element {
  const { t } = useTranslation('agents');
  const { entry, laneCounts, nextSchedule } = view;
  return (
    <>
    <PriorityPanel view={view} onGoto={onGoto} onCheckNow={onCheckNow} busy={busy} />
    <div className="agentws-overview-grid">
      <div className="agentws-overview-card">
        <strong>{t('wsWhatDoes', { persona: entry.persona })}</strong>
        {entry.description
          ? <Markdown className="u-fs-14">{entry.description}</Markdown>
          : <p className="u-fs-14 u-mb-0">{t('wsRoleNoDescription', { label: entry.label ?? t('agent') })}</p>}
      </div>
      <div className="agentws-overview-card">
        <strong>{t('wsWorkflowPortfolio')}</strong>
        <p className="u-fs-14">{entry.workflows.length === 0 ? t('wsNoWorkflowsYet') : t('wsWorkflowsAssigned', { count: entry.workflows.length })}</p>
        <ul className="agentws-portfolio-list">
          {entry.workflows.slice(0, 4).map((w) => <li key={w}>{workflowName(w)}</li>)}
        </ul>
        <button type="button" className="secondary u-fs-12 u-mt-1-5" onClick={() => onGoto('workflows')}>{t('wsManageWorkflows')}</button>
      </div>
      <div className="agentws-overview-card">
        <strong>{t('wsTaskBoard')}</strong>
        <p className="u-fs-14 u-mb-1-5">{t('wsLaneCounts', { todo: laneCounts.todo, working: laneCounts.working, waiting: laneCounts.waiting, done: laneCounts.done })}</p>
        <button type="button" className="secondary u-fs-12" onClick={() => onGoto('board')}>{t('wsOpenBoard')}</button>
      </div>
      <div className="agentws-overview-card">
        <strong>{t('wsSchedule')}</strong>
        <p className="u-fs-14 u-mb-1-5">{nextSchedule ? String(nextSchedule.metadata?.label ?? nextSchedule.cronExpr) : t('wsNoScheduleYet')}</p>
        <button type="button" className="secondary u-fs-12" onClick={() => onGoto('schedules')}>{t('wsManageSchedules')}</button>
      </div>
      {/* ADR 0101 Phase 3 — the agent's declared success metrics, surfaced from
          its guardrails profile. Self-hides when none are declared. */}
      <AgentMetricsCard rosterId={entry.rosterId} />
      <div className="agentws-overview-card agentws-card-full">
        <strong>{t('wsNextSteps')}</strong>
        <ul className="agentws-next-steps-list">
          <li>{t('wsNextStepAddTask', { persona: entry.persona })}</li>
          <li>{t('wsNextStepAssign')}</li>
          <li>{t('wsNextStepSchedule')}</li>
          <li>{t('wsNextStepDiscord', { persona: entry.persona })}</li>
        </ul>
      </div>
    </div>
    </>
  );
}

/** The agent's declared success metrics (agentProfile.metrics), shown on the
 *  Overview tab. Self-fetches + self-hides when there are none (ADR 0101 §3) —
 *  display-only; these are the KPIs to watch, not enforced values. */
function AgentMetricsCard({ rosterId }: { rosterId: string }): JSX.Element | null {
  const { t } = useTranslation('agents');
  const [metrics, setMetrics] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void getAgentProfile(rosterId)
      .then((p) => { if (!cancelled) setMetrics(p?.metrics ?? []); })
      .catch(() => { /* no profile / not readable → render nothing */ });
    return () => { cancelled = true; };
  }, [rosterId]);
  if (metrics.length === 0) return null;
  return (
    <div className="agentws-overview-card agentws-card-full">
      <strong>{t('wsSuccessMetrics')}</strong>
      <p className="u-fs-13 muted u-mt-1 u-mb-1-5">{t('wsSuccessMetricsHint')}</p>
      <div className="u-flex u-gap-2 u-wrap">
        {metrics.map((m) => <span key={m} className="chip chip--muted">{m}</span>)}
      </div>
    </div>
  );
}
