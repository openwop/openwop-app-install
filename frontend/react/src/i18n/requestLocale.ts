/**
 * The locale to send as `Accept-Language` for CONTENT negotiation (ADR 0064).
 *
 * This is the user's CONTENT preference, NOT the resolved UI locale: an explicit
 * UI-locale choice if made, else the raw `navigator.language`. Critically it does
 * NOT collapse to a supported UI locale — a Brazilian visitor with no explicit
 * choice keeps requesting `pt-BR` content (today's behavior) even while the UI
 * chrome is English. Lightweight (no i18next import) so `client/config.ts` can
 * use it without pulling in the framework.
 */
import { LOCALE_STORAGE_KEY } from './locales.js';

export function getRequestLocale(): string | undefined {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(LOCALE_STORAGE_KEY) : null;
  if (stored) return stored;
  if (typeof navigator !== 'undefined' && navigator.language) return navigator.language;
  return undefined;
}
