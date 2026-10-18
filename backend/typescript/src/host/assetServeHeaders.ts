/**
 * ADR 0818 §1 — the response headers for stored asset bytes, wherever they leave.
 *
 * Asset bytes are served from the SPA's own cookie-auth origin (Hosting rewrites
 * `/host/**` to the backend), and the upload allowlist is not the only writer:
 * the image-emit node and the AI media seams store types it never saw. So the
 * guard sits at the EXITS — the token serve route and the public podcast audio
 * route — and both call this one function:
 *
 * - `nosniff` always, so a browser never re-reads bytes as another type;
 * - a `sandbox` CSP, so a rendered response has no script and no origin;
 * - inline only for {@link INLINE_SAFE}; everything else is an attachment, and a
 *   type a page could load as a SUBRESOURCE (`<script src>` and
 *   `<link rel=stylesheet>` ignore Content-Disposition, and on this origin pass
 *   the SPA's own `script-src 'self'`) goes out as `application/octet-stream`.
 *   An inert download (a .docx export) keeps its type so it saves correctly.
 *
 * A PDF gets no CSP: a restrictive policy (`sandbox`, or `object-src` through
 * `default-src`) can stop the browser's built-in viewer, and that viewer never
 * runs a PDF's script in this origin.
 */

/** Types a browser may RENDER: raster images, audio, video, PDF, plain text. */
const INLINE_SAFE = /^(image\/(png|jpeg|gif|webp|avif|x-icon|vnd\.microsoft\.icon)|audio\/[\w.+-]+|video\/[\w.+-]+|application\/pdf|text\/(plain|csv|markdown)|application\/json)$/;

/** Types a page could execute or apply: markup (any `+xml`), script, CSS, wasm, any other `text/*`. */
const ACTIVE = /(html|\/xml$|\+xml$|svg|javascript|ecmascript|css|wasm)/;

const CSP = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox";

/** ADR 0888 D5 — true iff this exit would serve `contentType` INLINE as an image (a
 *  raster type in {@link INLINE_SAFE}), normalised exactly as {@link assetServeHeaders}
 *  normalises. A reference that is going to be rendered as an `<img>` (a profile avatar
 *  or portfolio item) uses this, so it cannot point at bytes the exit would send as an
 *  attachment and every `<img>` would show broken. */
export function isInlineImageType(contentType: string | undefined): boolean {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  return type.startsWith('image/') && INLINE_SAFE.test(type) && !ACTIVE.test(type);
}

export function assetServeHeaders(contentType: string | undefined): Record<string, string> {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  const active = ACTIVE.test(type) || (type.startsWith('text/') && !INLINE_SAFE.test(type));
  const inline = INLINE_SAFE.test(type) && !active;
  return {
    'Content-Type': inline || (type !== '' && !active) ? type : 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    ...(type === 'application/pdf' ? {} : { 'Content-Security-Policy': CSP }),
    ...(inline ? {} : { 'Content-Disposition': 'attachment' }),
  };
}
