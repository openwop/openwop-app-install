/**
 * Core-shared i18n infra (ADR 0064) — locale negotiation + the normative
 * per-section field merge. Imports nothing under `features/`; features import
 * THIS (ADR 0001 boundary: features may use core; core must not use features).
 */

export { resolveSection, type LocalizableSection } from './resolveSection.js';
export {
  negotiateLocale,
  LOCALE_RE,
  hostDefaultLocale,
  hostSupportedLocales,
  hostI18nEnabled,
} from './locale.js';
export { localizeErrorEnvelope } from './errorMessages.js';
