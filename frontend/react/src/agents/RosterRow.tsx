import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { workflowName, roleThemeForAgent } from './roleTemplates.js';
import { statusMeta, statusRingColor, relativeTime, type AgentView } from './agentViewModel.js';
import { AgentAvatar } from './AgentAvatar.js';
import { ColumnsIcon, MessageSquareIcon, PlayIcon, AlertIcon, ActivityIcon, WrenchIcon } from '../ui/icons/index.js';
import { AutonomyMeter } from './AutonomyMeter.js';

/**
 * One agent as a roster ROW (agents-workforce redesign PR 1) — replaces the
 * card grid with a dense, scannable list: identity + status, a CONTEXTUAL
 * sub-line, board counts, autonomy, and per-row actions.
 *
 * The sub-line composes from REAL fields only (architect delta — the
 * prototype's progress fractions have no backing data): the working/waiting
 * card title, the next schedule's label, or the status's own explanation.
 */

/** The single most useful next action, given the agent's state. Shared with the
 *  tile view so list + tiles offer the same primary affordance. */
export function primaryAction(view: AgentView, t: TFunction): { label: string; tab?: string; Icon: typeof ColumnsIcon } {
  switch (view.status) {
    case 'waiting': return { label: t('actionReview'), Icon: AlertIcon };
    case 'error': return { label: t('actionViewActivity'), tab: 'activity', Icon: ActivityIcon };
    case 'needs-setup': return { label: t('actionFinishSetup'), tab: 'workflows', Icon: WrenchIcon };
    default: return { label: t('actionOpenBoard'), tab: 'board', Icon: ColumnsIcon };
  }
}

/** A contextual one-liner from REAL fields (working/waiting card, next schedule,
 *  or the status's explanation). Shared with the tile view. */
export function subLine(view: AgentView, t: TFunction): string {
  const { status, cards, nextSchedule, entry } = view;
  if (status === 'working') {
    const card = cards.find((c) => c.columnId === 'working');
    return card ? card.title : t('subWorking');
  }
  if (status === 'waiting') {
    const card = cards.find((c) => c.columnId === 'waiting');
    return card ? card.title : t('subWaiting');
  }
  if (status === 'error') return t('subError');
  if (status === 'needs-setup') return t('subNeedsSetup');
  if (status === 'paused') return t('subPaused');
  if (nextSchedule) {
    const wf = nextSchedule.workflowId ?? entry.workflows[0];
    const label = String(nextSchedule.metadata?.label ?? nextSchedule.cronExpr);
    return t('subNext', { workflow: wf ? workflowName(wf) : t('subWorkflowFallback'), label });
  }
  return t('subNoSchedule');
}

export function RosterRow({ view, busy, onOpen, onCheckNow, onChat }: {
  view: AgentView;
  busy?: boolean;
  onOpen: (tab?: string) => void;
  onCheckNow: () => void;
  onChat: () => void;
}): JSX.Element {
  const { t } = useTranslation('agents');
  const { entry, laneCounts, status } = view;
  const sm = statusMeta(status);
  const theme = roleThemeForAgent(entry.agentRef?.agentId, entry.workflows, entry.roleKey);
  const action = primaryAction(view, t);
  const ActionIcon = action.Icon;
  const checked = entry.lastHeartbeatAt ? relativeTime(entry.lastHeartbeatAt) : null;

  return (
    <div className="roster-row">
      <button type="button" className="roster-id" onClick={() => onOpen()} title={t('openWorkspaceTitle', { persona: entry.persona })}>
        <AgentAvatar persona={entry.persona} avatarUrl={entry.avatarUrl} roleTheme={theme} size={40} showBadge={false} ring={statusRingColor(status)} />
        <span className="roster-name-wrap">
          <span className="roster-name-line">
            <span className="roster-name">{entry.persona}</span>
            <span className={`chip ${sm.chip}`} title={sm.help}><span className="chip-dot" aria-hidden />{sm.label}</span>
          </span>
          <span className="roster-role">{entry.label ?? t('agent')}</span>
        </span>
      </button>

      <div className="roster-sub">
        <div className="roster-subline">{subLine(view, t)}</div>
        <div className="roster-counts">
          <span>{t('workflowCount', { count: entry.workflows.length })}</span>
          {laneCounts.todo > 0 ? <span>{t('toDoCount', { count: laneCounts.todo })}</span> : null}
          {laneCounts.waiting > 0 ? <span className="roster-count-waiting">{t('waitingCount', { count: laneCounts.waiting })}</span> : null}
          {checked ? <span>{t('checkedAgo', { when: checked })}</span> : null}
        </div>
      </div>

      <span className="roster-autonomy">
        <AutonomyMeter autonomyLevel={entry.autonomyLevel} />
      </span>

      <div className="roster-actions action-bar">
        <button type="button" className="secondary btn-sm" title={t('checkNowTitle')} aria-label={t('checkAgentNow', { persona: entry.persona })} disabled={busy || !entry.enabled} onClick={onCheckNow}>
          <PlayIcon size={14} aria-hidden />
        </button>
        <button type="button" className="secondary btn-sm" title={t('chatWithPersona', { persona: entry.persona })} aria-label={t('chatWithPersona', { persona: entry.persona })} onClick={onChat}>
          <MessageSquareIcon size={14} aria-hidden />
        </button>
        <button type="button" className={status === 'waiting' ? 'btn-accent btn-sm' : 'secondary btn-sm'} onClick={() => onOpen(action.tab)}>
          <ActionIcon size={14} aria-hidden /> {action.label}
        </button>
      </div>
    </div>
  );
}
