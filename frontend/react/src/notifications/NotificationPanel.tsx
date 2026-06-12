/**
 * Right-side notification drawer. Mirrors the layout of
 * `WorkflowProgressPanel` — slide-out from the right edge, fixed
 * width on desktop, full-bleed below the mobile breakpoint.
 *
 * Three tabs:
 *   - All        — every non-archived row
 *   - Unread     — `status === 'unread'`
 *   - Archived   — `status === 'archived'`
 *
 * Each row renders the type-specific icon + title + message + a
 * relative timestamp. Action-needed rows expose an inline "Open
 * inbox" link so the user can resolve without leaving the panel
 * to dig through Runs.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useNotificationStore } from './notificationStore.js';
import { NotificationPreferencesPanel } from './NotificationPreferencesPanel.js';
import { AlertIcon, CheckIcon, MessageSquareIcon, SettingsIcon, XIcon } from '../ui/icons/index.js';
import type { Notification, NotificationType } from './types.js';

type Tab = 'all' | 'unread' | 'archived';

const TYPE_ICON: Record<string, React.ReactNode> = {
  'workflow.approval_needed': <AlertIcon size={14} />,
  'workflow.input_needed':    '?',
  'workflow.failed':          '!',
  'workflow.completed':       <CheckIcon size={14} />,
  'system.alert':             'i',
  // Comments feature (ADR 0021) — additive, fallback-protected; no core-union edit.
  'comment.added':            <MessageSquareIcon size={14} />,
  'comment.reply':            <MessageSquareIcon size={14} />,
};

const TYPE_COLOR: Record<string, string> = {
  'workflow.approval_needed': 'var(--color-warning)',
  'workflow.input_needed':    'var(--color-accent)',
  'workflow.failed':          'var(--color-danger)',
  'workflow.completed':       'var(--color-success)',
  'system.alert':             'var(--color-text-muted)',
};

export function NotificationPanel(): JSX.Element | null {
  const panelOpen = useNotificationStore((s) => s.panelOpen);
  const closePanel = useNotificationStore((s) => s.closePanel);
  const notifications = useNotificationStore((s) => s.notifications);
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const markAsRead = useNotificationStore((s) => s.markAsRead);
  const archive = useNotificationStore((s) => s.archive);
  const deleteNotif = useNotificationStore((s) => s.delete);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const refresh = useNotificationStore((s) => s.refresh);
  const loading = useNotificationStore((s) => s.loading);
  const error = useNotificationStore((s) => s.error);
  const desktopPermission = useNotificationStore((s) => s.desktopPermission);
  const requestDesktopPermission = useNotificationStore((s) => s.requestDesktopPermission);
  const syncDesktopPermission = useNotificationStore((s) => s.syncDesktopPermission);
  const preferencesOpen = useNotificationStore((s) => s.preferencesOpen);
  const openPreferences = useNotificationStore((s) => s.openPreferences);
  const pushStatus = useNotificationStore((s) => s.pushStatus);
  const enablePush = useNotificationStore((s) => s.enablePush);
  const disablePush = useNotificationStore((s) => s.disablePush);
  const syncPushStatus = useNotificationStore((s) => s.syncPushStatus);

  const [tab, setTab] = useState<Tab>('all');
  // Track viewport width so the panel switches between right-side
  // drawer and full-screen overlay below the mobile breakpoint —
  // same pattern as WorkflowProgressPanel.
  const isMobile = useIsMobile();

  // Esc closes the panel when focus is inside.
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!panelOpen) return;
    // Refresh on open so a tab returning from background sees the
    // latest BE state without waiting for SSE. Also re-read the
    // browser's permission state — the user may have changed it in
    // site settings between sessions.
    void refresh();
    syncDesktopPermission();
    void syncPushStatus();
  }, [panelOpen, refresh, syncDesktopPermission, syncPushStatus]);

  const filtered = useMemo(() => {
    if (tab === 'unread') return notifications.filter((n) => n.status === 'unread');
    if (tab === 'archived') return notifications.filter((n) => n.status === 'archived');
    return notifications.filter((n) => n.status !== 'archived');
  }, [notifications, tab]);

  if (!panelOpen) return null;

  return (
    <>
      {/* Backdrop — click to dismiss, same affordance as a modal. The
          panel itself stays mounted so opening/closing doesn't lose
          scroll position or the active tab. */}
      <div
        onClick={closePanel}
        aria-hidden="true"
        className="notifpanel-backdrop"
        style={{
          background: isMobile ? 'var(--scrim-soft)' : 'transparent',
        }}
      />
      {/* role="dialog" is a window/structure role, not a widget, so the
          a11y plugin treats it as non-interactive — but an Escape-to-close
          keydown on a dialog container is the correct, expected pattern. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <aside
        ref={ref}
        tabIndex={-1}
        onKeyDown={(e) => { if (e.key === 'Escape') closePanel(); }}
        role="dialog"
        aria-labelledby="notification-panel-heading"
        className="notifpanel-drawer"
        style={{
          width: isMobile ? '100%' : 400,
        }}
      >
        <header className="u-flex u-items-center u-justify-between u-pad-3-4 u-border-b">
          <h2 id="notification-panel-heading" className="u-m-0 u-fs-18">
            Notifications
            {unreadCount > 0 && (
              <span className="notifpanel-unread-badge">
                {unreadCount}
              </span>
            )}
          </h2>
          <div className="u-flex u-gap-1">
            <button
              type="button"
              className="secondary u-fs-14"
              onClick={openPreferences}
              aria-label="Notification preferences"
              title="Notification preferences"
            >
              <SettingsIcon size={16} />
            </button>
            <button
              type="button"
              className="secondary"
              onClick={closePanel}
              aria-label="Close notifications"
            >
              <XIcon size={16} />
            </button>
          </div>
        </header>

        {/* Preferences subdrawer takes over the panel body when open —
            replaces actions/tabs/list with the prefs UI. The header
            stays put so the close button is always reachable. */}
        {preferencesOpen && <NotificationPreferencesPanel />}

        {!preferencesOpen && (
          <>
        {/* Desktop-notifications affordance. The browser's
            `requestPermission()` MUST be called inside a user gesture
            (a click handler), so this lives behind a button — auto-
            prompting on mount results in 'denied' on most modern
            browsers. The row hides itself once the user grants
            permission, and degrades gracefully to a "Blocked" hint
            if denied (recovery is via the lock icon in the address
            bar — we can't re-prompt). */}
        {desktopPermission === 'default' && (
          <DesktopPermissionRow
            label="Get a desktop alert when something needs your attention"
            cta="Enable desktop alerts"
            onClick={() => void requestDesktopPermission()}
          />
        )}
        {desktopPermission === 'denied' && (
          <DesktopPermissionRow
            label="Desktop alerts are blocked. Unblock in site settings to re-enable."
            tone="muted"
          />
        )}

        {/* Push affordance. Only surfaces when:
              - browser supports Push (status !== 'unsupported')
              - BE is configured with VAPID (status !== 'disabled')
              - user has granted Notifications perm (otherwise push
                arrives but the SW can't show the toast)
            Pairs naturally with the desktop-perm row above. */}
        {desktopPermission === 'granted' && pushStatus === 'available' && (
          <DesktopPermissionRow
            label="Also receive alerts when this tab is closed"
            cta="Enable background push"
            onClick={() => void enablePush()}
          />
        )}
        {desktopPermission === 'granted' && pushStatus === 'subscribed' && (
          <DesktopPermissionRow
            label="Background push is on. Alerts continue when the tab is closed."
            tone="muted"
            cta="Disable"
            onClick={() => void disablePush()}
          />
        )}

        <div className="u-flex u-gap-2 u-pad-2-4 u-border-b">
          <button
            type="button"
            className="secondary u-fs-12"
            onClick={() => void markAllRead()}
            disabled={unreadCount === 0}
          >
            Mark all read
          </button>
          <button
            type="button"
            className="secondary u-fs-12"
            onClick={() => void refresh()}
          >
            Refresh
          </button>
        </div>

        <nav className="u-flex u-border-b">
          {([
            ['all',      'All'],
            ['unread',   `Unread (${unreadCount})`],
            ['archived', 'Archived'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              aria-pressed={tab === key}
              className="notifpanel-tab"
              style={{
                borderBottom: tab === key
                  ? '2px solid var(--color-accent)'
                  : '2px solid transparent',
                fontWeight: tab === key ? 600 : 400,
                color: tab === key ? 'var(--color-accent)' : 'inherit',
              }}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="u-flex-1 u-overflow-y-auto">
          {error && (
            <div className="alert error notifpanel-alert">
              {error}
            </div>
          )}
          {loading && filtered.length === 0 && (
            <div className="muted notifpanel-empty">
              Loading…
            </div>
          )}
          {!loading && filtered.length === 0 && (
            <div className="muted notifpanel-empty">
              {tab === 'unread'
                ? 'Nothing unread.'
                : tab === 'archived'
                  ? 'Nothing archived.'
                  : 'No notifications yet. Run a workflow that needs an approval to see something here.'}
            </div>
          )}
          {filtered.map((n) => (
            <NotificationRow
              key={n.notificationId}
              notification={n}
              onMarkRead={() => void markAsRead(n.notificationId)}
              onArchive={() => void archive(n.notificationId)}
              onDelete={() => { if (window.confirm("Delete this notification? This can't be undone — use Archive to dismiss without deleting.")) void deleteNotif(n.notificationId); }}
              onClose={closePanel}
            />
          ))}
        </div>
          </>
        )}
      </aside>
    </>
  );
}

interface NotificationRowProps {
  notification: Notification;
  onMarkRead: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onClose: () => void;
}

function NotificationRow({
  notification,
  onMarkRead,
  onArchive,
  onDelete,
  onClose,
}: NotificationRowProps): JSX.Element {
  const isUnread = notification.status === 'unread';
  const icon = TYPE_ICON[notification.type] ?? '•';
  const color = TYPE_COLOR[notification.type] ?? 'var(--color-text-muted)';
  return (
    <div
      className="notifpanel-row"
      style={{
        background: isUnread ? 'color-mix(in oklch, var(--color-accent) 6%, transparent)' : 'transparent',
        cursor: isUnread ? 'pointer' : 'default',
      }}
      role={isUnread ? 'button' : undefined}
      tabIndex={isUnread ? 0 : undefined}
      onClick={isUnread ? onMarkRead : undefined}
      onKeyDown={isUnread ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onMarkRead(); }
      } : undefined}
    >
      <span
        aria-hidden="true"
        className="notifpanel-row-icon"
        style={{
          background: `color-mix(in oklch, ${color} 15%, transparent)`,
          color,
        }}
      >
        {icon}
      </span>
      <div className="u-flex-1 u-minw-0">
        <div className="u-flex u-items-baseline u-justify-between u-gap-2">
          <strong style={{ fontWeight: isUnread ? 600 : 400 }}>{notification.title}</strong>
          <span className="muted u-fs-11 u-nowrap">
            {formatTime(notification.createdAt)}
          </span>
        </div>
        <div className="muted notifpanel-row-message">{notification.message}</div>
        {notification.actionUrl && (
          <div className="u-mt-1-5">
            <Link
              to={notification.actionUrl}
              onClick={(e) => { e.stopPropagation(); onClose(); }}
              className="u-fs-12"
            >
              {actionLabelFor(notification.type)} →
            </Link>
          </div>
        )}
        <div className="u-flex u-gap-2 u-mt-1-5">
          {isUnread && (
            <button
              type="button"
              className="secondary u-fs-11"
              onClick={(e) => { e.stopPropagation(); onMarkRead(); }}
            >
              Mark read
            </button>
          )}
          {notification.status !== 'archived' && (
            <button
              type="button"
              className="secondary u-fs-11"
              onClick={(e) => { e.stopPropagation(); onArchive(); }}
            >
              Archive
            </button>
          )}
          <button
            type="button"
            className="secondary u-fs-11 u-text-danger"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

interface DesktopPermissionRowProps {
  label: string;
  cta?: string;
  onClick?: () => void;
  tone?: 'default' | 'muted';
}

function DesktopPermissionRow({ label, cta, onClick, tone = 'default' }: DesktopPermissionRowProps): JSX.Element {
  return (
    <div
      className="notifpanel-perm-row"
      style={{
        background: tone === 'muted'
          ? 'transparent'
          : 'color-mix(in oklch, var(--color-accent) 8%, transparent)',
      }}
    >
      <span className="notifpanel-perm-label" style={{ color: tone === 'muted' ? 'var(--color-text-muted)' : 'inherit' }}>
        {label}
      </span>
      {cta && onClick && (
        <button
          type="button"
          className="secondary u-fs-12 u-nowrap"
          onClick={onClick}
        >
          {cta}
        </button>
      )}
    </div>
  );
}

function actionLabelFor(type: NotificationType): string {
  if (type === 'workflow.approval_needed' || type === 'workflow.input_needed') return 'Open inbox';
  if (type === 'workflow.failed' || type === 'workflow.completed') return 'View run';
  return 'View';
}

function formatTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  const m = Math.floor(diffMs / 60_000);
  const h = Math.floor(diffMs / 3_600_000);
  const d = Math.floor(diffMs / 86_400_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window === 'undefined' ? false : window.innerWidth < 720,
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 720);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return isMobile;
}
