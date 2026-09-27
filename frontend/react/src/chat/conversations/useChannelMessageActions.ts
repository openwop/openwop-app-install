/**
 * Multi-party message affordances (ADR 0195 D5 / ADR 0327 P3) — the ONE owner
 * of the reaction/edit/delete handlers both chat surfaces hand ConversationView.
 *
 * Previously copy-pasted verbatim between ChatSidebar and TabSession — an
 * authz-adjacent drift surface (the handlers wrap server-authoritative
 * mutations; the route re-checks author/owner). Extracted per the ADR 0140
 * parity-hook precedent (useConversationActions / useComposerModifiers) so
 * the copies can't drift. The surface reloads after each op; clients are
 * lazy-imported so the chat entry chunk stays lean.
 */

import { useMemo } from 'react';
import i18n from '../../i18n/index.js';
import { toast } from '../../ui/toast.js';
import { confirm } from '../../ui/confirm.js';

export interface ChannelMessageActions {
  onToggleReaction: (messageId: string, emoji: string, currentlyMine: boolean) => void;
  onEdit: (messageId: string, newText: string) => void;
  onDelete: (messageId: string) => void;
}

export function useChannelMessageActions(
  sessionId: string,
  loadSessionFromBackend: (sessionId: string) => Promise<void>,
): ChannelMessageActions {
  return useMemo(() => ({
    onToggleReaction: (messageId: string, emoji: string, currentlyMine: boolean) => {
      void (async () => {
        try {
          const { setMessageReaction } = await import('../../client/chatSessionsClient.js');
          await setMessageReaction(sessionId, messageId, emoji, !currentlyMine);
          await loadSessionFromBackend(sessionId);
        } catch { toast.error(i18n.t('chat:reactionFailed')); }
      })();
    },
    onEdit: (messageId: string, newText: string) => {
      void (async () => {
        try {
          const { editChatMessage } = await import('../../client/chatSessionsClient.js');
          await editChatMessage(sessionId, messageId, newText);
          await loadSessionFromBackend(sessionId);
        } catch { toast.error(i18n.t('chat:editMessageFailed')); }
      })();
    },
    onDelete: (messageId: string) => {
      void (async () => {
        const ok = await confirm({
          title: i18n.t('chat:deleteMessageConfirmTitle'),
          body: i18n.t('chat:deleteMessageConfirmBody'),
          danger: true,
          confirmLabel: i18n.t('common:delete'),
        });
        if (!ok) return;
        try {
          const { deleteChatMessage } = await import('../../client/chatSessionsClient.js');
          await deleteChatMessage(sessionId, messageId);
          await loadSessionFromBackend(sessionId);
        } catch { toast.error(i18n.t('chat:deleteMessageFailed')); }
      })();
    },
  }), [sessionId, loadSessionFromBackend]);
}
