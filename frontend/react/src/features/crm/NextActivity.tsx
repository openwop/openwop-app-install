/**
 * ADR 0837 D8 (implements ADR 0567 D2) — a deal's next-activity marker. Every
 * open deal shows its next open task, or says plainly that it has none; a next
 * task whose due date has passed is OVERDUE (the "rotting" deal). The marker is
 * never colour alone: it always carries text and an icon.
 *
 * `dueDate` arrives as the calendar date the task's due date starts with (the
 * server's `dueDay`), so it is compared as a calendar date against the VIEWER'S
 * local today — never parsed as a UTC instant, which would shift it a day for
 * anyone west of Greenwich.
 */
import { useTranslation } from 'react-i18next';
import { AlertIcon, CalendarIcon } from '../../ui/icons/index.js';
import type { Deal } from './crmOrgClient.js';

/** The viewer's local calendar date, `YYYY-MM-DD`. */
export function localToday(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Whole days from `from` to `to` (both `YYYY-MM-DD`), DST-proof (UTC noon). */
export function daysBetween(from: string, to: string): number {
  const at = (d: string): number => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)), 12);
  return Math.round((at(to) - at(from)) / 86_400_000);
}

export function NextActivity({ deal, today = localToday() }: { deal: Pick<Deal, 'status' | 'nextTask'>; today?: string }): JSX.Element | null {
  const { t } = useTranslation('crm');
  if (deal.status === 'won' || deal.status === 'lost' || deal.nextTask === undefined) return null;
  // CRM2UX-8 — a long task title is truncated (full text on hover) so the card
  // keeps one line for its marker; the due label stays visible.
  const next = deal.nextTask;
  if (next === null) {
    return (
      <div className="u-flex u-items-center u-gap-1 muted u-fs-12">
        <CalendarIcon size={12} aria-hidden /> {t('noNextActivity')}
      </div>
    );
  }
  const days = next.dueDate ? daysBetween(today, next.dueDate) : null;
  const when = days === null ? t('dueUndated')
    : days < 0 ? t('overdueDays', { count: -days })
    : days === 0 ? t('dueToday')
    : days === 1 ? t('dueTomorrow')
    : t('dueInDays', { count: days });
  if (days !== null && days < 0) {
    return (
      <div className="u-flex u-items-center u-gap-1 u-text-danger u-fs-12">
        <AlertIcon size={12} aria-hidden /> <span className="u-truncate u-min-w-0" title={next.title}>{t('rottingActivity', { title: next.title })}</span>
        <span className="u-flex-auto">· {when}</span>
      </div>
    );
  }
  return (
    <div className="u-flex u-items-center u-gap-1 muted u-fs-12">
      <CalendarIcon size={12} aria-hidden /> <span className="u-truncate u-min-w-0" title={next.title}>{t('nextActivity', { title: next.title })}</span>
      <span className="u-flex-auto">· {when}</span>
    </div>
  );
}
