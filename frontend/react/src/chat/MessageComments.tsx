/**
 * Inline-in-chat comments (ADR 0021 extension). A collapsed affordance beneath a
 * chat message that expands the shared CommentsPanel scoped to the
 * `chat_message` thread `${sessionId}#${messageId}`.
 *
 * The panel is mounted ONLY while open, so a chat's initial render fires no
 * comment fetch — the thread loads on demand (no N+1 / rate-limit fan-out on
 * load). Reuses the Comments feature verbatim (no second comment system): this
 * is ADR 0021's "one commentable type = one registry entry" surfaced inline.
 */
import { Button } from '../ui/Button.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CommentsPanel } from '../features/comments/CommentsPanel.js';
import { MessageSquareIcon } from '../ui/icons/index.js';

export function MessageComments(
  { orgId, sessionId, messageId }: { orgId: string; sessionId: string; messageId: string },
): JSX.Element {
  const { t } = useTranslation('comments');
  const [open, setOpen] = useState(false);
  return (
    <div className="msgfeed-card-indent u-flex u-flex-col u-gap-1">
      <Button
        variant="quiet" size="sm" className="u-self-start"
        aria-expanded={open}
        aria-label={t('inlineToggleAria')}
        onClick={() => setOpen((v) => !v)}
      >
        <MessageSquareIcon size={13} /> {t('inlineToggle')}
      </Button>
      {open ? (
        <CommentsPanel orgId={orgId} resourceType="chat_message" resourceId={`${sessionId}#${messageId}`} />
      ) : null}
    </div>
  );
}
