/**
 * ADR 0133 Phase 4 + ADR 0902 D7 — the task-deck modal body (default-exported so
 * the chat header LAZY-loads it: only the small button is in the entry chunk). A
 * read-only board of the caller's runs + the work they delegated, bucketed by
 * status. Each card carries a LABELED status chip (text + chip semantic, never
 * color-alone, DESIGN §5.3) and leads somewhere a viewer can follow (ADR 0844 D4):
 * its conversation, the Inbox for a blocker, and the run page only for a caller
 * who may open it. Backend is authority + owner scoped, so this is presentational.
 *
 * @see docs/adr/0133-run-task-deck.md
 * @see docs/adr/0902-task-deck-ownership-and-linkage.md
 */
import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Modal } from '../ui/Modal.js';
import { Notice } from '../ui/Notice.js';
import { formatDateTime, formatRelativeTime } from '../i18n/format.js';
import { runDetailPath, useCanOpenRunDetail } from '../chat/runDetailAccess.js';
import { bucketCount, getTaskDeck, hasActiveWork, TASK_BUCKETS, type TaskBucket, type TaskCard, type TaskDeck } from './taskDeckClient.js';

/** Map a bucket → a chip semantic (the visual cue) — always paired with the text
 *  label below it, so status is never conveyed by color alone. */
const CHIP_BY_BUCKET: Record<TaskBucket, string> = {
  pending: 'chip--muted',
  running: 'chip--accent',
  blocked: 'chip--warning',
  delegated: 'chip--ai',
  completed: 'chip--success',
  failed: 'chip--danger',
};

/** ADR 0902 D7 (architect A5) — the interrupt kinds with their own wording;
 *  every other kind reads as a generic wait. */
const WAIT_KINDS = new Set(['approval', 'clarification', 'external-event', 'timer', 'credential']);
/** TD2UX-10 — the kinds a person resolves from their Inbox. A timer or an outside
 *  event has nothing there to act on, so it gets no "See what needs you" link. */
const INBOX_KINDS = new Set(['approval', 'clarification']);

/** Re-poll cadence while the deck is open, visible and still has live work (A2). */
const POLL_MS = 30_000;

export default function TaskDeckModal({ conversationRunId, onClose }: { conversationRunId?: string; onClose: () => void }): JSX.Element {
  const { t } = useTranslation('taskDeck');
  const [deck, setDeck] = useState<TaskDeck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const alive = useRef(true);
  // TD2CD-6 — one read at a time: a poll tick during a manual refresh is skipped,
  // so an older response can never overwrite a newer one.
  const inFlight = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const d = await getTaskDeck(conversationRunId);
      if (alive.current) { setDeck(d); setError(null); }
    } catch {
      // TD2UX-5 — the user-facing sentence, never the client's raw status text.
      if (alive.current) setError(t('loadFailed'));
    } finally {
      inFlight.current = false;
      if (alive.current) setRefreshing(false);
    }
  }, [conversationRunId, t]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; };
  }, [load]);

  // Poll only while there is something that can still change, and only when the
  // tab is visible — a deck of finished work costs the server nothing.
  const active = deck !== null && hasActiveWork(deck);
  useEffect(() => {
    if (!active) return undefined;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    // TD2UX-16 — coming back to the tab reads at once rather than up to 30 s later.
    const onVisible = (): void => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, [active, load]);

  const label = (b: TaskBucket): string => t(`bucket_${b}`);
  const total = deck ? TASK_BUCKETS.reduce((n, b) => n + bucketCount(deck, b), 0) : 0;

  return (
    <Modal label={t('openTitle')} onClose={onClose} loading={deck === null && !error} error={deck === null ? (error ?? undefined) : undefined} errorAnnounce={deck === null && error ? error : undefined}>
      <div className="u-flex u-items-center u-justify-between u-gap-2">
        <h2 className="u-fs-15">{t('heading')}</h2>
        {/* TD2UX-1 — never `disabled`: disabling the focused button on every poll
            dropped focus to <body> and let Tab escape the dialog. `load` guards. */}
        <Button variant="secondary" className="u-fs-11" onClick={() => void load()} aria-busy={refreshing}>
          {refreshing ? t('refreshing') : t('refresh')}
        </Button>
      </div>
      <p className="muted u-fs-12">{t('blurb')}</p>
      {/* A refresh that failed after a good load keeps the last deck on screen and says so. */}
      {deck && error && <Notice variant="warning" announce={t('refreshFailed')}>{t('refreshFailed')}</Notice>}
      {deck?.truncated && <p className="muted u-fs-12 u-mt-1">{t('truncated')}</p>}
      {deck && total === 0 && <p className="muted u-fs-12 u-mt-2">{t('empty')}</p>}
      <div className="taskdeck-buckets u-flex u-flex-col u-gap-3 u-mt-2">
        {deck && TASK_BUCKETS.filter((b) => bucketCount(deck, b) > 0).map((b) => {
          const shown = deck.buckets[b].length;
          const count = bucketCount(deck, b);
          return (
            <section key={b} aria-labelledby={`td-col-${b}`}>
              <h3 id={`td-col-${b}`} className="u-fs-13 u-flex u-items-center u-gap-1">
                <span className={`chip ${CHIP_BY_BUCKET[b]} u-fs-11`}>{label(b)}</span>
                <span className="muted u-fs-11">{count}</span>
              </h3>
              <ul className="u-list-none u-p-0 u-flex u-flex-col u-gap-1 u-mt-1">
                {deck.buckets[b].map((card) => <TaskCardRow key={card.runId} card={card} chipLabel={label} onNavigate={onClose} />)}
              </ul>
              {count > shown && <p className="muted u-fs-11 u-mt-1">{t('showingOf', { shown, count })}</p>}
            </section>
          );
        })}
      </div>
      <div className="action-bar u-mt-3">
        <Button variant="secondary" onClick={onClose}>{t('close')}</Button>
      </div>
    </Modal>
  );
}

function TaskCardRow({ card, chipLabel, onNavigate, depth = 0 }: { card: TaskCard; chipLabel: (b: TaskBucket) => string; onNavigate: () => void; depth?: number }): JSX.Element {
  const { t } = useTranslation('taskDeck');
  const canOpenRun = useCanOpenRunDetail();
  const waitKey = card.blockedReason && WAIT_KINDS.has(card.blockedReason) ? `wait_${card.blockedReason}` : 'wait_other';
  const updated = formatRelativeTime(card.updatedAt);
  return (
    <li className={depth > 0 ? 'u-ml-3' : undefined}>
      <div className="surface-card u-pad-2 u-flex u-flex-col u-gap-1">
        <div className="u-flex u-items-center u-justify-between u-gap-2">
          <span className="u-fs-12 u-fw-600 u-truncate" title={card.title}>{card.title}</span>
          {/* Labeled status chip — text + semantic colour, never colour-alone (§5.3). */}
          {card.cancelled
            ? <span className="chip chip--muted u-fs-11">{t('cancelled')}</span>
            : <span className={`chip ${CHIP_BY_BUCKET[card.status]} u-fs-11`}>{chipLabel(card.status)}</span>}
        </div>
        {card.status === 'blocked' && <span className="muted u-fs-11">{t(waitKey)}</span>}
        {card.delegatedBy && <span className="muted u-fs-11">{t('delegatedBy', { by: card.delegatedBy })}</span>}
        <span className="muted u-fs-11">
          <time dateTime={card.updatedAt} title={formatDateTime(card.updatedAt)}>{t('updated', { when: updated })}</time>
        </span>
        <span className="u-flex u-flex-wrap u-gap-2 u-fs-11">
          {card.conversationId && (
            <Link className="inline-link" to={`/chat?conversation=${encodeURIComponent(card.conversationId)}`} onClick={onNavigate}>{t('openConversation')}</Link>
          )}
          {/* A blocker without a conversation: the Inbox is where approvals and blockers land (A4). */}
          {card.status === 'blocked' && !card.conversationId && card.blockedReason !== undefined && INBOX_KINDS.has(card.blockedReason) && (
            <Link className="inline-link" to="/inbox" onClick={onNavigate}>{t('openInbox')}</Link>
          )}
          {canOpenRun && (
            <Link className="inline-link" to={runDetailPath(card.runId)} onClick={onNavigate}>{t('openRun')}</Link>
          )}
        </span>
      </div>
      {card.children.length > 0 && (
        <ul className="u-list-none u-p-0 u-flex u-flex-col u-gap-1 u-mt-1" aria-label={t('delegatedFrom', { title: card.title })}>
          {card.children.map((child) => <TaskCardRow key={child.runId} card={child} chipLabel={chipLabel} onNavigate={onNavigate} depth={depth + 1} />)}
        </ul>
      )}
    </li>
  );
}
