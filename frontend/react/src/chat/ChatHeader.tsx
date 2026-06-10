/**
 * Chat header: model pill, web-search toggle, session-total cost chip,
 * new-chat button.
 */

import { ConfiguredProviderCard } from '../byok/ConfiguredProviderCard.js';
import type { BYOKActiveConfig } from '../byok/lib/useBYOKConfig.js';
import type { ChatSession } from './hooks/useChatSession.js';
import { formatUsd, sessionCostUsd } from './lib/cost.js';
import { GlobeIcon, MenuIcon, WrenchIcon } from '../ui/icons/index.js';

interface Props {
  config: BYOKActiveConfig;
  onOpenSettings: () => void;
  onRemoveKey: () => void | Promise<void>;
  onNewChat: () => void;
  session: ChatSession;
  /** When non-null, render a globe-icon web-search toggle button. */
  onToggleWebSearch: (() => void) | null;
  webSearchEnabled: boolean;
  /** When non-null, render a tools toggle button. Anthropic only for v1. */
  onToggleTools: (() => void) | null;
  toolsEnabled: boolean;
  /** Toggle the left rail (which hosts History / Progress / Agents
   *  tabs). The single button replaces the three per-panel toggles
   *  the header used to render. */
  onToggleRail?: () => void;
  railOpen?: boolean;
  /** Sum of workflow_runs + activated agents — surfaced as a badge on
   *  the rail toggle so the user sees pending work without opening
   *  the rail. */
  railBadgeCount?: number;
}

export function ChatHeader({
  config,
  onOpenSettings,
  onRemoveKey,
  onNewChat,
  session,
  onToggleWebSearch,
  webSearchEnabled,
  onToggleTools,
  toolsEnabled,
  onToggleRail,
  railOpen,
  railBadgeCount = 0,
}: Props): JSX.Element {
  const totalCost = sessionCostUsd(session);
  const messageCount = session.messages.length;
  return (
    <div className="u-flex u-items-center u-justify-between u-pad-2-4 u-border-b u-gap-2">
      <div className="u-flex u-items-center u-gap-1-5 u-minw-0">
        {onToggleRail && (
          <button
            type="button"
            onClick={onToggleRail}
            aria-label={railOpen ? 'Close chat tools' : 'Open chat tools'}
            aria-pressed={railOpen}
            title="History, workflow progress, and active agents"
            className="secondary chathdr-rail-btn"
          >
            <MenuIcon size={14} />
            {railBadgeCount > 0 && (
              <span className="chathdr-badge">{railBadgeCount}</span>
            )}
          </button>
        )}
        <ConfiguredProviderCard config={config} onChange={onOpenSettings} onRemoved={onRemoveKey} compact />
      </div>
      <div className="u-flex u-items-center u-gap-1-5">
        {onToggleWebSearch && (
          <button
            type="button"
            onClick={onToggleWebSearch}
            title={webSearchEnabled ? 'Web search ON — next turn uses provider-native search' : 'Web search off (click to enable)'}
            aria-pressed={webSearchEnabled}
            aria-label="Toggle web search"
            className="chathdr-toggle"
            style={{
              background: webSearchEnabled ? 'var(--color-accent)' : 'var(--color-surface-2)',
              color: webSearchEnabled ? 'white' : 'var(--color-text)',
            }}
          >
            <GlobeIcon size={12} /> web{webSearchEnabled ? ' on' : ''}
          </button>
        )}
        {onToggleTools && (
          <button
            type="button"
            onClick={onToggleTools}
            title={toolsEnabled
              ? 'Tools ON — the AI can call saved workflows as tools this turn'
              : 'Tools off (click to enable). Lets the AI invoke saved workflows.'}
            aria-pressed={toolsEnabled}
            aria-label="Toggle workflow tools"
            className="chathdr-toggle"
            style={{
              background: toolsEnabled ? 'var(--color-accent)' : 'var(--color-surface-2)',
              color: toolsEnabled ? 'white' : 'var(--color-text)',
            }}
          >
            <WrenchIcon size={12} /> tools{toolsEnabled ? ' on' : ''}
          </button>
        )}
        {totalCost > 0 && (
          <span
            className="status-badge u-fs-11"
            title={`Total session cost: ${formatUsd(totalCost)}`}
          >
            Σ {formatUsd(totalCost)}
          </span>
        )}
        {messageCount > 0 && (
          <button type="button" className="secondary u-fs-11" onClick={onNewChat} aria-label="New chat">
            New chat
          </button>
        )}
      </div>
    </div>
  );
}
