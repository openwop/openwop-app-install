/**
 * R2 IB-SP-5 (UX_UPGRADE-inbox) — the ONE priority→chip mapping. Round 1
 * shipped it on the page only; the PANEL (the glance surface, where urgency
 * matters most) rendered urgent and low indistinguishably.
 */
import type { NotificationPriority } from './types.js';

export function priorityChip(priority: NotificationPriority, t: (k: string) => string): JSX.Element | null {
  switch (priority) {
    case 'urgent':
      return <span className="chip chip--danger">{t('notifications:priorityUrgent')}</span>;
    case 'high':
      return <span className="chip chip--warning">{t('notifications:priorityHigh')}</span>;
    case 'low':
      return <span className="chip chip--muted">{t('notifications:priorityLow')}</span>;
    default:
      return null;
  }
}
