/**
 * The single allowlist of MIME types the host accepts for stored, later-served
 * media bytes. Single source of truth shared by the chat/avatar upload route
 * (`routes/mediaAssets.ts`) and the media library (`features/media`), so an
 * upload path can't silently diverge into accepting a dangerous type.
 *
 * SECURITY: the asset serve route reflects the stored `Content-Type` verbatim
 * (no `nosniff`/`Content-Disposition`), so `text/html` and `image/svg+xml` are
 * deliberately EXCLUDED — serving user-authored HTML/SVG would be stored-XSS.
 * Only inert image + document types are allowed.
 */
export const ALLOWED_UPLOAD_MIME: ReadonlySet<string> = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/json',
  'text/csv',
]);

export function isAllowedUploadMime(contentType: unknown): contentType is string {
  return typeof contentType === 'string' && ALLOWED_UPLOAD_MIME.has(contentType);
}

/** A human-readable list for error messages. */
export function allowedUploadMimeList(): string {
  return [...ALLOWED_UPLOAD_MIME].join(', ');
}
