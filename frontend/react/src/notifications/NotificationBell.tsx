/**
 * Header bell + unread-count badge. Click toggles the right-side
 * `NotificationPanel` drawer.
 *
 * The bell shape is inline SVG so it doesn't add an icon-library dep.
 * Stays neutral (`--color-text-muted`) until there's something unread,
 * then takes on `--color-accent` so the user notices peripherally.
 */

import { useTranslation } from 'react-i18next';
import { useNotificationStore } from './notificationStore.js';

export function NotificationBell(): JSX.Element {
  const { t } = useTranslation('notifications');
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const togglePanel = useNotificationStore((s) => s.togglePanel);
  const panelOpen = useNotificationStore((s) => s.panelOpen);
  const hasUnread = unreadCount > 0;

  const label = hasUnread
    ? t('bellLabelUnread', { count: unreadCount })
    : t('bellLabel');

  return (
    <button
      type="button"
      className="secondary notification-bell notifbell-btn"
      onClick={togglePanel}
      aria-label={label}
      aria-expanded={panelOpen}
      aria-haspopup="dialog"
      title={label}
      style={{
        color: hasUnread ? 'var(--color-accent)' : undefined,
      }}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      {hasUnread && (
        <span
          aria-hidden="true"
          className="notifbell-badge"
        >
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </button>
  );
}
