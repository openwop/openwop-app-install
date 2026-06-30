/**
 * `/inbox` — full-page notification surface. Subsumes the original
 * HitlInboxPage: notifications of type `workflow.approval_needed` /
 * `workflow.input_needed` render the inline approval form (so the
 * /inbox page itself is the action surface), while other notification
 * types render as a row with a deep-link.
 *
 * The bell + drawer cover the "glance" use case from anywhere in the
 * app; this page is the "sit down and clear the queue" surface.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../ui/confirm.js';
import { Link } from 'react-router-dom';
import { useNotificationStore } from './notificationStore.js';
import { PageHeader } from '../ui/PageHeader.js';
import { StateCard } from '../ui/StateCard.js';
import { Notice } from '../ui/Notice.js';
import { IconButton } from '../ui/IconButton.js';
import { KeyFigureBand, type KeyFigureItem } from '../ui/KeyFigure.js';
import {
  AlertIcon,
  CheckSquareIcon,
  ScaleIcon,
  MegaphoneIcon,
  InfoIcon,
  InboxIcon,
  TrashIcon,
  CheckIcon,
  RotateCwIcon,
} from '../ui/icons/index.js';
import { listOpenInterrupts, type OpenInterrupt } from '../client/interruptsClient.js';
import { RenderInterrupt } from '../interrupts/RenderInterrupt.js';
import { NeedsYouInbox } from './NeedsYouInbox.js';
import { relativeTime } from '../agents/agentViewModel.js';
import { formatDateTime } from '../i18n/format.js';
import type { Notification, NotificationType, NotificationPriority } from './types.js';
import { isActionNeeded, TYPE_LABEL_KEYS } from './types.js';

type Tab = 'action-needed' | 'all' | 'archived';

/** Tab → i18n key. Resolved via the page's `t()` so the strip stays localized. */
const TAB_LABEL_KEYS: Record<Tab, string> = {
  'action-needed': 'tabActionNeeded',
  'all':           'tabPageAll',
  'archived':      'tabPageArchived',
};

/** Map a notification type to its scanning glyph. Unknown (open-wire) types
 *  fall through to the neutral InfoIcon so new BE types render forward-compat. */
function typeIcon(type: NotificationType, size = 16): JSX.Element {
  switch (type) {
    case 'workflow.approval_needed':
    case 'workflow.input_needed':
      return <ScaleIcon size={size} />;
    case 'workflow.failed':
      return <AlertIcon size={size} />;
    case 'workflow.completed':
      return <CheckSquareIcon size={size} />;
    case 'system.alert':
      return <MegaphoneIcon size={size} />;
    default:
      return <InfoIcon size={size} />;
  }
}

/** Priority → labeled chip tone (DESIGN §5.3 severity reuse). `normal` is the
 *  baseline and renders no chip; only the off-baseline bands earn a pill. */
function priorityChip(priority: NotificationPriority, t: (k: string) => string): JSX.Element | null {
  switch (priority) {
    case 'urgent':
      return <span className="chip chip--danger">{t('priorityUrgent')}</span>;
    case 'high':
      return <span className="chip chip--warning">{t('priorityHigh')}</span>;
    case 'low':
      return <span className="chip chip--muted">{t('priorityLow')}</span>;
    default:
      return null;
  }
}

export function NotificationsPage(): JSX.Element {
  const { t } = useTranslation('notifications');
  const notifications = useNotificationStore((s) => s.notifications);
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const refresh = useNotificationStore((s) => s.refresh);
  const archive = useNotificationStore((s) => s.archive);
  const deleteN = useNotificationStore((s) => s.delete);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const error = useNotificationStore((s) => s.error);
  const loading = useNotificationStore((s) => s.loading);

  const [tab, setTab] = useState<Tab>('action-needed');

  useEffect(() => { void refresh(); }, [refresh]);

  const filtered = useMemo<Notification[]>(() => {
    if (tab === 'archived') return notifications.filter((n) => n.status === 'archived');
    const nonArchived = notifications.filter((n) => n.status !== 'archived');
    if (tab === 'action-needed') return nonArchived.filter(isActionNeeded);
    return nonArchived;
  }, [notifications, tab]);

  const counts = useMemo(() => {
    const nonArchived = notifications.filter((n) => n.status !== 'archived');
    return {
      'action-needed': nonArchived.filter(isActionNeeded).length,
      'all':           nonArchived.length,
      'archived':      notifications.filter((n) => n.status === 'archived').length,
    } satisfies Record<Tab, number>;
  }, [notifications]);

  const actionNeededCount = counts['action-needed'];

  // The tab strip IS the key-figure band: each count both reports and filters
  // the queue below it (DESIGN §4.5 "stats are filters"). Action-needed reads
  // amber when there's anything waiting on the human.
  const figures: KeyFigureItem[] = (['action-needed', 'all', 'archived'] as const).map((key) => ({
    key,
    label: t(TAB_LABEL_KEYS[key]),
    value: counts[key],
    ...(key === 'action-needed' && actionNeededCount > 0 ? { tone: 'attention' as const } : {}),
    glyph:
      key === 'action-needed' ? <ScaleIcon size={13} />
      : key === 'archived'    ? <InboxIcon size={13} />
      :                          <CheckSquareIcon size={13} />,
  }));

  return (
    <section className="page-stack">
      <PageHeader
        eyebrow={t('pageEyebrow')}
        title={t('pageTitle')}
        lede={t('pageLede')}
        actions={
          <>
            <button type="button" className="secondary" onClick={() => void markAllRead()} disabled={unreadCount === 0}>
              <CheckIcon size={13} /> {t('markAllRead')}
            </button>
            <button type="button" className="secondary" onClick={() => void refresh()}>
              <RotateCwIcon size={13} /> {t('common:refresh')}
            </button>
          </>
        }
      />
      {error && <Notice variant="error">{error}</Notice>}

      <NeedsYouInbox onResolved={() => void refresh()} />

      <KeyFigureBand
        figures={figures}
        activeKey={tab}
        onToggle={(key) => setTab(key as Tab)}
        ariaLabel={t('filterAriaLabel')}
      />

      {loading && filtered.length === 0 && (
        <StateCard loading icon={<InboxIcon size={28} />} title={t('loadingInbox')} />
      )}
      {!loading && filtered.length === 0 && (
        tab === 'archived' ? (
          <StateCard
            icon={<InboxIcon size={28} />}
            title={t('emptyArchivedTitle')}
            body={t('emptyArchivedBody')}
            action={
              <button type="button" className="secondary" onClick={() => setTab('action-needed')}>
                {t('backToActionNeeded')}
              </button>
            }
          />
        ) : tab === 'action-needed' ? (
          <StateCard
            icon={<CheckSquareIcon size={28} />}
            title={t('emptyActionNeededTitle')}
            body={t('emptyActionNeededBody')}
            action={
              <Link to="/runs" className="inline-link">{t('viewRuns')}</Link>
            }
          />
        ) : (
          <StateCard
            icon={<InboxIcon size={28} />}
            title={t('emptyAllTitle')}
            body={t('emptyAllBody')}
            action={
              <Link to="/workflows" className="inline-link">{t('browseWorkflows')}</Link>
            }
          />
        )
      )}

      <div className="page-enter u-grid u-gap-3">
        {filtered.map((n) => (
          <NotificationCard
            key={n.notificationId}
            notification={n}
            onArchive={() => void archive(n.notificationId)}
            onDelete={() => { void confirm({ title: t('deleteConfirm'), danger: true, confirmLabel: t('common:delete') }).then((ok) => { if (ok) void deleteN(n.notificationId); }); }}
            onResolved={() => {
              // After an interrupt is resolved, archive the notification
              // and re-fetch — the BE may have emitted a follow-up event
              // (e.g., next interrupt opens) we'd otherwise miss until
              // the next SSE frame.
              void archive(n.notificationId);
              void refresh();
            }}
          />
        ))}
      </div>
    </section>
  );
}

interface NotificationCardProps {
  notification: Notification;
  onArchive: () => void;
  onDelete: () => void;
  onResolved: () => void;
}

function NotificationCard({
  notification,
  onArchive,
  onDelete,
  onResolved,
}: NotificationCardProps): JSX.Element {
  const { t } = useTranslation('notifications');
  const isUnread = notification.status === 'unread';
  const when = relativeTime(notification.createdAt);
  return (
    <div className="surface-card">
      <div className="u-flex u-items-center u-gap-2 u-mb-2">
        <span className="muted u-iflex" aria-hidden="true">{typeIcon(notification.type)}</span>
        <strong>{notification.title}</strong>
        <span className="chip chip--muted">{t(TYPE_LABEL_KEYS[notification.type] ?? notification.type)}</span>
        {priorityChip(notification.priority, t)}
        {isUnread && <span className="chip chip--accent">{t('cardUnread')}</span>}
        <span className="muted u-ml-auto u-fs-12" title={formatDateTime(notification.createdAt)}>
          {when ?? formatDateTime(notification.createdAt)}
        </span>
      </div>
      <p className="notifpage-card-message">{notification.message}</p>
      {notification.runId && (
        <div className="u-mb-2">
          <Link to={`/runs/${notification.runId}`} className="inline-link u-fs-12">
            {t('cardRunLink', { id: notification.runId.slice(0, 12) })}
          </Link>
        </div>
      )}

      {isActionNeeded(notification) && notification.runId && (
        <InlineInterruptResolver
          runId={notification.runId}
          interruptId={notification.interruptId}
          onResolved={onResolved}
        />
      )}

      <div className="action-bar u-justify-end u-mt-3">
        {notification.status !== 'archived' && (
          <IconButton label={t('archive')} icon={<InboxIcon size={15} />} onClick={onArchive} />
        )}
        <IconButton label={t('common:delete')} icon={<TrashIcon size={15} />} className="icon-button u-text-danger" onClick={onDelete} />
      </div>
    </div>
  );
}

interface ResolverProps {
  runId: string;
  interruptId?: string | undefined;
  onResolved: () => void;
}

function InlineInterruptResolver({ runId, interruptId, onResolved }: ResolverProps): JSX.Element | null {
  const { t } = useTranslation('notifications');
  const [open, setOpen] = useState<OpenInterrupt | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listOpenInterrupts(runId);
        if (cancelled) return;
        // Prefer the interrupt the notification points at; fall back
        // to whatever's open if the BE event came in before the
        // notification metadata had the id, or the row drifted.
        const match = interruptId
          ? (list.find((i) => i.interruptId === interruptId) ?? list[0] ?? null)
          : (list[0] ?? null);
        setOpen(match);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [runId, interruptId]);

  if (error) return <Notice variant="error">{error}</Notice>;
  if (!open) {
    return (
      <div className="muted u-fs-12">
        {t('interruptResolvedElsewhere')}
      </div>
    );
  }
  return (
    <div className="notifpage-resolver">
      <RenderInterrupt runId={runId} active={open} onResolved={onResolved} />
    </div>
  );
}
