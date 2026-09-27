/**
 * R2 IB-SP-7 (UX_UPGRADE-inbox) — the ONE localized relative-time label.
 *
 * The panel had this (localized, i18next-plural, locale-formatted fallback)
 * while the page + NeedsYou used a hard-coded-English `relativeTime` and even
 * did English string surgery (`.replace(' ago', '')`) — two divergent
 * implementations, one localized. Extracted verbatim from NotificationPanel;
 * every notifications surface now imports THIS.
 */
import type { TFunction } from 'i18next';
import { formatDateTime } from '../i18n/format.js';

export function relativeLabel(iso: string, t: TFunction<'notifications'>): string {
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  const m = Math.floor(diffMs / 60_000);
  const h = Math.floor(diffMs / 3_600_000);
  const d = Math.floor(diffMs / 86_400_000);
  if (m < 1) return t('notifications:relativeJustNow');
  if (m < 60) return t('notifications:relativeMinutes', { count: m });
  if (h < 24) return t('notifications:relativeHours', { count: h });
  if (d < 7) return t('notifications:relativeDays', { count: d });
  return formatDateTime(iso, { dateStyle: 'medium' });
}
