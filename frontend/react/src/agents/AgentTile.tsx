import { roleThemeForAgent } from './roleTemplates.js';
import { statusMeta, statusRingColor, relativeTime, type AgentView } from './agentViewModel.js';
import { AgentAvatar } from './AgentAvatar.js';
import { AutonomyMeter } from './AutonomyMeter.js';
import { primaryAction, subLine } from './RosterRow.js';
import { MessageSquareIcon, PlayIcon } from '../ui/icons/index.js';

/**
 * One agent as a profile TILE (IA refresh 2026-06) — the default agents-page
 * view. A card the workforce reads as a roster of people: avatar + status ring,
 * role, a contextual sub-line, autonomy, board counts, and the SAME primary
 * action as the dense list row (shared `primaryAction`/`subLine` helpers, so
 * tiles and the list toggle never diverge). The compact list (RosterRow) is the
 * toggle for a large fleet.
 *
 * Composes entirely from existing primitives (`.surface-card` in a `.card-grid`,
 * `.roster-id`/`.roster-name`/`.roster-counts`, `.action-bar`, `u-*` utilities)
 * — no new CSS, so the token/spacing-literal gates stay green.
 */
export function AgentTile({ view, busy, onOpen, onCheckNow, onChat }: {
  view: AgentView;
  busy?: boolean;
  onOpen: (tab?: string) => void;
  onCheckNow: () => void;
  onChat: () => void;
}): JSX.Element {
  const { entry, laneCounts, status } = view;
  const sm = statusMeta(status);
  const theme = roleThemeForAgent(entry.agentRef?.agentId, entry.workflows, entry.roleKey);
  const action = primaryAction(view);
  const ActionIcon = action.Icon;
  const checked = entry.lastHeartbeatAt ? relativeTime(entry.lastHeartbeatAt) : null;

  return (
    <article className="surface-card u-grid u-gap-2">
      <button type="button" className="roster-id" onClick={() => onOpen()} title={`Open ${entry.persona}'s workspace`}>
        <AgentAvatar persona={entry.persona} avatarUrl={entry.avatarUrl} roleTheme={theme} size={44} showBadge={false} ring={statusRingColor(status)} />
        <span className="roster-name-wrap">
          <span className="roster-name-line">
            <span className="roster-name">{entry.persona}</span>
            <span className={`chip ${sm.chip}`} title={sm.help}><span className="chip-dot" aria-hidden />{sm.label}</span>
          </span>
          <span className="roster-role">{entry.label ?? 'Agent'}</span>
        </span>
      </button>

      <p className="muted u-m-0 u-fs-13">{subLine(view)}</p>

      <div className="u-flex u-items-center u-justify-between u-wrap u-gap-2">
        <AutonomyMeter autonomyLevel={entry.autonomyLevel} />
        <span className="roster-counts">
          <span>{entry.workflows.length} workflow{entry.workflows.length === 1 ? '' : 's'}</span>
          {laneCounts.todo > 0 ? <span>{laneCounts.todo} to do</span> : null}
          {laneCounts.waiting > 0 ? <span className="roster-count-waiting">{laneCounts.waiting} waiting</span> : null}
          {checked ? <span>checked {checked}</span> : null}
        </span>
      </div>

      <div className="action-bar u-justify-end">
        <button type="button" className="secondary btn-sm" title="Run the heartbeat now" aria-label={`Check ${entry.persona} now`} disabled={busy || !entry.enabled} onClick={onCheckNow}>
          <PlayIcon size={14} aria-hidden />
        </button>
        <button type="button" className="secondary btn-sm" title={`Chat with ${entry.persona}`} aria-label={`Chat with ${entry.persona}`} onClick={onChat}>
          <MessageSquareIcon size={14} aria-hidden />
        </button>
        <button type="button" className={status === 'waiting' ? 'btn-accent btn-sm' : 'secondary btn-sm'} onClick={() => onOpen(action.tab)}>
          <ActionIcon size={14} aria-hidden /> {action.label}
        </button>
      </div>
    </article>
  );
}
