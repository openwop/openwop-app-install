/**
 * `/inbox` — full-page notification surface. Subsumes the original
 * HitlInboxPage: notifications of type `openwop-app.workflow.approval-needed` /
 * `workflow.input_needed` render the inline approval form (so the
 * /inbox page itself is the action surface), while other notification
 * types render as a row with a deep-link.
 *
 * The bell + drawer cover the "glance" use case from anywhere in the
 * app; this page is the "sit down and clear the queue" surface.
 */

import { Button } from '../ui/Button.js';
import { useEffect, useMemo, useRef, useState, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../ui/confirm.js';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { scrollBehavior } from '../ui/motion.js';
import { useNotificationStore } from './notificationStore.js';
import { PageHeader } from '../ui/PageHeader.js';
import { StateCard } from '../ui/StateCard.js';
import { Notice } from '../ui/Notice.js';
import { IconButton } from '../ui/IconButton.js';
import { KeyFigureBand, type KeyFigureItem } from '../ui/KeyFigure.js';
import {
  CheckSquareIcon,
  ScaleIcon,
  InboxIcon,
  TrashIcon,
  CheckIcon,
  RotateCwIcon,
} from '../ui/icons/index.js';
import { listOpenInterrupts, type OpenInterrupt } from '../client/interruptsClient.js';
import { RenderInterrupt } from '../interrupts/RenderInterrupt.js';
import { NeedsYouInbox } from './NeedsYouInbox.js';
import { DelegationSection } from './DelegationSection.js';
import { TeamsDeliverySection } from './TeamsDeliverySection.js';
import { relativeLabel } from './relativeLabel.js';
import { priorityChip } from './priorityChip.js';
import { formatDateTime } from '../i18n/format.js';
import type { Notification } from './types.js';
import { isActionNeeded, TYPE_LABEL_KEYS } from './types.js';
import { notificationTypeIcon } from './notificationIcons.js';
import { actionLabelKeyFor, isSafeActionUrl } from './actionLabels.js';
import {
  parseInboxDeepLink,
  matchesInboxDeepLink,
  canonicalInboxTabFor,
  inboxTabShows,
  type InboxTab,
} from './notificationDeepLink.js';

type Tab = InboxTab;

/** Tab → i18n key. Resolved via the page's `t()` so the strip stays localized. */

/** Attribute-selector escape that survives environments without `CSS.escape`
 *  (jsdom). Inside a double-quoted attribute selector only `"` and `\` need
 *  escaping. */
function escAttr(v: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(v) : v.replace(/["\\]/g, '\\$&');
}

const TAB_LABEL_KEYS: Record<Tab, string> = {
  'action-needed': 'tabActionNeeded',
  'all':           'tabPageAll',
  'archived':      'tabPageArchived',
};

/** Map a notification type to its scanning glyph. Unknown (open-wire) types
 *  fall through to the neutral InfoIcon so new BE types render forward-compat. */
const typeIcon = notificationTypeIcon; // the ONE shared type→icon map (DL-UX-4)


export function NotificationsPage(): JSX.Element {
  const { t } = useTranslation('notifications');
  const notifications = useNotificationStore((s) => s.notifications);
  const connectionStatus = useNotificationStore((s) => s.connectionStatus);
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const refresh = useNotificationStore((s) => s.refresh);
  const archive = useNotificationStore((s) => s.archive);
  const deleteN = useNotificationStore((s) => s.delete);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const archiveRead = useNotificationStore((s) => s.archiveRead);
  const markRead = useNotificationStore((s) => s.markRead);
  const markAsRead = useNotificationStore((s) => s.markAsRead);
  const markAsUnread = useNotificationStore((s) => s.markAsUnread);
  const error = useNotificationStore((s) => s.error);
  const loading = useNotificationStore((s) => s.loading);

  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('action-needed');
  const { search } = useLocation();

  useEffect(() => { void refresh(); }, [refresh]);

  // Deep-link target (ADR 0336 Rec Phase 3): resolve ?notification=/?approval=
  // against the FULL list (not the current tab's filter) so the row is findable
  // even when it lives under a different tab.
  const deepLink = useMemo(() => parseInboxDeepLink(search), [search]);
  const target = useMemo<Notification | null>(() => {
    if (!deepLink.notificationId && !deepLink.approvalId) return null;
    return notifications.find((n) => matchesInboxDeepLink(n, deepLink)) ?? null;
  }, [notifications, deepLink]);
  const focusId = target?.notificationId ?? '';

  // One-shot (per resolved target): if the target isn't visible under the
  // current tab, switch to the tab that shows it — else the deep-link would
  // land on a page where its card is filtered out. The ref-guard lets the user
  // freely change tabs afterward without the effect yanking them back.
  const autoTabbedFor = useRef('');
  useEffect(() => {
    if (!target || autoTabbedFor.current === target.notificationId) return;
    autoTabbedFor.current = target.notificationId;
    setTab((cur) => (inboxTabShows(cur, target) ? cur : canonicalInboxTabFor(target)));
  }, [target]);
  const focusRef = useRef<HTMLDivElement | null>(null);
  // IB-G1 — every notification carries a `priority` ('low'|'normal'|'high'|
  // 'urgent') and the page never used it. On a busy queue "what is actually
  // urgent" is the question the inbox exists to answer, so narrow to the top
  // two bands. Applied WITHIN the active tab, never across it — the tab is the
  // primary axis and its counts must keep meaning what they say.
  const [urgentOnly, setUrgentOnly] = useState(false);
  // R2 IB-R2-1 (promotes round-1's IB-G3) — the converged triage grammar 4 of
  // 6 leaders ship: j/k (or arrows) move a cursor, e archives it, u toggles
  // read, Enter opens its action URL (buttons keep Enter; overlays disarm the
  // whole grammar). Tracked by id (not index) so the cursor
  // survives list mutations; text inputs and Space-on-button stay untouched
  // (the shared-deck key-guard lesson).
  const [cursorId, setCursorId] = useState<string | null>(null);

  const inTab = useMemo<Notification[]>(() => {
    if (tab === 'archived') return notifications.filter((n) => n.status === 'archived');
    const nonArchived = notifications.filter((n) => n.status !== 'archived');
    if (tab === 'action-needed') return nonArchived.filter(isActionNeeded);
    return nonArchived;
  }, [notifications, tab]);

  const urgentInTab = useMemo(
    () => inTab.filter((n) => n.priority === 'urgent' || n.priority === 'high').length,
    [inTab],
  );
  const filtered = useMemo<Notification[]>(
    () => (urgentOnly ? inTab.filter((n) => n.priority === 'urgent' || n.priority === 'high') : inTab),
    [inTab, urgentOnly],
  );

  // Scroll + focus the matching card once it's rendered under the active tab
  // (re-runs after an auto-tab switch changes `filtered`). DL-UX-2 focus pattern.
  useEffect(() => {
    if (focusId && focusRef.current) {
      focusRef.current.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
      focusRef.current.focus({ preventScroll: true });
    }
  }, [focusId, filtered]);

  const filteredRef = useRef<Notification[]>([]);
  filteredRef.current = filtered;
  const cursorRef = useRef<string | null>(null);
  cursorRef.current = cursorId;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return;
      // R2 review F5 — the queue must NOT mutate under the app's own
      // overlays: with the delete-confirm dialog, the preferences modal, or
      // the bell drawer open, `e` was archiving the row BEHIND the dialog.
      if (document.querySelector('[role="dialog"]')) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const list = filteredRef.current;
      if (list.length === 0) return;
      const cur = cursorRef.current;
      const idx = cur ? list.findIndex((n) => n.notificationId === cur) : -1;
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setCursorId(list[Math.min(idx + 1, list.length - 1)]!.notificationId);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setCursorId(list[Math.max(idx - 1, 0)]!.notificationId);
      } else if (e.key === 'e' && idx >= 0) {
        e.preventDefault();
        // Keep the cursor USABLE after the row leaves the list (the DASH-1
        // focus lesson): move to the neighbour before archiving.
        const next = list[idx + 1] ?? list[idx - 1];
        setCursorId(next ? next.notificationId : null);
        void archive(list[idx]!.notificationId);
      } else if (e.key === 'u' && idx >= 0) {
        e.preventDefault();
        const n = list[idx]!;
        if (n.status === 'unread') void markAsRead(n.notificationId);
        else if (n.status === 'read') void markAsUnread(n.notificationId);
      } else if (e.key === 'Enter' && idx >= 0) {
        // Enter on a focused button/link must keep activating IT. (`closest`
        // is absent when the event target is `window` itself.)
        if (el && typeof el.closest === 'function' && el.closest('button, a, [role="button"]')) return;
        const n = list[idx]!;
        const href = isSafeActionUrl(n.actionUrl) ? n.actionUrl : undefined;
        if (href && href.split(/[?#]/)[0] !== window.location.pathname) {
          e.preventDefault();
          if (n.status === 'unread') void markAsRead(n.notificationId);
          navigate(href);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [archive, markAsRead, markAsUnread, navigate]);

  // Keep the cursor visible as it moves.
  useEffect(() => {
    if (!cursorId) return;
    document.querySelector(`[data-notification-id="${escAttr(cursorId)}"]`)?.scrollIntoView?.({ block: 'nearest', behavior: scrollBehavior() });
  }, [cursorId]);

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
    <section data-walkthrough="inbox.page" className="page-stack">
      <PageHeader
        eyebrow={t('pageEyebrow')}
        title={t('pageTitle')}
        lede={t('pageLede')}
        actions={
          <>
            <Button variant="secondary" onClick={() => void markAllRead()} disabled={unreadCount === 0}>
              <CheckIcon size={13} /> {t('markAllRead')}
            </Button>
            <Button variant="secondary" onClick={() => void refresh()}>
              <RotateCwIcon size={13} /> {t('common:refresh')}
            </Button>
          </>
        }
      />
      {/* R2 IB-SP-8/9 — localized copy (no endpoint paths), and a failed FIRST
          read must not co-render the 0/0/0 band + "all clear" below. */}
      {error && (
        <Notice
          variant="error"
          // R2 review F14 — a region that MOUNTS with its text announces
          // nothing; the opt-in `announce` makes the failure audible.
          announce={notifications.length === 0 ? t('inboxLoadFailedBody') : t('inboxActionFailedBody')}
        >
          {notifications.length === 0 ? t('inboxLoadFailedBody') : t('inboxActionFailedBody')}{' '}
          <Button variant="quiet" size="sm" onClick={() => void refresh()}>{t('common:retry')}</Button>
        </Notice>
      )}
      {/* R2 IB-SP-2 — a silent SSE drop showed a normal-looking inbox that was
          stale; the store's connectionStatus finally has a consumer. */}
      {connectionStatus === 'error' ? (
        <Notice variant="warning" announce={t('staleConnectionNotice')}>{t('staleConnectionNotice')}</Notice>
      ) : null}

      <NeedsYouInbox onResolved={() => void refresh()} />

      {!(error && notifications.length === 0) && <KeyFigureBand
        figures={figures}
        activeKey={tab}
        onToggle={(key) => setTab(key as Tab)}
        ariaLabel={t('filterAriaLabel')}
      />}

      {/* R3 IB-R2-2 — the scoped bulk verbs (Notion "Archive read" / the
          in-tab read sweep), offered only when they would DO something, ONE
          request each. "Mark tab read" appears only on action-needed — on All
          it would duplicate the header's Mark-all-read. */}
      {(() => {
        const unreadInTab = tab !== 'archived' ? inTab.filter((n) => n.status === 'unread') : [];
        const readCount = notifications.filter((n) => n.status === 'read').length;
        if ((tab !== 'action-needed' || unreadInTab.length === 0) && (tab === 'archived' || readCount === 0)) return null;
        return (
          <div className="action-bar u-items-center u-gap-2 u-mb-2">
            {tab === 'action-needed' && unreadInTab.length > 0 ? (
              <Button variant="quiet" size="sm" onClick={() => void markRead(unreadInTab.map((n) => n.notificationId))}>
                <CheckIcon size={13} /> {t('markTabRead', { count: unreadInTab.length })}
              </Button>
            ) : null}
            {/* tab is provably not 'archived' past the guard above */}
            {readCount > 0 ? (
              <Button variant="quiet" size="sm" onClick={() => void archiveRead()}>
                <InboxIcon size={13} /> {t('archiveRead', { count: readCount })}
              </Button>
            ) : null}
          </div>
        );
      })()}

      {/* Offered only when it would DO something — a toggle that can only ever
          show the same list is noise. */}
      {urgentInTab > 0 && urgentInTab < inTab.length ? (
        <div className="action-bar u-items-center u-gap-2 u-mb-2">
          <button
            type="button"
            className={urgentOnly ? 'chip chip--accent' : 'chip'}
            aria-pressed={urgentOnly}
            onClick={() => setUrgentOnly((v) => !v)}
          >
            {t('urgentOnly', { count: urgentInTab })}
          </button>
          <span className="u-fs-11 muted" aria-live="polite">
            {urgentOnly ? t('urgentOnlyActive', { count: filtered.length, total: inTab.length }) : ''}
          </span>
        </div>
      ) : null}

      {loading && filtered.length === 0 && (
        <StateCard loading icon={<InboxIcon size={28} />} title={t('loadingInbox')} />
      )}
      {!loading && !(error && notifications.length === 0) && filtered.length === 0 && (
        tab === 'archived' ? (
          <StateCard
            icon={<InboxIcon size={28} />}
            title={t('emptyArchivedTitle')}
            body={t('emptyArchivedBody')}
            action={
              <Button variant="secondary" onClick={() => setTab('action-needed')}>
                {t('backToActionNeeded')}
              </Button>
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
            active={n.notificationId === focusId}
            cursor={n.notificationId === cursorId}
            cardRef={n.notificationId === focusId ? focusRef : undefined}
            onToggleRead={n.status === 'archived' ? undefined : () => {
              if (n.status === 'unread') void markAsRead(n.notificationId);
              else void markAsUnread(n.notificationId);
            }}
            onArchive={() => {
              // R2 IB-SP-10 — the DASH-1 lesson: the card under the clicked
              // button unmounts, dropping focus to <body>. Hand focus to the
              // neighbouring card (which is about to shift into this slot).
              const i = filtered.findIndex((x) => x.notificationId === n.notificationId);
              const neighbour = filtered[i + 1] ?? filtered[i - 1];
              void archive(n.notificationId);
              if (neighbour) {
                requestAnimationFrame(() => {
                  (document.querySelector(`[data-notification-id="${escAttr(neighbour.notificationId)}"]`) as HTMLElement | null)?.focus();
                });
              }
            }}
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

      <DelegationSection />
      <TeamsDeliverySection />
    </section>
  );
}

interface NotificationCardProps {
  notification: Notification;
  /** Deep-link focus target (ADR 0336 Rec Phase 3) — draws the focus ring + is
   *  the scroll anchor; the row is programmatically focused. */
  active?: boolean | undefined;
  /** R2 IB-R2-1 — the keyboard-triage cursor row. */
  cursor?: boolean | undefined;
  cardRef?: Ref<HTMLDivElement> | undefined;
  /** R2 IB-SP-12 — per-row read toggle (absent on archived rows). */
  onToggleRead?: (() => void) | undefined;
  onArchive: () => void;
  onDelete: () => void;
  onResolved: () => void;
}

function NotificationCard({
  notification,
  active,
  cursor,
  cardRef,
  onToggleRead,
  onArchive,
  onDelete,
  onResolved,
}: NotificationCardProps): JSX.Element {
  const { t } = useTranslation('notifications');
  const { pathname } = useLocation();
  const isUnread = notification.status === 'unread';
  const when = relativeLabel(notification.createdAt, t); // R2 IB-SP-7 — the ONE localized implementation
  // Prefer the entity-specific actionUrl, but never render a self-link: an
  // action-needed notification targets /inbox, which IS this page — there the
  // inline resolver below is the real affordance, so fall back to the run link.
  const actionHref = isSafeActionUrl(notification.actionUrl) ? notification.actionUrl : undefined;
  const actionIsSelf = actionHref ? actionHref.split(/[?#]/)[0] === pathname : false;
  return (
    <div
      ref={cardRef}
      data-notification-id={notification.notificationId}
      tabIndex={-1}
      aria-current={active ? 'location' : undefined}
      className={`surface-card${active ? ' is-deeplink-focus' : ''}${cursor ? ' notifpage-card--cursor' : ''}`}
    >
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
      {/* Deep-link spine: one competing link, not two — the entity-specific
          actionUrl (guarded, never a self-link) else the run link. */}
      {actionHref && !actionIsSelf ? (
        <div className="u-mb-2">
          <Link to={actionHref} className="inline-link u-fs-12">
            {t(actionLabelKeyFor(notification.type))} →
          </Link>
        </div>
      ) : notification.runId ? (
        <div className="u-mb-2">
          <Link to={`/runs/${notification.runId}`} className="inline-link u-fs-12">
            {t('cardRunLink', { id: notification.runId.slice(0, 12) })}
          </Link>
        </div>
      ) : null}

      {isActionNeeded(notification) && notification.runId && (
        <InlineInterruptResolver
          runId={notification.runId}
          interruptId={notification.interruptId}
          onResolved={onResolved}
        />
      )}

      <div className="action-bar u-justify-end u-mt-3">
        {/* R2 IB-SP-12 — clearing ONE row's unread no longer requires the
            panel or mark-all. */}
        {onToggleRead && (
          <IconButton
            label={t(isUnread ? 'rowMarkRead' : 'rowMarkUnread')}
            icon={<CheckIcon size={15} />}
            onClick={onToggleRead}
          />
        )}
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

  if (error) return <Notice variant="error">{t('interruptLoadFailed')}</Notice>; // R2 IB-SP-8
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
