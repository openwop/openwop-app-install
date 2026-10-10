/**
 * The single allowlist of MIME types the host accepts for stored, later-served
 * media bytes. Single source of truth shared by the chat/avatar upload route
 * (`routes/mediaAssets.ts`) and the media library (`features/media`), so an
 * upload path can't silently diverge into accepting a dangerous type.
 *
 * SECURITY: `text/html` and `image/svg+xml` are deliberately EXCLUDED —
 * user-authored HTML/SVG on the app's origin is stored XSS. Only inert image +
 * document + audio/video container types are allowed. This list is NOT the
 * only guard: other writers (the image-emit node, the AI image seams) store
 * types it never saw, so the serve route (`assetServeHeaders`, ADR 0818) sends
 * `nosniff` + a `sandbox` CSP and downloads anything outside its own inline set.
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

/**
 * Declared type → its magic-byte signature (ADR 0511 brand assets, ADR 0818 the
 * media library). Only the types whose bytes a browser would otherwise trust are
 * here: raster images and PDF. A declared `image/png` carrying HTML is a
 * polyglot the library used to store and serve under the image's type; the
 * serve route's `nosniff` stops a browser re-reading it, and this stops the
 * library holding it at all. Text, JSON, audio and video have no single
 * signature and are inert when reflected.
 */
export const MIME_SIGNATURES: Readonly<Record<string, (b: Buffer) => boolean>> = {
  'image/png': (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.length > 6 && b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'image/x-icon': (b) => b.length > 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00,
  'image/vnd.microsoft.icon': (b) => b.length > 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00,
  // The header may follow up to 1 KiB of leading bytes (readers accept that).
  'application/pdf': (b) => b.subarray(0, 1024).toString('latin1').includes('%PDF-'),
};

/** True unless `contentType` has a known signature that `bytes` lacks. */
export function bytesMatchDeclaredType(contentType: string, bytes: Buffer): boolean {
  const sniff = MIME_SIGNATURES[contentType];
  return !sniff || sniff(bytes);
}

/** The allowlisted raster type `bytes` actually are, or null. */
export function sniffImageType(bytes: Buffer): string | null {
  for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
    if (MIME_SIGNATURES[type]!(bytes)) return type;
  }
  return null;
}

/**
 * ADR 0818 §2 — the type to STORE for bytes declared as `declared`, or null to
 * refuse. A declared image is relabelled to what its bytes are (a `.png` that is
 * really a JPEG is common, from file extensions and from AI providers), and
 * refused only when the bytes are no allowlisted image at all — HTML labelled
 * `image/png` is the case that matters. A declared PDF must carry its header.
 * Other allowlisted types pass through: they are inert when served.
 */
export function storableContentType(declared: string, bytes: Buffer): string | null {
  if (!isAllowedUploadMime(declared)) return null;
  if (declared.startsWith('image/')) return sniffImageType(bytes);
  return bytesMatchDeclaredType(declared, bytes) ? declared : null;
}
