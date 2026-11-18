/**
 * ADR 1138 D3 — a card's due date, with its state said in words, not colour
 * alone: "Overdue · <date>" once the date has passed, "Due soon · <date>" inside
 * two days, the plain "due <date>" otherwise. A finished card shows its date
 * plainly (it can't be late any more). Shared by the board card and the
 * "Assigned to me" mirror so both read the same.
 */

import { useTranslation } from 'react-i18next';

export const DUE_SOON_MS = 2 * 24 * 60 * 60 * 1000;

export type DueState = 'overdue' | 'soon' | 'later';

/** Pure, for tests: where `dueAt` stands relative to `now`. */
export function dueStateOf(dueAt: string, now: number): DueState | null {
  const due = Date.parse(dueAt);
  if (Number.isNaN(due)) return null;
  if (due < now) return 'overdue';
  return due - now <= DUE_SOON_MS ? 'soon' : 'later';
}

export function CardDue({ dueAt, finished, now = Date.now() }: { dueAt: string; finished: boolean; now?: number }): JSX.Element | null {
  const { t } = useTranslation('kanban');
  const state = dueStateOf(dueAt, now);
  if (!state) return null;
  const date = dueAt.slice(0, 10);
  if (finished || state === 'later') return <span className="muted u-fs-12">{t('dueDate', { date })}</span>;
  return state === 'overdue'
    ? <span className="chip chip--danger">{t('dueOverdue', { date })}</span>
    : <span className="chip chip--warning">{t('dueSoon', { date })}</span>;
}
