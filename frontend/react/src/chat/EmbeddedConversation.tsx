/**
 * EmbeddedConversation — the one AI chat, embedded slimmed into another surface
 * (ADR 0073 Phase 3). Owns its OWN ephemeral session (`useChatSession({ persist:
 * false })` — task-scoped, never touches the user's main chat session/index),
 * scopes it to a given agent, and renders the slimmed <ConversationView> (no
 * header, no rails, no progress panel). The first consumer is the workflow
 * builder's "Create with AI", scoped to the Workflow Architect.
 *
 * Reuses the full chat machinery (turns/streaming/interrupts/BYOK/workflow
 * dispatch) — NOT a second chat. Its submit path is the CORE subset (command →
 * /workflow → @agent → send); it deliberately omits the full surface's project
 * convene / board `@@` cadence (those are chrome concerns, ADR 0073 §Phase 3).
 *
 * @see docs/adr/0073-embeddable-conversation-view.md
 */

import { useCallback, type ReactNode } from 'react';
import { useChatSession, type ContentPart } from './hooks/useChatSession.js';
import { useAgentMentions } from './lib/agentMentions.js';
import { useScopeToAgent } from './activeAgents/useScopeToAgent.js';
import { ConversationView } from './ConversationView.js';
import { runCoreSubmit } from './lib/chatSubmit.js';
import { registerDefaultCommands } from './registry/defaultCommands.js';
import { getProvider } from '../byok/lib/providers.js';
import type { BYOKActiveConfig } from '../byok/lib/useBYOKConfig.js';

registerDefaultCommands();

export function EmbeddedConversation({ agentId, config, tenantId = 'demo', onReconfigureBYOK, renderEmptyState }: {
  /** Agent to scope this conversation to (e.g. the Workflow Architect). */
  agentId: string;
  /** A valid BYOK config — the host surface gates on it before rendering this. */
  config: BYOKActiveConfig;
  tenantId?: string;
  onReconfigureBYOK: () => void;
  /** Context-aware empty state (e.g. a workflow-authoring welcome). Receives the
   *  composer-seed callback so example prompts dispatch a real turn. */
  renderEmptyState?: (onPick: (text: string) => void) => ReactNode;
}): JSX.Element {
  const {
    session, isSending, error, send, cancel, reset, resolveInterrupt, runWorkflowMention,
    regenerate, setFeedback, hasOlderMessages, isLoadingEarlier, loadEarlierMessages, activeAgents,
  } = useChatSession({ persist: false });
  const { entries: agentEntries } = useAgentMentions();
  useScopeToAgent(activeAgents, agentEntries, agentId);

  const onRegenerate = useCallback((id: string) => { void regenerate(id, config); }, [regenerate, config]);

  // Per-model capability hints (mirror ChatSidebar) so the composer flags
  // unsupported attachments honestly.
  const activeModel = (() => {
    try { return getProvider(config.provider).models.find((m) => m.id === config.model) ?? null; } catch { return null; }
  })();
  const supportsAudioInput = activeModel?.audioInput === true;
  const supportsImageInput = activeModel?.capabilities?.includes('vision') === true;
  const supportsPdfInput = supportsImageInput && (config.provider === 'anthropic' || config.provider === 'google');

  // CORE submit subset (shared, ADR 0140 G1): command → /workflow → @agent → send. No
  // convene/board (those are the full surface's interceptors); the embed has no
  // system-message surface, so emitSystem is a no-op.
  const onUserSubmit = useCallback(async (text: string, attachments?: readonly ContentPart[]) => {
    await runCoreSubmit(text, attachments, {
      config, send, reset, cancel, runWorkflowMention, activeAgents, agentEntries,
      emitSystem: () => { /* embed has no system-message surface */ },
    });
  }, [send, cancel, reset, config, runWorkflowMention, agentEntries, activeAgents]);

  return (
    <div className="u-flex u-flex-col u-flex-1 u-minh-0">
      <ConversationView
        messages={session.messages}
        tenantId={tenantId}
        voiceAgentId={agentId}
        error={error}
        isSending={isSending}
        onPickSuggestion={(t) => onUserSubmit(t)}
        {...(renderEmptyState ? { renderEmptyState } : {})}
        onSend={onUserSubmit}
        onCancel={cancel}
        supportsAudioInput={supportsAudioInput}
        supportsImageInput={supportsImageInput}
        supportsPdfInput={supportsPdfInput}
        onResolveInterrupt={resolveInterrupt}
        onRegenerate={onRegenerate}
        onFeedback={setFeedback}
        onReconfigureBYOK={onReconfigureBYOK}
        hasOlderMessages={hasOlderMessages}
        isLoadingEarlier={isLoadingEarlier}
        onLoadEarlier={loadEarlierMessages}
      />
    </div>
  );
}
