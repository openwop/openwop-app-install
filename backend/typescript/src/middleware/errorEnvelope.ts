/**
 * Final error-envelope formatter. Catches OpenwopError + thrown
 * unknowns and returns the canonical openwop ErrorEnvelope shape per
 * spec/v1/rest-endpoints.md §"Error envelope".
 *
 * Locale (ADR 0143 / i18n.md annex): when the host advertises i18n
 * (`hostI18nEnabled()`), the human `message` is localized to the request's
 * negotiated `Accept-Language` and `Content-Language` + `details.locale` are set
 * to the locale ACTUALLY used. Negotiation happens here, at format time (no
 * app-wide middleware): the projection is request-scoped, never stamped on a run,
 * so replay/fork localize independently. Localization runs AFTER the
 * credential-scrub below, so it cannot re-open the leak channel.
 */

import type { ErrorRequestHandler, Request, Response } from 'express';
import type { HostErrorEnvelope } from '../types.js';
import { OpenwopError } from '../types.js';
import { createLogger } from '../observability/logger.js';
import { sanitizeForErrorMessage, sanitizeDetails } from './sanitize.js';
import {
  hostI18nEnabled,
  hostSupportedLocales,
  hostDefaultLocale,
  negotiateLocale,
  localizeErrorEnvelope,
} from '../host/i18n/index.js';

const log = createLogger('error-envelope');

/**
 * Emit an (already-scrubbed) envelope, localizing the `message` for the request's
 * negotiated locale when i18n is enabled. `Content-Language` + `details.locale`
 * are set only when a translation was actually applied — never merely requested.
 */
function emitEnvelope(req: Request, res: Response, status: number, envelope: HostErrorEnvelope): void {
  if (hostI18nEnabled()) {
    const locale = negotiateLocale(
      req.header('accept-language'),
      hostSupportedLocales(),
      hostDefaultLocale(),
    );
    const { envelope: out, localized } = localizeErrorEnvelope(envelope, locale);
    // The catalog column actually used (ADR 0748: `es-419` is answered from `es`),
    // so the header and `details.locale` can never disagree.
    if (localized) res.setHeader('Content-Language', String(out.details?.locale ?? locale));
    res.status(status).json(out);
    return;
  }
  res.status(status).json(envelope);
}

/**
 * Emit the canonical FLAT error envelope from an inline route handler
 * (H27 / S22 / `spec/v1/rest-endpoints.md` §"Error response shape").
 *
 * The middleware above is the flat-envelope owner for THROWN errors. Route
 * handlers that answer inline — a validation guard, a seam that must not
 * unwind, a 404 with no exception to raise — go through here instead of
 * hand-building a body, so there is exactly ONE envelope shape in the host.
 *
 * Between 2026-06 and 2026-08 a NESTED `{ error: { code, message, retriable } }`
 * form drifted into ~92 inline sites (it was prescribed by four seam contracts
 * and a few code-list entries in `rest-endpoints.md` itself). S22 settled it:
 * `schemas/error-envelope.schema.json` is authoritative, `error` is a STRING,
 * and `additionalProperties: false` means every extra fact — `retriable`,
 * `retryAfter`, `provider`, `protocol` — lives under `details`, never at a new
 * top level and never inside `error`.
 *
 * `code` is deliberately a plain `string`, not `OpenwopErrorCode`: several seams
 * emit host-extension codes (`sandbox_pack_not_found`, `realtime_provider_error`,
 * `nothing_to_compact`) that are not in the closed union, and widening that union
 * is a separate decision from fixing the wire shape.
 *
 * Scrub + locale negotiation are identical to the thrown path — the same
 * credential scrub, the same `Content-Language` + `details.locale` stamping —
 * because an inline 4xx echoes user input just as readily as a thrown one.
 */
export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  if (res.headersSent) return;
  const envelope: HostErrorEnvelope = {
    error: code,
    message: sanitizeForErrorMessage(message),
    ...(details ? { details: sanitizeDetails(details) } : {}),
  };
  emitEnvelope(res.req, res, status, envelope);
}

export function errorEnvelopeMiddleware(): ErrorRequestHandler {
  // The 4-arg signature is required for express to recognize this as
  // an error-handling middleware. _next stays unused.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (err, req, res, _next) => {
    if (res.headersSent) return;
    if (err instanceof OpenwopError) {
      // Defense-in-depth: scrub credential-shaped substrings from the
      // outgoing message + details so user input can't weaponize the
      // error envelope as a leak channel.
      const env = err.toEnvelope();
      const scrubbed: HostErrorEnvelope = {
        ...env,
        message: sanitizeForErrorMessage(env.message ?? ''),
        ...(env.details ? { details: sanitizeDetails(env.details) } : {}),
      };
      emitEnvelope(req, res, err.httpStatus, scrubbed);
      return;
    }
    log.error('unhandled error', {
      path: req.path,
      method: req.method,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    emitEnvelope(req, res, 500, {
      error: 'internal_error',
      message: 'An unexpected error occurred.',
    });
  };
}
