/**
 * ConversationLineup — the "in this conversation" zone (ADR 0140 G2): the live
 * active-agents lineup (default assistant + activated advisors) with switch-voice +
 * drop-agent controls and the per-advisor thinking pulse. Extracted verbatim from
 * `ConversationsRail` zone 1 so BOTH the single-session sidebar AND each multi-tab
 * `TabSession` can render it from their OWN `useChatSession().activeAgents` — the
 * lineup is a single-session concept, so it stays per-surface (never lifted to the
 * deck). Presentational: the parent wires the callbacks.
 */

import { useTranslation } from 'react-i18next';
import { AgentAvatar } from '../../agents/AgentAvatar.js';
import { roleThemeForAgent } from '../../agents/roleTemplates.js';
import { slugToName } from '../lib/agentMentions.js';
import { XIcon } from '../../ui/icons/index.js';
import { DEFAULT_ASSISTANT_ID } from '../activeAgents/constants.js';
import type { ActiveAgentRow } from '../activeAgents/types.js';

export function ConversationLineup({
  lineup, currentAgentId, thinkingAgentId, onSwitchAgent, onRemoveAgent, variant = 'rail',
}: {
  lineup: ReadonlyArray<ActiveAgentRow>;
  currentAgentId: string;
  thinkingAgentId: string | null;
  onSwitchAgent: (agentId: string) => void;
  onRemoveAgent: (agentId: string) => void;
  /** `rail` = the vertical list in the sidebar's left rail (default). `strip` = a
   *  compact horizontal chip bar above a multi-tab conversation feed (ADR 0140 G2 ux):
   *  full-width vertical rows + the mention tip read as a misplaced rail fragment, so
   *  the tab gets a wrapped participant bar with no footer. */
  variant?: 'rail' | 'strip';
}): JSX.Element {
  const { t } = useTranslation('chat');
  const strip = variant === 'strip';
  return (
    <section aria-label={t('inThisConversation')} className={strip ? 'convlineup-strip u-border-b' : 'u-border-b'}>
      {!strip && <h3 className="muted sesshist-group-head">{t('inThisConversation')}</h3>}
      <ul className={strip ? 'convlineup-strip__list' : 'u-list-none u-m-0 u-p-1-5 u-flex u-flex-col u-gap-1'}>
        {lineup.map((row) => (
          <ParticipantRow
            key={row.agentId}
            row={row}
            compact={strip}
            isCurrent={row.agentId === currentAgentId}
            isThinking={row.agentId === thinkingAgentId}
            isRemovable={row.agentId !== DEFAULT_ASSISTANT_ID}
            onSwitch={() => onSwitchAgent(row.agentId)}
            onRemove={() => onRemoveAgent(row.agentId)}
          />
        ))}
      </ul>
      {!strip && (
        <p className="activeagents-footer-note u-p-2 u-m-0">
          {t('conversationMentionTipPrefix')}<code>@agent-name</code>{t('conversationMentionTipMid')}<code>@@board</code>{t('conversationMentionTipSuffix')}
        </p>
      )}
    </section>
  );
}

function ParticipantRow({
  row,
  isCurrent,
  isThinking,
  isRemovable,
  onSwitch,
  onRemove,
  compact = false,
}: {
  row: ActiveAgentRow;
  isCurrent: boolean;
  isThinking: boolean;
  isRemovable: boolean;
  onSwitch: () => void;
  onRemove: () => void;
  compact?: boolean;
}): JSX.Element {
  const { t } = useTranslation('chat');
  // The human name is the identity hero; the stored `persona` is the role
  // tagline (e.g. "Focus, cost mastery & team leverage"), shown muted beneath.
  // While the advisor is generating, the tagline yields to a live "thinking…".
  const name = slugToName(row.slug);
  const roleTheme = roleThemeForAgent(row.agentId, []);
  if (compact) {
    // Strip variant: a pill (avatar + name, live ring/dots while thinking, hover ×).
    return (
      <li>
        <span className={`convlineup-chip${isCurrent ? ' is-current' : ''}${isThinking ? ' is-thinking' : ''}`}>
          <button
            type="button"
            onClick={onSwitch}
            aria-pressed={isCurrent}
            aria-label={t('switchToPersona', { persona: name })}
            className="convlineup-chip__switch"
          >
            <AgentAvatar persona={name} roleTheme={roleTheme} size={20} showBadge={false} alt="" {...((isThinking || isCurrent) ? { ring: 'var(--clay)' } : {})} />
            <span className="convlineup-chip__name u-truncate">{name}</span>
            {isThinking && (
              <span className="think-dots u-gap-0-5" aria-live="polite" aria-label={t('thinkingLabel')}>
                <span className="think-dot" /><span className="think-dot" /><span className="think-dot" />
              </span>
            )}
          </button>
          {isRemovable && (
            <button
              type="button"
              onClick={onRemove}
              aria-label={t('removeFromConversation', { persona: name })}
              title={t('removeFromConversationTitle')}
              className="convlineup-chip__remove"
            >
              <XIcon size={12} />
            </button>
          )}
        </span>
      </li>
    );
  }
  return (
    <li>
      <div className={`convrail-participant${isCurrent ? ' is-current' : ''}${isThinking ? ' is-thinking' : ''}`}>
        <button
          type="button"
          onClick={onSwitch}
          aria-pressed={isCurrent}
          aria-label={t('switchToPersona', { persona: name })}
          className="convrail-participant-switch"
        >
          <AgentAvatar persona={name} roleTheme={roleTheme} size={28} showBadge={false} alt="" {...((isThinking || isCurrent) ? { ring: 'var(--clay)' } : {})} />
          <span className="convrail-participant-text">
            <span className="convrail-participant-name u-truncate">{name}</span>
            {isThinking
              ? <span className="convrail-participant-thinking" aria-live="polite">{t('thinkingLabel')}<span className="think-dots u-gap-0-5" aria-hidden><span className="think-dot" /><span className="think-dot" /><span className="think-dot" /></span></span>
              : <span className="convrail-participant-tagline u-truncate">{row.persona}</span>}
          </span>
        </button>
        {isRemovable && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={t('removeFromConversation', { persona: name })}
            title={t('removeFromConversationTitle')}
            className="convrail-participant-remove"
          >
            <XIcon size={14} />
          </button>
        )}
      </div>
    </li>
  );
}
