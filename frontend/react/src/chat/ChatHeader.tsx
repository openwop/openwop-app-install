/**
 * Chat header: a quiet context+action bar.
 *
 * Left — identity/context: the rail toggle + a unified model segment (BYOK
 * provider card + the per-exchange ModelSwitcher grouped as one zone).
 * Right — conversation actions: a session-cost chip, the self-gating
 * capability/task-deck buttons, the primary New chat, and a "⋯ More" overflow
 * that collapses the low-frequency Branch / Compare / Export / Import actions.
 *
 * The message-modifiers (web search, workflow tools) live at the COMPOSER now
 * (they change the next message), not here — see ChatInput's leadingControls.
 */

import { useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfiguredProviderCard } from '../byok/ConfiguredProviderCard.js';
import type { BYOKActiveConfig } from '../byok/lib/useBYOKConfig.js';
import type { ChatSession } from './hooks/useChatSession.js';
import { messageText } from './types.js';
import { formatUsd, sessionCostUsd } from './lib/cost.js';
import { MenuIcon, MoreHorizontalIcon, SettingsIcon } from '../ui/icons/index.js';
import { Menu, type MenuEntry } from '../ui/Menu.js';
import { IntentLedgerButton } from '../intentLedger/IntentLedgerPanel.js';
import { TaskDeckButton } from '../taskDeck/TaskDeckPanel.js';

interface Props {
  config: BYOKActiveConfig;
  onOpenSettings: () => void;
  onRemoveKey: () => void | Promise<void>;
  onNewChat: () => void;
  /** ADR 0117 — branch the conversation (fork to continue separately). When
   *  omitted (feature off), no Branch item renders. */
  onBranch?: () => void;
  /** ADR 0117 Phase 3 — open the read-only side-by-side compare view. */
  onCompare?: () => void;
  /** ADR 0119 Phase 5 — download the conversation transcript in the chosen format
   *  ('md' | 'json'). When omitted (the chat-export feature is off), no Export item renders. */
  onExport?: (format: 'md' | 'json') => void;
  /** ADR 0119 — import a conversation from a supported export file (openwop/OpenAI).
   *  When omitted (feature off), no Import item renders. */
  onImport?: (file: File) => void;
  /** ADR 0122 — mint a public read-only share link for this conversation and copy
   *  it. When omitted (sharing off), no Share item renders. Owner-only (enforced
   *  server-side on mint). */
  onShare?: () => void;
  session: ChatSession;
  /** ADR 0124 — an optional in-chat model-switch control rendered inside the
   *  model segment; the ModelSwitcher renders nothing when no models are advertised. */
  modelSwitcher?: ReactNode;
  /** Toggle the left rail (which hosts History / Progress / Agents
   *  tabs). The single button replaces the three per-panel toggles
   *  the header used to render. */
  onToggleRail?: () => void;
  railOpen?: boolean;
  /** Sum of workflow_runs + activated agents — surfaced as a badge on
   *  the rail toggle so the user sees pending work without opening
   *  the rail. */
  railBadgeCount?: number;
  /** ADR 0154 Phase 2 — open the channel-settings dialog. Set only when the
   *  active conversation is a channel; renders a settings control in the header. */
  onOpenChannelDetails?: () => void;
}

export function ChatHeader({
  config,
  onOpenSettings,
  onRemoveKey,
  onNewChat,
  onBranch,
  onCompare,
  onExport,
  onImport,
  onShare,
  session,
  modelSwitcher,
  onToggleRail,
  railOpen,
  railBadgeCount = 0,
  onOpenChannelDetails,
}: Props): JSX.Element {
  const { t } = useTranslation('chat');
  const totalCost = sessionCostUsd(session);
  const messageCount = session.messages.length;
  const hasTurns = messageCount > 0;
  // ADR 0136 — the most recent user message seeds the intent-ledger "draft from
  // conversation" extractor (the server applies the complexity guard).
  const lastUserMessage = [...session.messages].reverse().find((m) => m.role === 'user');
  const lastUserText = lastUserMessage ? messageText(lastUserMessage) : '';

  // "⋯ More" overflow — collapses the low-frequency conversation actions into
  // the shared accessible Menu primitive (DS-8: roving focus + focus return).
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const moreItems: MenuEntry[] = [
    ...(hasTurns && onBranch ? [{ id: 'branch', label: t('branch'), title: t('branchConversationTitle'), onSelect: onBranch }] : []),
    ...(hasTurns && onCompare ? [{ id: 'compare', label: t('compare'), title: t('compareTitle'), onSelect: onCompare }] : []),
    ...(hasTurns && onExport ? [
      { id: 'export', label: t('export'), title: t('exportConversationTitle'), onSelect: () => onExport('md') },
      { id: 'export-json', label: t('exportAsJson'), onSelect: () => onExport('json') },
    ] : []),
    ...(hasTurns && onShare ? [{ id: 'share', label: t('share', { defaultValue: 'Share link' }), title: t('shareConversationTitle', { defaultValue: 'Create a public read-only link to this conversation' }), onSelect: onShare }] : []),
    ...(onImport ? [{ id: 'import', label: t('import'), title: t('importConversationTitle'), onSelect: () => importInputRef.current?.click() }] : []),
  ];

  return (
    <div className="chathdr">
      <div className="chathdr-context">
        {onToggleRail && (
          <button
            type="button"
            onClick={onToggleRail}
            aria-label={railOpen ? t('closeChatTools') : t('openChatTools')}
            aria-pressed={railOpen}
            title={t('chatToolsTitle')}
            className="secondary chathdr-rail-btn"
          >
            <MenuIcon size={14} />
            {railBadgeCount > 0 && (
              <span className="chathdr-badge">{railBadgeCount}</span>
            )}
          </button>
        )}
        {/* Unified model zone — the BYOK provider identity + the per-exchange
            switcher read as ONE control rather than two competing affordances. */}
        <span className="chathdr-model">
          <ConfiguredProviderCard config={config} onChange={onOpenSettings} onRemoved={onRemoveKey} compact />
          {modelSwitcher}
        </span>
      </div>

      <div className="chathdr-actions">
        {totalCost > 0 && (
          <span
            className="status-badge u-fs-11"
            title={t('totalSessionCost', { cost: formatUsd(totalCost) })}
          >
            {t('sessionCostLabel', { cost: formatUsd(totalCost) })}
          </span>
        )}
        {/* ADR 0132 — per-conversation tool scope + approvals now lives at the
            COMPOSER (next to the web/tools modifiers — see ChatSidebar). */}
        {/* ADR 0136 — the intent ledger / mission contract (self-gates on the
            intent-ledger feature; renders nothing when off). */}
        <IntentLedgerButton sessionId={session.id} {...(lastUserText ? { lastUserMessage: lastUserText } : {})} />
        {/* ADR 0133 — the run/task deck (self-gates on the task-deck feature). */}
        <TaskDeckButton />
        {/* ADR 0154 Phase 2 — channel settings (rename · archive · members),
            only for a channel conversation. */}
        {onOpenChannelDetails && (
          <button type="button" className="secondary chathdr-more-btn" onClick={onOpenChannelDetails} aria-label={t('channelSettingsAria')} title={t('channelSettingsAria')}>
            <SettingsIcon size={15} />
          </button>
        )}
        {hasTurns && (
          <button type="button" className="secondary u-fs-11" onClick={onNewChat} aria-label={t('newChat')}>
            {t('newChat')}
          </button>
        )}
        {moreItems.length > 0 && (
          <Menu
            label={t('moreActions')}
            triggerClassName="secondary chathdr-more-btn"
            triggerContent={<MoreHorizontalIcon size={15} />}
            items={moreItems}
          />
        )}
        {onImport && (
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            className="u-hidden"
            aria-label={t('importConversation')}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onImport(f); e.target.value = ''; }}
          />
        )}
      </div>
    </div>
  );
}
