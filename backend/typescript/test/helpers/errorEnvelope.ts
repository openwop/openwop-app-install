/**
 * Strict readers for THIS host's HTTP error envelope (H27 / S22 /
 * `spec/v1/rest-endpoints.md` §"Error response shape").
 *
 * Deliberately STRICTER than the conformance corpus's
 * `@openwop/openwop-conformance` `readErrorCode` / `readRetriable`: those
 * tolerate the legacy nested `{ error: { code, retriable } }` shape through the
 * deprecation window ending with the first suite minor after 2026-11-10, because
 * they read OTHER hosts. These read OUR host, where the window is already over —
 * a nested body here is a regression, and a tolerant reader would let it back in
 * silently. That is exactly how the drift lasted two months.
 *
 * `assertFlatErrorEnvelope` is the shape assertion; `errorCodeOf` /
 * `retriableOf` are the field reads, and each returns `undefined` (never a
 * nested fallback) so an inverted assertion fails loudly rather than passing on
 * the shape it was written to reject.
 */

export interface FlatErrorEnvelope {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

/** The code, read ONLY from the canonical flat `error`. A nested body yields
 *  `undefined`, which is the point. */
export function errorCodeOf(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const e = (body as { error?: unknown }).error;
  return typeof e === 'string' && e.length > 0 ? e : undefined;
}

/** `details.retriable`, read ONLY from the canonical location. */
export function retriableOf(body: unknown): boolean | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const d = (body as { details?: unknown }).details;
  if (d === null || typeof d !== 'object') return undefined;
  const r = (d as { retriable?: unknown }).retriable;
  return typeof r === 'boolean' ? r : undefined;
}

/** One `details` field, read ONLY from the canonical location. */
export function detailOf(body: unknown, key: string): unknown {
  if (body === null || typeof body !== 'object') return undefined;
  const d = (body as { details?: unknown }).details;
  if (d === null || typeof d !== 'object') return undefined;
  return (d as Record<string, unknown>)[key];
}

/**
 * Assert a response body is the canonical flat envelope and return it typed:
 * `error` + `message` non-empty strings, `details` an object when present, and
 * NO top-level key outside `{error, message, details}` (the schema's
 * `additionalProperties: false`). Throws with the offending body on failure.
 */
export function assertFlatErrorEnvelope(body: unknown, ctx = 'error body'): FlatErrorEnvelope {
  const seen = JSON.stringify(body);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`${ctx}: expected an object, got ${seen}`);
  }
  const b = body as Record<string, unknown>;
  if (typeof b.error !== 'string' || b.error.length === 0) {
    throw new Error(
      `${ctx}: \`error\` MUST be a non-empty CODE STRING (the canonical flat envelope), got ${seen}`,
    );
  }
  if (typeof b.message !== 'string' || b.message.length === 0) {
    throw new Error(`${ctx}: \`message\` MUST be a non-empty string, got ${seen}`);
  }
  for (const k of Object.keys(b)) {
    if (k !== 'error' && k !== 'message' && k !== 'details') {
      throw new Error(
        `${ctx}: unexpected top-level key \`${k}\` — error-envelope.schema.json is additionalProperties:false, so contextual data belongs under \`details\`. Got ${seen}`,
      );
    }
  }
  if (b.details !== undefined && (b.details === null || typeof b.details !== 'object' || Array.isArray(b.details))) {
    throw new Error(`${ctx}: \`details\` MUST be an object when present, got ${seen}`);
  }
  return b as unknown as FlatErrorEnvelope;
}
