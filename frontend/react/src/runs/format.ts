import i18n from '../i18n/index.js';
import { formatNumber } from '../i18n/format.js';

/** Human-readable duration from milliseconds. Shared by the §A2 run-analytics surfaces. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return i18n.t('runs:durationMs', { n: formatNumber(Math.round(ms)) });
  const s = ms / 1000;
  if (s < 60)
    return i18n.t('runs:durationSeconds', {
      n: formatNumber(s, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    });
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return i18n.t('runs:durationMinutes', { m: formatNumber(m), s: formatNumber(rem) });
}
