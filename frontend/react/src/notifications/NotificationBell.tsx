/**
 * Header bell + unread-count badge. Click toggles the right-side
 * `NotificationPanel` drawer.
 *
 * The bell shape is inline SVG so it doesn't add an icon-library dep.
 * Stays neutral (`--color-text-muted`) until there's something unread,
 * then takes on `--color-accent` so the user notices peripherally.
 */

import { Button } from '../ui/Button.js';
import { useTranslation } from 'react-i18next';
import { BellIcon } from '../ui/icons/index.js';
import { useNotificationStore } from './notificationStore.js';

export function NotificationBell(): JSX.Element {
  const { t } = useTranslation('notifications');
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const togglePanel = useNotificationStore((s) => s.togglePanel);
  const panelOpen = useNotificationStore((s) => s.panelOpen);
  // R2 IB-SP-2 — `connectionStatus` existed precisely for this and NOTHING
  // consumed it: during an SSE drop the user saw a normal inbox that was
  // silently stale. The bell now says so.
  const connectionStatus = useNotificationStore((s) => s.connectionStatus);
  const stale = connectionStatus === 'error';
  const hasUnread = unreadCount > 0;


  // R2 review F12 — a blip must not erase the count: compose, don't replace.
  const label = stale
    ? (hasUnread ? `${t('bellLabelUnread', { count: unreadCount })} — ${t('bellLabelStale')}` : t('bellLabelStale'))
    : hasUnread
      ? t('bellLabelUnread', { count: unreadCount })
      : t('bellLabel');

  return (
    <Button
      variant="secondary" className="notification-bell notifbell-btn"
      onClick={togglePanel}
      aria-label={label}
      aria-expanded={panelOpen}
      aria-haspopup="dialog"
      title={label}
      style={{
        color: hasUnread ? 'var(--clay-text)' : undefined,
      }}
    >
      <BellIcon size={18} />
      {stale ? (
        <span aria-hidden="true" className="notifbell-badge notifbell-badge--stale">!</span>
      ) : hasUnread ? (
        <span
          aria-hidden="true"
          className="notifbell-badge"
        >
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      ) : null}
    </Button>
  );
}
