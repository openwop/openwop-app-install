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
 * Chrome (heading / close / drawer) stays at the CALL SITE — this renders gate-or-chat only.
 *
 * IMPORT DIRECTION (read before importing): `chat/` already imports `builder/`
 * (e.g. WelcomeCard, useChatSession, workflowMentions). A feature that `chat/` does
 * NOT import back may static-import this component. The **builder** is the exception:
 * it must **lazy-import** this (a static builder→chat import would close a cycle).
 *
 * @see docs/adr/0073-embeddable-conversation-view.md
 */

import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { useBYOKConfig } from '../byok/lib/useBYOKConfig.js';
import { Notice } from '../ui/Notice.js';
import { EmbeddedConversation } from './EmbeddedConversation.js';

export function EmbeddedChatPanel({
  agentId,
  renderEmptyState,
  tenantId,
  onManageProvider,
  byokFallback,
}: {
  agentId: string;
  renderEmptyState?: (onPick: (text: string) => void) => ReactNode;
  tenantId?: string;
  /** Where "connect a provider" routes the user. Defaults to the chat route `/`. */
  onManageProvider?: () => void;
  /** Replace the default BYOK gate UI entirely (rare). */
  byokFallback?: ReactNode;
}): JSX.Element {
  const { t } = useTranslation('chat');
  const navigate = useNavigate();
  const { config, isValid } = useBYOKConfig();
  const manageProvider = onManageProvider ?? ((): void => { void navigate('/'); });

  if (!config || !isValid) {
    if (byokFallback !== undefined) return <>{byokFallback}</>;
    // The chat surface (route `/`) owns BYOK setup; send the user there.
    return (
      <Notice variant="info">
        {t('embedNeedsProvider')}{' '}
        <button type="button" className="inline-link" onClick={manageProvider}>{t('embedManageProvider')}</button>
      </Notice>
    );
  }

  return (
    <EmbeddedConversation
      agentId={agentId}
      config={config}
      onReconfigureBYOK={manageProvider}
      {...(tenantId !== undefined ? { tenantId } : {})}
      {...(renderEmptyState ? { renderEmptyState } : {})}
    />
  );
}
