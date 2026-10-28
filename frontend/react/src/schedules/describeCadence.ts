/**
 * ADR 0985 D7 — humanize a stored 5-field cron for a schedule list: every shape the
 * schedule pickers compose (hourly on the hour, daily / weekdays / one weekday at a
 * time); anything else is shown verbatim. Pure, and free of any i18n namespace:
 * each caller passes its own labels, so the channel panel (`chat`) and the
 * Scheduled chats page (`scheduled-chats`) share the parsing without importing each
 * other's chunk.
 */
import { formatTime, formatWeekday } from '../i18n/format.js';

export interface CadenceLabels {
  hourly: () => string;
  daily: (time: string) => string;
  weekdays: (time: string) => string;
  weekly: (day: string, time: string) => string;
}

export function describeCadence(cron: string, labels: CadenceLabels): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [m, h, dom, mon, dw] = parts as [string, string, string, string, string];
  if (dom !== '*' || mon !== '*') return cron;
  if (h === '*') return m === '0' && dw === '*' ? labels.hourly() : cron; // only the on-the-hour shape the pickers emit
  const mi = Number(m), hi = Number(h);
  if (!Number.isInteger(mi) || mi < 0 || mi > 59 || !Number.isInteger(hi) || hi < 0 || hi > 23) return cron;
  const clock = formatTime(new Date(2000, 0, 1, hi, mi));
  if (dw === '*') return labels.daily(clock);
  if (dw === '1-5') return labels.weekdays(clock);
  if (/^[0-7]$/.test(dw)) return labels.weekly(formatWeekday(Number(dw) % 7), clock);
  return cron;
}
