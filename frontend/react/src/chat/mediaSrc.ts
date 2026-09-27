/**
 * Shared media-src sanitizer for model-influenced media URLs.
 *
 * Extracted from `MessageRenderer` so the SAME URL allowlist backs both the chat
 * message media parts (RFC 0055) and the review `AssetPreview` (ADR 0458 §2.4):
 * a generated asset's serve URL is LLM-influenced, and an unsanitized
 * `javascript:` (or foreign `data:`) URL reaching a raw `<img>`/`<video>`/`<a>`
 * would be a DOM-XSS vector. Keep the two consumers on ONE allowlist — never
 * copy the regex.
 */

import { config } from '../client/config.js';

/** Resolve a media part to a renderable src: host-served URL (RFC 0055 §C
 *  preferred) or an inline data URI. Returns null when neither is present.
 *
 *  The untrusted `url` field is restricted to http(s)/blob OR the host's own
 *  media-asset serve path — media content is LLM-influenced, and an unsanitized
 *  `javascript:` URL in a raw element would be a DOM-XSS vector. The relative
 *  host path (`/host/openwop-app/assets/<token>`, where the unguessable token
 *  IS the capability) is resolved against the API base so an `<img>`/`<a>` can
 *  fetch it cross-origin in the public deploy; any other relative or
 *  non-allowlisted scheme is rejected. Inline `data:` is only ever produced from
 *  our own base64 below, never accepted from `url`. */
export function mediaSrc(mimeType: string, url?: string, dataBase64?: string): string | null {
  if (url) {
    const u = url.trim();
    if (/^(https?|blob):/i.test(u)) return u;
    // Same-origin host media-asset path. Match the exact token shape (32 random
    // bytes, base64url — no `/` or `.`) so a crafted LLM-emitted `url` can't
    // smuggle a traversal segment past the prefix check.
    if (/^(?:\/v1)?\/host\/openwop-app\/assets\/[A-Za-z0-9_-]+$/.test(u)) return `${config.baseUrl}${u}`;
    return null;
  }
  if (dataBase64) return `data:${mimeType};base64,${dataBase64}`;
  return null;
}
