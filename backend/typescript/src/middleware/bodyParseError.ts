/**
 * A malformed request body answers in the error envelope, with the version
 * header, under both majors (`errors.md`; `versioning.md` §1.4).
 *
 * MEASURED 2026-09-05 on production (corpus steward, rc.40
 * `v2-malformed-body-envelope`): `POST /runs` with body `{` → `500
 * internal_error`, no `OpenWOP-Version`. Two causes, both fixed together:
 * the JSON parsers were mounted BEFORE the negotiator, so the parse error
 * escaped the chain before the version header existed; and nothing mapped a
 * body-parser failure, so the final envelope called it internal. The peer
 * host had the identical gap (`3bf431aa4`).
 *
 * body-parser tags its errors with `type`; that field, not the message, is the
 * contract. Anything else is not ours and passes through untouched.
 */
import type { ErrorRequestHandler } from 'express';

const BY_TYPE: Readonly<Record<string, { status: number; error: string; message: string }>> = {
  'entity.parse.failed': { status: 400, error: 'validation_error', message: 'The request body is not valid JSON.' },
  'entity.verify.failed': { status: 400, error: 'validation_error', message: 'The request body failed verification.' },
  'entity.too.large': { status: 413, error: 'payload_too_large', message: 'The request body exceeds the limit for this route.' },
  'charset.unsupported': { status: 415, error: 'unsupported_media_type', message: 'The request body charset is not supported.' },
  'encoding.unsupported': { status: 415, error: 'unsupported_media_type', message: 'The request body encoding is not supported.' },
};

export function bodyParseErrorHandler(): ErrorRequestHandler {
  return (err, _req, res, next) => {
    const type = (err as { type?: unknown } | null)?.type;
    const m = typeof type === 'string' ? BY_TYPE[type] : undefined;
    if (!m || res.headersSent) { next(err); return; }
    // Flat envelope: `{ error, message, details }`. Under major 2 the negotiator's
    // `res.json` wrapper projects it onto the v2 envelope; under 1.x it is the
    // v1 shape already.
    res.status(m.status).json({ error: m.error, message: m.message, details: { type } });
  };
}
