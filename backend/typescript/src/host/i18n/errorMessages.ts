/**
 * Localized error-envelope messages (ADR 0143) — the `code → locale → message`
 * catalog + the pure projector the error formatter calls.
 *
 * Rides the Stable `i18n.md` annex (v1.1) + RFC 0103: a host MAY localize the
 * human `message` of an `ErrorEnvelope` for the request's negotiated locale, and
 * when it does it sets `Content-Language` (the middleware) AND `details.locale`
 * (here) — the annex's normative marker — to the locale actually used. The
 * machine-readable `error` code and HTTP status NEVER change (codes are
 * identifiers, not human text; annex §"`locale` field on `ErrorEnvelope.details`").
 *
 * Core-shared (ADR 0001): imports nothing under `features/`. The catalog is typed
 * to the closed `OpenwopErrorCode` union, so a typo'd/renamed code is a COMPILE
 * error; coverage is intentionally partial (only stable, user-facing codes) and a
 * code with no entry falls back to the English `message` with no markers set.
 *
 * Security invariant (ADR 0143): every entry is a STATIC, parameter-free constant
 * — it never interpolates `message`/`details`. Localization runs AFTER the
 * credential-scrub in `errorEnvelopeMiddleware`, so it cannot re-open the
 * leak channel. Any future interpolated string MUST interpolate only
 * already-scrubbed values.
 */

import type { ErrorEnvelope } from '@openwop/openwop';
import type { OpenwopErrorCode } from '../../types.js';

/**
 * `error` code → BCP-47 locale → human message. pt-BR only for now (the
 * end-to-end-validated locale); adding a locale is adding a column, not a
 * structural change. Only stable, user-facing codes are translated — internal
 * or never-surfaced codes stay English by omission.
 */
const ERROR_MESSAGES: Partial<Record<OpenwopErrorCode, Record<string, string>>> = {
  invalid_request: { 'pt-BR': 'Requisição inválida.' },
  validation_error: { 'pt-BR': 'O corpo da requisição é inválido.' },
  unauthenticated: { 'pt-BR': 'Autenticação necessária.' },
  sign_in_required: { 'pt-BR': 'É necessário entrar para realizar esta ação.' },
  forbidden: { 'pt-BR': 'Você não tem permissão para realizar esta ação.' },
  forbidden_tenant: { 'pt-BR': 'Você não tem acesso a este locatário.' },
  forbidden_scope: { 'pt-BR': 'Sua credencial não tem o escopo necessário para esta operação.' },
  not_found: { 'pt-BR': 'Recurso não encontrado.' },
  workflow_not_found: { 'pt-BR': 'Fluxo de trabalho não encontrado.' },
  run_not_found: { 'pt-BR': 'Execução não encontrada.' },
  rate_limited: { 'pt-BR': 'Limite de requisições excedido. Tente novamente mais tarde.' },
  conflict: { 'pt-BR': 'A requisição conflita com o estado atual do recurso.' },
  internal_error: { 'pt-BR': 'Ocorreu um erro inesperado.' },
};

/**
 * Project `envelope` into `locale`. Pure: returns a NEW envelope, never mutates
 * the input, reads no env.
 *
 * - `localized: true` only when the (code, locale) pair has a catalog entry. The
 *   returned envelope then carries the translated `message` and `details.locale`
 *   set to `locale`; the caller sets `Content-Language` to match.
 * - `localized: false` (envelope returned unchanged) when the code has no entry
 *   for `locale` — including the host default locale, which has no catalog
 *   entries by construction. The caller then sets NO `Content-Language` /
 *   `details.locale`, so neither marker ever claims a localization that didn't
 *   happen.
 */
export function localizeErrorEnvelope(
  envelope: ErrorEnvelope,
  locale: string,
): { envelope: ErrorEnvelope; localized: boolean } {
  const message = ERROR_MESSAGES[envelope.error as OpenwopErrorCode]?.[locale];
  if (!message) return { envelope, localized: false };
  return {
    envelope: {
      ...envelope,
      message,
      details: { ...(envelope.details ?? {}), locale },
    },
    localized: true,
  };
}
