/**
 * ADR 0151 / `ATU-1` — the auto-titler's live rail/tab swap, PLUS the screen-reader
 * announcement the swap used to lack. One helper so the witness proves both halves
 * together (mechanism ≠ wiring: the hook calls exactly this, one line).
 *
 * Polite, not assertive: a rename is information, not an alert. The message carries
 * the new title so the user hears WHAT it became, not just that something changed.
 */
import i18n from '../../i18n/index.js';
import { announce } from '../../ui/announce.js';

export function applyAutoTitle<S extends { title: string }>(
  title: string,
  setSession: (updater: (s: S) => S) => void,
): void {
  setSession((s) => ({ ...s, title }));
  announce(i18n.t('chat:conversationRenamed', { title }));
}
