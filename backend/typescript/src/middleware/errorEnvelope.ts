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
import type { ErrorEnvelope } from '@openwop/openwop';
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
function emitEnvelope(req: Request, res: Response, status: number, envelope: ErrorEnvelope): void {
  if (hostI18nEnabled()) {
    const locale = negotiateLocale(
      req.header('accept-language'),
      hostSupportedLocales(),
      hostDefaultLocale(),
    );
    const { envelope: out, localized } = localizeErrorEnvelope(envelope, locale);
    if (localized) res.setHeader('Content-Language', locale);
    res.status(status).json(out);
    return;
  }
  res.status(status).json(envelope);
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
      const scrubbed: ErrorEnvelope = {
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
