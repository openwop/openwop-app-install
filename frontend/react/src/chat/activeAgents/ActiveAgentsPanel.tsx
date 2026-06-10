/**
 * Active-agents side panel (phase D1).
 *
 * Rendered inside `LeftRail` as one of the three tab panels. Lists the
 * agents currently active in this chat — the user @-mentions an agent
 * (`@code-reviewer …`) and that adds it here + switches the
 * conversation through it. Click any row to switch
 * the currently-routing agent without re-typing. Click × to remove
 * an agent from the lineup. The default OpenWOP Assistant is always
 * first and is not removable.
 *
 * The chat dispatcher (phase D2) reads
 * `session.activeAgents.currentAgentId` per turn and passes it into
 * the `sample.chat.turn` workflow's `inputs.agentId`. All active
 * agents see the whole shared history (group-chat model per the
 * 2026-05-28 product decision).
 *
 * Activation flow (phase D3 wires the `@` submit path):
 *   First `@code-reviewer` in a chat:
 *     → adds `code-reviewer` to `activeAgents.lineup`
 *     → sets `activeAgents.currentAgentId` to its id
 *     → the message goes through the agent
 *   Subsequent `@code-reviewer`:
 *     → finds it already in lineup → just switches
 *       `currentAgentId` to it (no duplicate row)
 *   Click another row in this panel:
 *     → switches `currentAgentId` to that agent (no chat message)
 *   Click × on a row:
 *     → removes from lineup
 *     → if it was the current agent, falls back to the assistant
 */

import type { ActiveAgentRow } from './types.js';
import { CircleIcon, XIcon } from '../../ui/icons/index.js';

/** The sentinel id for the default OpenWOP Assistant — kept here so
 *  every consumer of the active-agents state agrees on the value
 *  rather than each hard-coding the string. */
export const DEFAULT_ASSISTANT_ID = '__default_assistant__';
export const DEFAULT_ASSISTANT_ROW: ActiveAgentRow = {
  agentId: DEFAULT_ASSISTANT_ID,
  persona: 'OpenWOP Assistant',
  slug: 'assistant',
  modelClass: 'chat',
  addedAt: '',
};

interface Props {
  /** Including the default assistant as the first row. The hook
   *  `useActiveAgents` synthesises this from
   *  `session.activeAgents.lineup`. */
  lineup: ReadonlyArray<ActiveAgentRow>;
  /** The currently-routing agentId (or `DEFAULT_ASSISTANT_ID` for
   *  the default assistant). */
  currentAgentId: string;
  /** Switch the currently-routing agent. Triggered by clicking a row. */
  onSwitch: (agentId: string) => void;
  /** Remove a non-default agent from the lineup. */
  onRemove: (agentId: string) => void;
  /** Close the panel chevron / Esc. */
  onClose: () => void;
}

export function ActiveAgentsPanel({
  lineup,
  currentAgentId,
  onSwitch,
  onRemove,
  onClose,
}: Props): JSX.Element {
  const headingId = 'active-agents-panel-heading';
  return (
    // The Escape-to-close handler below is intentionally scoped to this panel
    // (see WorkflowProgressPanel for the rationale on not using a global window
    // listener). The <aside> is a focus-scoped container, not an interactive
    // control, so the noninteractive-interactions heuristic is a false positive.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <aside
      className="active-agents-panel u-w-full u-h-full u-bg-surface u-flex u-flex-col"
      tabIndex={-1}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      aria-labelledby={headingId}
    >
      <header className="activeagents-header">
        <strong id={headingId} className="u-flex-1 u-fs-13">
          Active agents
        </strong>
        <button
          type="button"
          className="secondary activeagents-close-btn"
          onClick={onClose}
          aria-label="Close active agents"
        >
          <XIcon size={14} />
        </button>
      </header>

      <ul
        className="u-list-none u-m-0 u-p-1-5 u-flex u-flex-col u-gap-1 u-overflow-y-auto u-flex-1"
        aria-label="Agents in this chat"
      >
        {lineup.map((row) => (
          <ActiveAgentRowView
            key={row.agentId}
            row={row}
            isCurrent={row.agentId === currentAgentId}
            isRemovable={row.agentId !== DEFAULT_ASSISTANT_ID}
            onSwitch={() => onSwitch(row.agentId)}
            onRemove={() => onRemove(row.agentId)}
          />
        ))}
      </ul>

      <div className="activeagents-footer">
        Type <code>@agent-name</code> in chat to add an agent to this
        lineup and switch through it.{' '}
        <span className="activeagents-footer-note">
          Saved on this device only — opening this chat from another browser
          or device starts with the default assistant.
        </span>
      </div>
    </aside>
  );
}

function ActiveAgentRowView({
  row,
  isCurrent,
  isRemovable,
  onSwitch,
  onRemove,
}: {
  row: ActiveAgentRow;
  isCurrent: boolean;
  isRemovable: boolean;
  onSwitch: () => void;
  onRemove: () => void;
}): JSX.Element {
  return (
    <li>
      <div className="u-relative u-flex u-items-center u-gap-2">
        <button
          type="button"
          onClick={onSwitch}
          aria-pressed={isCurrent}
          aria-label={`Switch to ${row.persona}`}
          className="activeagents-switch-btn"
          style={{
            background: isCurrent
              ? 'color-mix(in oklch, var(--color-accent) 14%, transparent)'
              : 'transparent',
            borderLeft: isCurrent
              ? '2px solid var(--clay)'
              : '2px solid transparent',
            fontWeight: isCurrent ? 600 : 400,
          }}
        >
          <span className="u-flex u-items-center u-gap-1-5">
            <span aria-hidden className="u-iflex">{isCurrent ? <CircleIcon size={12} filled /> : <CircleIcon size={12} />}</span>
            <span className="u-flex-1 u-truncate">
              {row.persona}
            </span>
          </span>
          <span className="muted activeagents-row-meta">
            @{row.slug} · {row.modelClass}
          </span>
        </button>
        {isRemovable && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${row.persona} from this chat`}
            title="Remove from this chat"
            className="activeagents-remove-btn"
          >
            <XIcon size={14} />
          </button>
        )}
      </div>
    </li>
  );
}
