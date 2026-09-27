/**
 * KTUX-10 — one classification, localized once.
 *
 * The app already ships `client/classifyHttpError.ts`, and KickTodo used none
 * of it: every page hand-rolled an undifferentiated "something went wrong",
 * so a rate-limit, an expired session and a real outage were indistinguishable
 * to the user and no message told them what to DO.
 *
 * Adopting `classifyHttpError` wholesale would have been worse than not
 * adopting it: it returns hardcoded ENGLISH copy (`title: 'Too many
 * requests'`), and KickTodo ships four locales. Dropping those strings into
 * these pages would push untranslated English into es/fr/pt-BR while
 * `check-i18n` stayed green — that gate verifies KEY parity, not language.
 *
 * So we take the `kind` DISCRIMINATOR (the part worth sharing) and map it to
 * the `common:` catalog (the part that must be localized). Feature-specific
 * statuses stay with the feature: a caller that gives 403 a domain meaning
 * MUST handle it before falling through here.
 *
 * UX_UPGRADE-projects R2 — MOVED here from `features/kicktodo/loadError.ts`.
 * Nothing about it was ever KickTodo-specific (`src/auth/` was already
 * importing across the feature boundary to reach it), and leaving it there is
 * what made the next feature that needed it — projects, which was rendering
 * `getProject failed (403)` at users in all four locales — hand-roll its own
 * instead. It sits beside `classifyHttpError`, the discriminator it wraps.
 */
import { classifyHttpError } from './classifyHttpError.js';

type TFn = (key: string) => string;

/**
 * The localized message for a load failure. The template literal is inside the
 * `t()` call ON PURPOSE: it lets `check-i18n` harvest `error_` as a constructed
 * prefix, so the six `common:error_*` keys are recognized as referenced rather
 * than flagged as orphans (the codebase's `prop_${name}` convention).
 */
export function loadErrorMessage(t: TFn, err: unknown): string {
  return t(`common:error_${classifyHttpError(err).kind}`);
}

/** True when retrying could plausibly succeed — drives whether we offer a retry. */
export function isRetryable(err: unknown): boolean {
  return classifyHttpError(err).retryable;
}
