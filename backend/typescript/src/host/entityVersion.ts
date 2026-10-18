/**
 * ADR 0775 P4 (`ARWF-11`) — optimistic concurrency for agent-area edits.
 *
 * An entity's version is a content hash of its stored row, not its `updatedAt`:
 * two edits inside one millisecond share an `updatedAt`, and some writes
 * (a heartbeat stamp) deliberately leave it alone. Activity-only fields are
 * passed in `omit` so stamping them does not invalidate an editor's version.
 *
 * Wire shape (host extension, non-normative): reads return the version as an
 * `ETag` header and an `etag` body field (list views have no per-row header);
 * a write MAY send `If-Match`. A stale `If-Match` is `409 conflict`, the
 * app's convention for a lost optimistic write (navigation-settings CHN-6).
 * Omitting `If-Match` keeps field-level last-writer-wins, but the write itself
 * is still a compare-and-swap, so two concurrent writes never drop each other.
 */
import { createHash } from 'node:crypto';
import { OpenwopError } from '../types.js';
import { canonicalJSON } from './jcs.js';

/** Content version of `value`, ignoring the `omit` keys. 16 bytes of SHA-256 over
 *  the RFC 8785 canonical form, base64url. A JSON round-trip first drops
 *  `undefined` members, which `canonicalJSON` refuses. */
export function entityEtag(value: object, omit: readonly string[] = []): string {
  const plain = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  for (const key of omit) delete plain[key];
  return createHash('sha256').update(canonicalJSON(plain)).digest('base64url').slice(0, 22);
}

/** The version an `If-Match` header names, or `undefined` when absent or `*`.
 *  Accepts a quoted, unquoted or weak (`W/"…"`) tag. */
export function parseIfMatch(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const tag = header.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  return tag === '' || tag === '*' ? undefined : tag;
}

/** The HTTP `ETag` header value for a version. */
export function etagHeader(version: string): string {
  return `"${version}"`;
}

export function staleWriteError(what: string, currentEtag: string | undefined): OpenwopError {
  return new OpenwopError('conflict', `This ${what} changed since you loaded it. Reload and re-apply your edit.`, 409, {
    reason: 'stale_write',
    ...(currentEtag !== undefined ? { currentEtag } : {}),
  });
}

/** How many times a write without `If-Match` re-reads and retries after losing a
 *  compare-and-swap to a concurrent writer before giving up with a conflict. */
export const CAS_RETRIES = 4;
