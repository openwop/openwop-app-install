/**
 * EmbeddedChatPanel — the reusable "drop an AI chat into a feature surface" seam
 * (ADR 0073). This is the core every feature extends: it owns the BYOK-provisioning
 * gate, scopes the conversation to a given agent (its system prompt drives the turn),
 * and renders the slimmed <EmbeddedConversation> with a feature-supplied empty state.
 * A feature supplies its own agent + empty state (the overrides); the gate, scoping,
 * and ephemeral session come from here (the core) — so no feature re-implements chat.
 *
 * Override seams:
 *   - `agentId`          — REQUIRED; which agent to scope to (its persona/system prompt).
 *   - `renderEmptyState` — the feature's context-aware empty state (defaults to none →
 *                          EmbeddedConversation falls back to the chat-page WelcomeCard).
 *   - `onManageProvider` — where "connect a provider" sends the user (default: the chat
 *                          route `/`, which owns BYOK setup).
 *   - `byokFallback`     — escape hatch to replace the default gate UI wholesale.
 *   - `onTurnSettled`    — a tick each time a turn finishes, so the consumer can
 *                          re-read its OWN state (ADR 0596). It carries no turn
 *                          content: `agent.toolReturned` (RFC 0064) has no result
 *                          payload on the wire, so a tool's return value cannot be
 *                          relayed to the client without an RFC change.
 * Chrome (heading / close / drawer) stays at the CALL SITE — this renders gate-or-chat only.
 *
 * IMPORT DIRECTION (read before importing): `chat/` already imports `builder/`
 * (e.g. WelcomeCard, useChatSession, workflowMentions). A feature that `chat/` does
 * NOT import back may static-import this component. The **builder** is the exception:
 * it must **lazy-import** this (a static builder→chat import would close a cycle).
 *
 * @see docs/adr/0073-embeddable-conversation-view.md
 */

import { Button } from '../ui/Button.js';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { useBYOKConfig } from '../byok/lib/useBYOKConfig.js';
import { StateCard } from '../ui/StateCard.js';
import { KeyIcon } from '../ui/icons/index.js';
import { EmbeddedConversation } from './EmbeddedConversation.js';

export function EmbeddedChatPanel({
  agentId,
  renderEmptyState,
  tenantId,
  onManageProvider,
  byokFallback,
  onTurnSettled,
}: {
  agentId: string;
  renderEmptyState?: (onPick: (text: string) => void) => ReactNode;
  tenantId?: string;
  /** ADR 0596 — fired once per finished turn; a "re-read your own state" tick. */
  onTurnSettled?: () => void;
  /** Where "connect a provider" routes the user. Defaults to the chat route `/`. */
  onManageProvider?: () => void;
  /** Replace the default BYOK gate UI entirely (rare). */
  byokFallback?: ReactNode;
}): JSX.Element {
  const { t } = useTranslation('chat');
  const navigate = useNavigate();
  const { config, isValid, status } = useBYOKConfig();
  const manageProvider = onManageProvider ?? ((): void => { void navigate('/'); });

  // ADR 0517 — while the binding is still resolving we know NOTHING, so claiming
  // "connect an AI provider" is a false statement shown to a user who has one.
  // Hold the space quietly instead; the real state lands a round-trip later.
  if (status === 'loading') return <div className="embed-byok-gate" aria-busy="true" />;

  if (!config || !isValid) {
    if (byokFallback !== undefined) return <>{byokFallback}</>;
    // The chat surface (route `/`) owns BYOK setup; send the user there.
    // A DESIGNED gate state (grade-pass ST-2): consumers give the panel a tall
    // flex column (`.studio-author-panel`, `.commerce-assistant-panel`), so a
    // bare one-line Notice left a screenful of void — the centered StateCard
    // fills the state intentionally. Same two chat-ns keys, no new copy.
    return (
      <div className="embed-byok-gate">
        <StateCard
          icon={<KeyIcon aria-hidden />}
          title={t('embedNeedsProvider')}
          action={<Button variant="primary" onClick={manageProvider}>{t('embedManageProvider')}</Button>}
        />
      </div>
    );
  }

  return (
    <EmbeddedConversation
      agentId={agentId}
      config={config}
      onReconfigureBYOK={manageProvider}
      {...(tenantId !== undefined ? { tenantId } : {})}
      {...(renderEmptyState ? { renderEmptyState } : {})}
      {...(onTurnSettled ? { onTurnSettled } : {})}
    />
  );
}
