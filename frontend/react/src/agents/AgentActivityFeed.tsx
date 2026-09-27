/**
 * Fleet activity feed (PRD §8.5) — a compact, human-readable summary of what
 * the agents are doing right now. Derived from current board state (cards with
 * a started run, cards waiting on a human) rather than a dedicated event log —
 * an MVP that reads honestly from the live data.
 */

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { workflowName, roleThemeForAgent, type RoleTheme } from './roleTemplates.js';
import type { AgentView } from './agentViewModel.js';
import { AgentAvatar } from './AgentAvatar.js';

interface ActivityItem {
  key: string;
  /** The agent this item is about — drives the avatar + accessible name. */
  persona: string;
  avatarUrl?: string | undefined;
  roleTheme: RoleTheme;
  text: string;
  runId?: string | undefined;
}

function deriveActivity(views: AgentView[], t: TFunction<'agents'>): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const view of views) {
    const persona = view.entry.persona;
    const roleTheme = roleThemeForAgent(view.entry.agentRef?.agentId, view.entry.workflows, view.entry.roleKey);
    const who = { persona, avatarUrl: view.entry.avatarUrl, roleTheme };
    // In-progress + waiting work (with run links where present).
    for (const card of view.cards) {
      const lane = view.board?.columns.find((c) => c.id === card.columnId);
      const laneName = (lane?.name ?? '').toLowerCase();
      if (card.lastRunId && (laneName === 'working' || laneName === 'doing')) {
        items.push({ ...who, key: `${card.id}-run`, text: t('feedPickedUp', { persona, title: card.title }), runId: card.lastRunId });
      } else if (laneName.startsWith('waiting')) {
        items.push({ ...who, key: `${card.id}-wait`, text: t('feedWaiting', { persona, title: card.title }) });
      }
    }
    // New work queued in To Do.
    if (view.laneCounts.todo > 0) {
      items.push({ ...who, key: `${view.entry.rosterId}-todo`, text: t('feedNewTasks', { persona, count: view.laneCounts.todo }) });
    }
    // Scheduled runs.
    for (const job of view.jobs.filter((j) => j.enabled !== false).slice(0, 2)) {
      const label = String(job.metadata?.label ?? (job.workflowId ? workflowName(job.workflowId) : t('feedWorkflowFallback')));
      items.push({ ...who, key: `${job.jobId}-sched`, text: t('feedScheduled', { persona, label }) });
    }
  }
  return items.slice(0, 10);
}

export function AgentActivityFeed({ views }: { views: AgentView[] }): JSX.Element {
  const { t } = useTranslation('agents');
  const items = deriveActivity(views, t);
  if (items.length === 0) {
    return (
      <p className="muted u-fs-14">
        {t('feedEmpty')}
      </p>
    );
  }
  return (
    <ul className="agentactfeed-list">
      {items.map((item) => (
        <li key={item.key} className="u-fs-14 u-flex u-gap-2 u-items-center">
          <AgentAvatar
            persona={item.persona}
            avatarUrl={item.avatarUrl}
            roleTheme={item.roleTheme}
            size={22}
            showBadge={false}
            alt={t('feedPersonaPhoto', { persona: item.persona })}
          />
          <span>
            {item.text}
            {item.runId ? <> · <Link to={`/runs/${item.runId}`}>{t('viewRun')}</Link></> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
