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

import { Button } from '../ui/Button.js';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../ui/confirm.js';
import { Link } from 'react-router-dom';
import { useNotificationStore } from './notificationStore.js';
import { relativeLabel } from './relativeLabel.js';
import { priorityChip } from './priorityChip.js';
import { NotificationPreferencesPanel } from './NotificationPreferencesPanel.js';
import { InboxIcon, SettingsIcon, XIcon } from '../ui/icons/index.js';
import { Modal } from '../ui/Modal.js';
import { Notice } from '../ui/Notice.js';
import { Skeleton } from '../ui/Skeleton.js';
import { StateCard } from '../ui/StateCard.js';
import type { Notification } from './types.js';
import { notificationTypeIcon } from './notificationIcons.js';
import { actionLabelKeyFor, isSafeActionUrl } from './actionLabels.js';

type Tab = 'all' | 'unread' | 'archived';

const TYPE_COLOR: Record<string, string> = {
  'openwop-app.workflow.approval-needed': 'var(--color-warning)',
  'workflow.input_needed':    'var(--clay-text)',
  'workflow.failed':          'var(--color-danger)',
  'workflow.completed':       'var(--color-success)',
  'system.alert':             'var(--ink-3)',
};

export function NotificationPanel(): JSX.Element | null {
  const { t } = useTranslation('notifications');
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
    // ui/Modal composition (XC-7/SHELL-1): the drawer inherits the canonical
    // focus-trap + Escape + focus-restore + aria-modal + scrim contract; the
    // drawer geometry (right-docked, full-height, mobile full-bleed) lives in
    // .notifpanel-scrim/.notifpanel-drawer CSS instead of JS width math.
    <Modal
      onClose={closePanel}
      label={t('panelHeading')}
      scrimClassName="notifpanel-scrim"
      className="notifpanel-drawer"
    >
      <>
        <header className="u-flex u-items-center u-justify-between u-pad-3-4 u-border-b">
          <h2 className="u-m-0 u-fs-18">
            {t('panelHeading')}
            {unreadCount > 0 && (
              <span className="notifpanel-unread-badge">
                {unreadCount}
              </span>
            )}
          </h2>
          <div className="u-flex u-gap-1">
            <Button
              variant="secondary" className="u-fs-14"
              onClick={openPreferences}
              aria-label={t('preferencesButtonLabel')}
              title={t('preferencesButtonLabel')}
            >
              <SettingsIcon size={16} />
            </Button>
            <Button
              variant="secondary"
              onClick={closePanel}
              aria-label={t('closePanelLabel')}
            >
              <XIcon size={16} />
            </Button>
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
            label={t('desktopAlertsLabel')}
            cta={t('desktopAlertsCta')}
            onClick={() => void requestDesktopPermission()}
          />
        )}
        {desktopPermission === 'denied' && (
          <DesktopPermissionRow
            label={t('desktopAlertsBlocked')}
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
            label={t('pushAvailableLabel')}
            cta={t('pushAvailableCta')}
            onClick={() => void enablePush()}
          />
        )}
        {desktopPermission === 'granted' && pushStatus === 'subscribed' && (
          <DesktopPermissionRow
            label={t('pushSubscribedLabel')}
            tone="muted"
            cta={t('pushDisableCta')}
            onClick={() => void disablePush()}
          />
        )}

        <div className="u-flex u-gap-2 u-pad-2-4 u-border-b">
          <Button
            variant="secondary" className="u-fs-12"
            onClick={() => void markAllRead()}
            disabled={unreadCount === 0}
          >
            {t('markAllRead')}
          </Button>
          <Button
            variant="secondary" className="u-fs-12"
            onClick={() => void refresh()}
          >
            {t('refresh')}
          </Button>
        </div>

        <nav className="notifpanel-tabs">
          {([
            ['all',      t('tabAll'),      undefined],
            ['unread',   t('tabUnread'),   unreadCount],
            ['archived', t('tabArchived'), undefined],
          ] as const).map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              aria-pressed={tab === key}
              className="notifpanel-tab"
            >
              {label}
              {typeof count === 'number' && count > 0 && (
                <span className="notifpanel-tab-count">{count}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="u-flex-1 u-overflow-y-auto">
          {error && (
            <div className="notifpanel-alert">
              {/* R2 IB-SP-8 — localized; no endpoint paths in user copy. */}
              <Notice variant="error">{t('inboxActionFailedBody')}</Notice>
            </div>
          )}
          {loading && filtered.length === 0 && (
            <div className="notifpanel-empty" role="status" aria-label={t('common:loading')}>
              <Skeleton width="70%" />
              <Skeleton width="95%" />
              <Skeleton width="85%" />
            </div>
          )}
          {!loading && filtered.length === 0 && (
            <StateCard
              icon={<InboxIcon size={24} />}
              title={tab === 'unread'
                ? t('emptyUnread')
                : tab === 'archived'
                  ? t('emptyArchived')
                  : t('emptyAll')}
            />
          )}
          {filtered.map((n) => (
            <NotificationRow
              key={n.notificationId}
              notification={n}
              onMarkRead={() => void markAsRead(n.notificationId)}
              onArchive={() => void archive(n.notificationId)}
              onDelete={() => { void confirm({ title: t('deleteConfirm'), danger: true, confirmLabel: t('common:delete') }).then((ok) => { if (ok) void deleteNotif(n.notificationId); }); }}
              onClose={closePanel}
            />
          ))}
        </div>
          </>
        )}
      </>
    </Modal>
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
  const { t } = useTranslation('notifications');
  const isUnread = notification.status === 'unread';
  const icon = notificationTypeIcon(notification.type);
  const color = TYPE_COLOR[notification.type] ?? 'var(--ink-3)';
  const body = (
    <>
      <div className="u-flex u-items-baseline u-justify-between u-gap-2">
        <strong className="notifpanel-row-title">{notification.title}</strong>
        <span className="muted u-fs-11 u-nowrap">
          {relativeLabel(notification.createdAt, t)}
        </span>
        {/* R2 IB-SP-5 — urgency belongs on the GLANCE surface too. */}
        {priorityChip(notification.priority, t)}
      </div>
      <div className="muted notifpanel-row-message">{notification.message}</div>
    </>
  );
  return (
    // ARIA 1.2 (the ConversationsRail pattern): the mark-read action is a real
    // <button> around the row BODY only; the action link + buttons are
    // SIBLINGS, never interactive descendants of a role=button container.
    <div className="notifpanel-row" data-unread={isUnread ? 'true' : undefined}>
      <span
        aria-hidden="true"
        className="notifpanel-row-icon"
        style={{ '--notif-tone': color } as CSSProperties}
      >
        {icon}
      </span>
      <div className="u-flex-1 u-minw-0">
        {isUnread ? (
          <button
            type="button"
            className="notifpanel-row-open"
            onClick={onMarkRead}
            title={t('rowMarkRead')}
          >
            {body}
          </button>
        ) : (
          body
        )}
        {isSafeActionUrl(notification.actionUrl) && (
          <div className="u-mt-1-5">
            <Link
              to={notification.actionUrl}
              onClick={onClose}
              className="inline-link u-fs-12"
            >
              {t(actionLabelKeyFor(notification.type))} →
            </Link>
          </div>
        )}
        <div className="u-flex u-gap-2 u-mt-1-5">
          {isUnread && (
            <Button
              variant="secondary" className="u-fs-11"
              onClick={onMarkRead}
            >
              {t('rowMarkRead')}
            </Button>
          )}
          {notification.status !== 'archived' && (
            <Button
              variant="secondary" className="u-fs-11"
              onClick={onArchive}
            >
              {t('rowArchive')}
            </Button>
          )}
          <Button
            variant="danger" className="u-fs-11"
            onClick={onDelete}
          >
            {t('rowDelete')}
          </Button>
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
    <div className="notifpanel-perm-row" data-tone={tone}>
      <span className="notifpanel-perm-label">
        {label}
      </span>
      {cta && onClick && (
        <Button
          variant="secondary" className="u-fs-12 u-nowrap"
          onClick={onClick}
        >
          {cta}
        </Button>
      )}
    </div>
  );
}

/** Localized relative timestamp (`just now`, `5m ago`, …); falls back to a date past a week. */
// R2 IB-SP-7 — relativeLabel moved to ./relativeLabel.ts (the ONE implementation).

