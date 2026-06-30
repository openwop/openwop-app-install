/**
 * The single allowlist of MIME types the host accepts for stored, later-served
 * media bytes. Single source of truth shared by the chat/avatar upload route
 * (`routes/mediaAssets.ts`) and the media library (`features/media`), so an
 * upload path can't silently diverge into accepting a dangerous type.
 *
 * SECURITY: the asset serve route reflects the stored `Content-Type` verbatim
 * (no `nosniff`/`Content-Disposition`), so `text/html` and `image/svg+xml` are
 * deliberately EXCLUDED — serving user-authored HTML/SVG would be stored-XSS.
 * Only inert image + document + audio/video container types are allowed.
 *
 * AUDIO/VIDEO (ADR 0085 Phase 2): the audio/video container types below are
 * NotebookLM-style transcription sources. They are INERT when reflected — a
 * browser handed `audio/mpeg`/`video/mp4` plays or downloads it, it does not
 * execute script — so adding them does NOT widen the stored-XSS surface that the
 * `text/html`/`svg` exclusion above guards. The exclusion is untouched.
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
  // Audio/video transcription sources (ADR 0085) — inert when reflected.
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'audio/ogg',
  'video/mp4',
  'video/webm',
]);

export function isAllowedUploadMime(contentType: unknown): contentType is string {
  return typeof contentType === 'string' && ALLOWED_UPLOAD_MIME.has(contentType);
}

/** A human-readable list for error messages. */
export function allowedUploadMimeList(): string {
  return [...ALLOWED_UPLOAD_MIME].join(', ');
}
