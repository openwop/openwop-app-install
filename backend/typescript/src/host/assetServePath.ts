/**
 * The media-asset serve address — the ONE owner of how an asset URL is built
 * and recognised.
 *
 * Asset URLs are not transient: the SPA saves the `serveUrl` it is handed into
 * drawings, slides, documents and podcast shows, and run artifacts embed them in
 * markdown. So a URL minted under a versioned prefix (`/v1/host/…/assets/…`)
 * becomes stored content that 410s the day that major retires (ADR 0669).
 *
 * Two rules, so no release ever has to hunt for these again:
 * - MINT unversioned, always: `assetServeUrl(token)`. The vendor path is served
 *   on both sides of every cut.
 * - RECOGNISE any `/v<N>` prefix or none: content stored before this module
 *   existed carries `/v1`, and it is NOT rewritten — a raw rewrite of stored
 *   rows breaks the ones under an integrity hash (measured: the audit chain).
 *   Instead the old address keeps resolving after the cut, as a redirect
 *   (`retiredAssetServePath` in `middleware/protocolVersion.ts`).
 */
import { VENDOR_ROOT } from '../middleware/protocolVersion.js';

/** `/host/openwop-app/assets` — the unversioned serve root. */
export const ASSET_SERVE_PATH = `${VENDOR_ROOT}/assets`;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** An optional versioned prefix: `/v1`, `/v2`, … — never spelled per major. */
const ANY_MAJOR = '(?:/v[0-9]+)?';
const TOKEN = '[A-Za-z0-9_-]{1,512}';

/**
 * JSON-Schema `pattern` for a stored image `src`: a root-relative serve path,
 * versioned or not. Anchored, so an external URL (a per-viewer beacon, the
 * ADR 0401 concern) is still refused.
 */
export const ASSET_SERVE_PATH_PATTERN = `^${ANY_MAJOR}${escapeRe(ASSET_SERVE_PATH)}/${TOKEN}$`;
const SERVE_PATH_RE = new RegExp(ASSET_SERVE_PATH_PATTERN);

/** Anywhere in a string (absolute URL, markdown, HTML), capturing the token. */
const EMBEDDED_RE = new RegExp(`${ANY_MAJOR}${escapeRe(ASSET_SERVE_PATH)}/([^/?#"'\\s)]+)`);
const VERSIONED_EMBEDDED_RE = new RegExp(`/v[0-9]+(?=${escapeRe(ASSET_SERVE_PATH)}/)`, 'g');

/** The relative serve URL for a capability token. Always unversioned. */
export function assetServeUrl(token: string): string {
  return `${ASSET_SERVE_PATH}/${token}`;
}

/** True for a root-relative serve path, versioned or not (validators). */
export function isAssetServePath(value: string): boolean {
  return SERVE_PATH_RE.test(value);
}

/** The capability token in a serve URL (relative or absolute, any major), or null. */
export function assetTokenFromUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const m = EMBEDDED_RE.exec(url);
  if (!m) return null;
  try { return decodeURIComponent(m[1]!); } catch { return null; }
}

/** Every capability token served from inside `text` (markdown, HTML, JSON), any
 *  major, de-duplicated. ADR 1122 P1b: what a rendered document makes public. */
export function assetTokensInText(text: string): string[] {
  const re = new RegExp(EMBEDDED_RE.source, 'g');
  const out = new Set<string>();
  for (const m of text.matchAll(re)) {
    try { out.add(decodeURIComponent(m[1] ?? '')); } catch { /* a malformed escape names no token */ }
  }
  out.delete('');
  return [...out];
}

/** A bare capability token as `storeMediaAsset` mints it: 32 random bytes, base64url. */
const BARE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Every asset token a JSON value exposes, as a bare token field (`imageToken`,
 *  `token`) or inside a served URL. ADR 1122 P1b: what an anonymous projection makes
 *  reachable. A string of the bare shape that is not an asset token grants nothing,
 *  since a grant only counts for a token that resolves in its own tenant. */
export function assetTokensInValue(value: unknown, out: Set<string> = new Set(), depth = 0): string[] {
  if (depth > 40) return [...out];
  if (typeof value === 'string') {
    if (BARE_TOKEN_RE.test(value)) out.add(value);
    else if (value.includes(ASSET_SERVE_PATH)) for (const t of assetTokensInText(value)) out.add(t);
  } else if (Array.isArray(value)) {
    for (const v of value) assetTokensInValue(v, out, depth + 1);
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) assetTokensInValue(v, out, depth + 1);
  }
  return [...out];
}

/**
 * Rewrite every versioned serve path inside `text` (a URL, JSON, markdown or
 * HTML) to its unversioned form. Idempotent: canonical text is returned
 * unchanged. For text on its way OUT (a response, an export) — not for
 * rewriting stored rows, which is the thing ADR 0669 decided against.
 */
export function canonicalAssetUrls(text: string): string {
  return text.replace(VERSIONED_EMBEDDED_RE, '');
}
