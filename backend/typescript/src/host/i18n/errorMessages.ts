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

// Localization runs BEFORE `v2ErrorCode`, so it sees the host's own envelope,
// not the SDK's post-translation one. See `types.ts` `HostErrorEnvelope`.
import type { HostErrorEnvelope } from '../../types.js';
import type { OpenwopErrorCode } from '../../types.js';

/**
 * `error` code → BCP-47 locale → human message. `pt-BR`, `es` and `fr` (the
 * non-default locales the deployments advertise; ADR 0748 added `es`/`fr` so an
 * advertised `es-419` has a catalog to fall back to). Adding a locale is adding
 * a column, not a structural change. Only stable, user-facing codes are translated — internal
 * or never-surfaced codes stay English by omission.
 */
const ERROR_MESSAGES: Partial<Record<OpenwopErrorCode, Record<string, string>>> = {
  invalid_request: { 'pt-BR': 'Requisição inválida.', es: 'Solicitud no válida.', fr: 'Requête invalide.' },
  validation_error: { 'pt-BR': 'O corpo da requisição é inválido.', es: 'El cuerpo de la solicitud no es válido.', fr: 'Le corps de la requête est invalide.' },
  unauthenticated: { 'pt-BR': 'Autenticação necessária.', es: 'Se requiere autenticación.', fr: 'Authentification requise.' },
  sign_in_required: { 'pt-BR': 'É necessário entrar para realizar esta ação.', es: 'Debes iniciar sesión para realizar esta acción.', fr: 'Vous devez vous connecter pour effectuer cette action.' },
  forbidden: { 'pt-BR': 'Você não tem permissão para realizar esta ação.', es: 'No tienes permiso para realizar esta acción.', fr: 'Vous n’avez pas l’autorisation d’effectuer cette action.' },
  forbidden_tenant: { 'pt-BR': 'Você não tem acesso a este locatário.', es: 'No tienes acceso a este inquilino.', fr: 'Vous n’avez pas accès à ce locataire.' },
  forbidden_scope: { 'pt-BR': 'Sua credencial não tem o escopo necessário para esta operação.', es: 'Tu credencial no tiene el alcance necesario para esta operación.', fr: 'Vos identifiants n’ont pas la portée requise pour cette opération.' },
  not_found: { 'pt-BR': 'Recurso não encontrado.', es: 'Recurso no encontrado.', fr: 'Ressource introuvable.' },
  workflow_not_found: { 'pt-BR': 'Fluxo de trabalho não encontrado.', es: 'Flujo de trabajo no encontrado.', fr: 'Workflow introuvable.' },
  run_not_found: { 'pt-BR': 'Execução não encontrada.', es: 'Ejecución no encontrada.', fr: 'Exécution introuvable.' },
  rate_limited: { 'pt-BR': 'Limite de requisições excedido. Tente novamente mais tarde.', es: 'Se superó el límite de solicitudes. Vuelve a intentarlo más tarde.', fr: 'Limite de requêtes dépassée. Réessayez plus tard.' },
  conflict: { 'pt-BR': 'A requisição conflita com o estado atual do recurso.', es: 'La solicitud entra en conflicto con el estado actual del recurso.', fr: 'La requête est en conflit avec l’état actuel de la ressource.' },
  internal_error: { 'pt-BR': 'Ocorreu um erro inesperado.', es: 'Se produjo un error inesperado.', fr: 'Une erreur inattendue s’est produite.' },
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
  envelope: HostErrorEnvelope,
  locale: string,
): { envelope: HostErrorEnvelope; localized: boolean } {
  const column = ERROR_MESSAGES[envelope.error as OpenwopErrorCode];
  if (!column) return { envelope, localized: false };
  // ADR 0748 — the §C chain (exact → script → language) over the catalog, so a
  // negotiated `es-419` is answered from `es`. The marker names the column
  // ACTUALLY used, never the negotiated tag: `Content-Language: es` is true of
  // Spanish text, `es-419` would claim a regional variant nobody wrote.
  const used = catalogLocale(Object.keys(column), locale);
  const message = used ? column[used] : undefined;
  if (!used || !message) return { envelope, localized: false };
  return {
    envelope: {
      ...envelope,
      message,
      details: { ...(envelope.details ?? {}), locale: used },
    },
    localized: true,
  };
}

/** The catalog column serving `locale`: exact, then the `ll-Ssss` script
 *  family, then the bare language — the same truncation order as
 *  `resolveSection`. Null when none exists. */
function catalogLocale(columns: readonly string[], locale: string): string | null {
  if (columns.includes(locale)) return locale;
  const parts = locale.split('-');
  if (parts.length >= 3 && /^[A-Za-z]{4}$/.test(parts[1] ?? '')) {
    const script = `${parts[0]}-${parts[1]}`;
    if (columns.includes(script)) return script;
  }
  if (parts.length >= 2 && parts[0] && columns.includes(parts[0])) return parts[0];
  return null;
}
