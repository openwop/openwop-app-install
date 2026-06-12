/**
 * `/agents/:rosterId` — the agent workspace (PRD §9). One named coworker's
 * home: header (status, heartbeat, actions) + tabs Overview / Workflows /
 * Board / Schedules / Instructions / Integrations / Activity.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { checkAgent, updateRosterEntry } from './rosterClient.js';
import { loadAgentView, statusMeta, relativeTime, type AgentView } from './agentViewModel.js';
import { workflowName, roleThemeForAgent } from './roleTemplates.js';
import { PlayIcon, ColumnsIcon, AlertIcon, PinIcon } from '../ui/icons/index.js';
import type { KanbanCard, KanbanColumn } from '../kanban/kanbanClient.js';
import { AgentBoardPanel } from './AgentBoardPanel.js';
import { AgentWorkflowPortfolioPanel } from './AgentWorkflowPortfolioPanel.js';
import { AgentSchedulesPanel } from './AgentSchedulesPanel.js';
import { AgentInstructionsPanel } from './AgentInstructionsPanel.js';
import { AgentIntegrationsPanel } from './AgentIntegrationsPanel.js';
import { AgentActivityTab } from './AgentActivityTab.js';
import { RecurringTasksPanel } from './RecurringTasksPanel.js';
import { AgentHealthPanel } from './AgentHealthPanel.js';
import { AgentAvatar } from './AgentAvatar.js';
import { getMyProfile, setAgentPinned } from '../features/profiles/profilesClient.js';
import { AvatarEditor } from './AvatarEditor.js';
import { Notice } from '../ui/Notice.js';
import { StateCard } from '../ui/StateCard.js';
import { Markdown } from '../ui/Markdown.js';

/** Human label for an autonomous-heartbeat cadence (ms). 0/absent ⇒ manual. */
function formatHeartbeat(intervalMs: number | undefined): string {
  if (!intervalMs || intervalMs <= 0) return 'manual';
  const mins = Math.round(intervalMs / 60_000);
  if (mins < 60) return `every ${mins}m`;
  const hrs = Math.round(mins / 60);
  return `every ${hrs}h`;
}

type TabKey = 'overview' | 'workflows' | 'board' | 'schedules' | 'instructions' | 'integrations' | 'activity';
const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'workflows', label: 'Workflows' },
  { key: 'board', label: 'Board' },
  { key: 'schedules', label: 'Recurring tasks' },
  { key: 'instructions', label: 'Instructions' },
  { key: 'integrations', label: 'Integrations' },
  { key: 'activity', label: 'Activity' },
];

export function AgentWorkspacePage(): JSX.Element {
  const { agentId: rosterId } = useParams<{ agentId: string }>();
  const navigate = useNavigate();
  const [view, setView] = useState<AgentView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingAvatar, setEditingAvatar] = useState(false);
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
      .then((p) => { if (!cancelled) setPinned((p.pinnedAgentIds ?? []).includes(rosterId)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [rosterId]);

  const onTogglePin = useCallback(async () => {
    if (!rosterId) return;
    setPinBusy(true);
    try {
      await setAgentPinned(rosterId, !pinned);
      setPinned((v) => !v);
      // Tell the Sidebar to re-read its pinned list.
      window.dispatchEvent(new Event('openwop:pinned-agents-changed'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update pin.');
    } finally {
      setPinBusy(false);
    }
  }, [rosterId, pinned]);

  const onCheckNow = async () => {
    if (!view) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const result = await checkAgent(view.entry.rosterId);
      setNotice(result.picked ? `${view.entry.persona} picked up “${result.cardTitle}” and started a run.` : `No eligible To Do tasks (${result.reason ?? 'idle'}).`);
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
      setNotice(avatarUrl ? `Updated ${view.entry.persona}'s profile photo.` : `Removed ${view.entry.persona}'s profile photo.`);
    } catch (err) {
      // Keep the editor open so the user can retry / shrink an oversized image.
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (loading) return <section className="u-p-4"><StateCard title="Loading agent…" loading /></section>;
  if (!view) {
    return (
      <section className="u-p-4">
        <StateCard
          icon={<AlertIcon size={20} />}
          title="Agent not found"
          body="This coworker may have been removed or the link is out of date."
          action={<Link to="/agents" className="secondary btn-sm">Back to agents</Link>}
        />
      </section>
    );
  }

  const { entry } = view;
  const sm = statusMeta(view.status);
  const theme = roleThemeForAgent(entry.agentRef?.agentId, entry.workflows, entry.roleKey);

  return (
    <section>
      <Link to="/agents" className="u-fs-12 muted">← All agents</Link>

      {/* Header */}
      <div className="agentws-header">
        <AgentAvatar persona={entry.persona} avatarUrl={entry.avatarUrl} roleTheme={theme} size={48} onEdit={() => setEditingAvatar(true)} />
        <div className="u-flex-1 u-minw-200">
          <h1 className="u-m-0">{entry.persona}</h1>
          <div className="muted">{entry.label ?? 'Agent'}</div>
        </div>
        <div className="action-bar">
          <button
            type="button"
            className={pinned ? 'btn-accent' : 'secondary'}
            disabled={pinBusy}
            aria-pressed={pinned}
            onClick={() => void onTogglePin()}
            title={pinned ? 'Unpin from the sidebar' : 'Pin to the sidebar for quick access'}
          >
            <PinIcon size={14} style={{ verticalAlign: '-2px', marginInlineEnd: '4px' }} />
            {pinned ? 'Pinned' : 'Pin'}
          </button>
          <span className={`chip ${sm.chip}`} title={sm.help}>{sm.label}</span>
          <span
            className="chip chip--muted"
            title={
              entry.heartbeatIntervalMs && entry.heartbeatIntervalMs > 0
                ? 'A background daemon runs this agent’s “Check now” automatically on this cadence; you can also trigger it manually.'
                : 'This agent checks for work when you click “Check now”, plus on any enabled schedule.'
            }
          >
            Heartbeat: {formatHeartbeat(entry.heartbeatIntervalMs)}
          </span>
        </div>
      </div>

      <div className="action-bar u-mb-3 u-items-center">
        <button
          type="button"
          className="primary"
          onClick={() => void onCheckNow()}
          disabled={busy || !entry.enabled}
          title={`Run the heartbeat: let ${entry.persona} pick up the next To Do task and start its workflow.`}
        >
          {busy ? 'Checking…' : 'Check now'}
        </button>
        <button type="button" className="secondary" onClick={() => setTab('board')}>Add task</button>
        <button type="button" className="secondary" onClick={() => setTab('workflows')}>Run workflow</button>
        <button type="button" className="secondary" onClick={() => void onTogglePause()}>{entry.enabled ? 'Pause' : 'Resume'}</button>
        <button type="button" className="secondary" onClick={() => setTab('instructions')}>Instructions</button>
        <span className="muted u-fs-12">
          {entry.lastHeartbeatAt
            ? `Last checked ${relativeTime(entry.lastHeartbeatAt)}`
            : 'Not checked yet'}
          {view.nextSchedule
            ? ` · next scheduled run: ${String(view.nextSchedule.metadata?.label ?? view.nextSchedule.cronExpr)}`
            : ''}
        </span>
      </div>

      {error ? <Notice variant="error">{error}</Notice> : null}
      {notice ? <Notice variant="success">{notice}</Notice> : null}

      {/* Tabs — the canonical editorial tab strip (DESIGN.md §5 `.tabs`/`.tab`),
          symmetric with the user profile's tabs (ADR 0025). */}
      <div className="tabs u-mb-4 u-wrap" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className="tab"
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' ? <OverviewTab view={view} onGoto={setTab} onCheckNow={() => void onCheckNow()} busy={busy} /> : null}
      {tab === 'workflows' ? <AgentWorkflowPortfolioPanel entry={entry} jobs={view.jobs} board={view.board} onChanged={() => void refresh()} /> : null}
      {tab === 'board' ? (view.board ? <AgentBoardPanel boardId={view.board.id} persona={entry.persona} avatarUrl={entry.avatarUrl} roleTheme={theme} workflows={entry.workflows} refreshSignal={boardRefresh} onChanged={() => void refresh()} /> : <NoBoard persona={entry.persona} />) : null}
      {tab === 'schedules' ? <AgentSchedulesPanel entry={entry} /> : null}
      {tab === 'instructions' ? <AgentInstructionsPanel entry={entry} onChanged={() => void refresh()} /> : null}
      {tab === 'integrations' ? <AgentIntegrationsPanel boardId={view.board?.id ?? null} persona={entry.persona} onChanged={() => void refresh()} /> : null}
      {tab === 'activity' ? <AgentActivityTab rosterId={entry.rosterId} persona={entry.persona} refreshSignal={boardRefresh} /> : null}

      {/* ADR 0023 — the Chief of Staff's recurring tasks (perception loops) +
          operating-health metrics, shown at the bottom of its workspace. Only
          this agent owns loops/health; the health panel self-hides for
          non-admins (the endpoint is superadmin-gated). */}
      {entry.roleKey === 'chief-of-staff' ? (
        <div className="u-mt-4 u-grid u-gap-4">
          <RecurringTasksPanel />
          <AgentHealthPanel />
        </div>
      ) : null}

      <details className="u-mt-5">
        <summary className="muted u-fs-12 u-cursor-pointer">Advanced protocol details</summary>
        <p className="muted u-fs-12 u-mt-2">
          {entry.persona} runs manifest agent <code>{entry.agentRef.agentId}</code> · roster id <code>{entry.rosterId}</code>.
          {' '}<button type="button" className="secondary btn-sm" onClick={() => navigate('/roster')}>Open raw roster</button>
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
    </section>
  );
}

function NoBoard({ persona }: { persona: string }): JSX.Element {
  return (
    <StateCard
      icon={<ColumnsIcon size={20} />}
      title="No task board yet"
      body={`${persona} has no task board yet.`}
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
          <div className="agentws-stat-label">Next up</div>
          {topTodo ? (
            <>
              <div className="u-fw-600 u-fs-14">
                {topTodo.title}
                {topTodo.priority === 'high' ? <span className="chip chip--danger agentws-high-chip">High</span> : null}
              </div>
              <button type="button" className="primary btn-sm u-mt-1-5" onClick={onCheckNow} disabled={busy || !entry.enabled}>
                {busy ? 'Checking…' : 'Pick up now'}
              </button>
            </>
          ) : (
            <div className="muted u-fs-13">No pending tasks. <button type="button" className="secondary btn-sm" onClick={() => onGoto('board')}>Add a task</button></div>
          )}
        </div>
        <div className="agentws-cell">
          <div className="agentws-stat-label">In progress</div>
          {running ? (
            <div className="u-fs-14">
              <div className="u-fw-600">{running.title}</div>
              {running.lastRunId ? <Link to={`/runs/${running.lastRunId}`} className="u-iflex u-items-center u-gap-1 u-fs-13 u-mt-1"><PlayIcon size={12} /> View run</Link> : null}
            </div>
          ) : (
            <div className="muted u-fs-13">Nothing running.</div>
          )}
        </div>
        <div className="agentws-cell">
          <div className="agentws-stat-label">Next scheduled</div>
          {nextSchedule ? (
            <div className="u-fs-14">
              <div className="u-fw-600">{workflowName(nextSchedule.workflowId ?? entry.workflows[0] ?? '')}</div>
              <div className="muted u-fs-13 u-mt-1">{String(nextSchedule.metadata?.label ?? nextSchedule.cronExpr)}</div>
            </div>
          ) : (
            <div className="muted u-fs-13">No schedule. <button type="button" className="secondary btn-sm" onClick={() => onGoto('schedules')}>Add one</button></div>
          )}
        </div>
      </div>
    </div>
  );
}

function OverviewTab({ view, onGoto, onCheckNow, busy }: { view: AgentView; onGoto: (t: TabKey) => void; onCheckNow: () => void; busy: boolean }): JSX.Element {
  const { entry, laneCounts, nextSchedule } = view;
  return (
    <>
    <PriorityPanel view={view} onGoto={onGoto} onCheckNow={onCheckNow} busy={busy} />
    <div className="agentws-overview-grid">
      <div className="agentws-overview-card">
        <strong>What {entry.persona} does</strong>
        {entry.description
          ? <Markdown className="u-fs-14">{entry.description}</Markdown>
          : <p className="u-fs-14 u-mb-0">{`${entry.label ?? 'Agent'} — assign a role description in Instructions.`}</p>}
      </div>
      <div className="agentws-overview-card">
        <strong>Workflow portfolio</strong>
        <p className="u-fs-14">{entry.workflows.length === 0 ? 'No workflows yet.' : `${entry.workflows.length} assigned.`}</p>
        <ul className="agentws-portfolio-list">
          {entry.workflows.slice(0, 4).map((w) => <li key={w}>{workflowName(w)}</li>)}
        </ul>
        <button type="button" className="secondary u-fs-12 u-mt-1-5" onClick={() => onGoto('workflows')}>Manage workflows</button>
      </div>
      <div className="agentws-overview-card">
        <strong>Task board</strong>
        <p className="u-fs-14 u-mb-1-5">{laneCounts.todo} To Do · {laneCounts.working} Working · {laneCounts.waiting} Waiting · {laneCounts.done} Done</p>
        <button type="button" className="secondary u-fs-12" onClick={() => onGoto('board')}>Open board</button>
      </div>
      <div className="agentws-overview-card">
        <strong>Schedule</strong>
        <p className="u-fs-14 u-mb-1-5">{nextSchedule ? String(nextSchedule.metadata?.label ?? nextSchedule.cronExpr) : 'No schedule yet.'}</p>
        <button type="button" className="secondary u-fs-12" onClick={() => onGoto('schedules')}>Manage schedules</button>
      </div>
      <div className="agentws-overview-card agentws-card-full">
        <strong>Next steps</strong>
        <ul className="agentws-next-steps-list">
          <li>Add a task to {entry.persona}'s board.</li>
          <li>Assign another workflow from the library.</li>
          <li>Schedule a workflow to run on a timer.</li>
          <li>Connect Discord so teammates can assign {entry.persona} work from chat.</li>
        </ul>
      </div>
    </div>
    </>
  );
}
