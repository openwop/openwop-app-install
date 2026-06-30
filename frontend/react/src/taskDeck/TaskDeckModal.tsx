/**
 * ADR 0133 Phase 4 — the task-deck modal body (default-exported so the chat header
 * LAZY-loads it: only the small gate+button is in the entry chunk). A read-only
 * board of the caller's runs + delegated sub-runs, bucketed by status. Each card
 * carries a LABELED status chip (text + chip semantic, never color-alone, DESIGN
 * §5.3); blocked cards surface their reason. Backend is authority + tenant/owner
 * scoped, so this is purely presentational.
 *
 * @see docs/adr/0133-run-task-deck.md
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal.js';
import { getTaskDeck, TASK_BUCKETS, type TaskBucket, type TaskCard, type TaskDeck } from './taskDeckClient.js';

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

export default function TaskDeckModal({ conversationRunId, onClose }: { conversationRunId?: string; onClose: () => void }): JSX.Element {
  const { t } = useTranslation('taskDeck');
  const [deck, setDeck] = useState<TaskDeck | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getTaskDeck(conversationRunId)
      .then((d) => { if (!cancelled) setDeck(d); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : t('loadFailed')); });
    return () => { cancelled = true; };
  }, [conversationRunId, t]);

  const label = (b: TaskBucket): string => t(`bucket_${b}`);
  const total = deck ? TASK_BUCKETS.reduce((n, b) => n + deck.buckets[b].length, 0) : 0;

  return (
    <Modal label={t('openTitle')} onClose={onClose} className="surface-card" loading={deck === null && !error} error={error ?? undefined}>
      <h2 className="u-fs-15">{t('heading')}</h2>
      <p className="muted u-fs-12">{t('blurb')}</p>
      {deck && total === 0 && <p className="muted u-fs-12 u-mt-2">{t('empty')}</p>}
      <div className="taskdeck-buckets u-flex u-flex-col u-gap-3 u-mt-2">
        {deck && TASK_BUCKETS.filter((b) => deck.buckets[b].length > 0).map((b) => (
          <section key={b} aria-labelledby={`td-col-${b}`}>
            <h3 id={`td-col-${b}`} className="u-fs-13 u-flex u-items-center u-gap-1">
              <span className={`chip ${CHIP_BY_BUCKET[b]} u-fs-11`}>{label(b)}</span>
              <span className="muted u-fs-11">{deck.buckets[b].length}</span>
            </h3>
            <ul className="u-list-none u-p-0 u-flex u-flex-col u-gap-1 u-mt-1">
              {deck.buckets[b].map((card) => <TaskCardRow key={card.runId} card={card} chipLabel={label} />)}
            </ul>
          </section>
        ))}
      </div>
      <div className="action-bar u-mt-3">
        <button type="button" className="secondary" onClick={onClose}>{t('close')}</button>
      </div>
    </Modal>
  );
}

function TaskCardRow({ card, chipLabel, depth = 0 }: { card: TaskCard; chipLabel: (b: TaskBucket) => string; depth?: number }): JSX.Element {
  const { t } = useTranslation('taskDeck');
  return (
    <li className={depth > 0 ? 'u-ml-3' : undefined}>
      <div className="surface-card u-pad-2 u-flex u-flex-col u-gap-1">
        <div className="u-flex u-items-center u-justify-between u-gap-2">
          <span className="u-fs-12 u-fw-600 u-truncate">{card.title}</span>
          {/* Labeled status chip — text + semantic colour, never colour-alone (§5.3). */}
          <span className={`chip ${CHIP_BY_BUCKET[card.status]} u-fs-11`}>{chipLabel(card.status)}</span>
        </div>
        {card.delegatedBy && <span className="muted u-fs-11">{t('delegatedBy', { by: card.delegatedBy })}</span>}
        {card.blockedReason && <span className="muted u-fs-11">{t('blockedReason', { reason: card.blockedReason })}</span>}
        <code className="muted u-fs-11">{card.runId}</code>
      </div>
      {card.children.length > 0 && (
        <ul className="u-list-none u-p-0 u-flex u-flex-col u-gap-1 u-mt-1">
          {card.children.map((child) => <TaskCardRow key={child.runId} card={child} chipLabel={chipLabel} depth={depth + 1} />)}
        </ul>
      )}
    </li>
  );
}
