/**
 * Bounded, secret-scrubbed string cleaning for USER-AUTHORED fields persisted to
 * a durable store. Single source of truth shared by the host-extension product
 * features (crm, media, …) — each had copy-pasted `cleanName`/`cleanTags`
 * helpers that could drift (the code-review's recurring "Nth copy" finding).
 *
 * Every helper trims, scrubs secret-shaped tokens (defense-in-depth), and caps
 * length — so a feature can't accidentally persist an unbounded or
 * secret-bearing value.
 */
import { scrubSecretShaped } from './redactSecrets.js';

/** Trim + secret-scrub + cap to `max`; empty ⇒ `fallback`. */
export function cleanString(raw: unknown, max: number, fallback = ''): string {
  const v = scrubSecretShaped(String(raw ?? '').trim()).slice(0, max);
  return v.length > 0 ? v : fallback;
}

/** Like `cleanString` but returns `undefined` (not a fallback) when empty. */
export function optionalCleanString(raw: unknown, max: number): string | undefined {
  const v = cleanString(raw, max);
  return v.length > 0 ? v : undefined;
}

/** A deduped, lowercased, bounded tag list (each tag cleaned + capped). */
export function cleanTagList(raw: unknown, opts: { maxTags: number; maxLen: number }): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of raw.slice(0, opts.maxTags)) {
    const tag = cleanString(t, opts.maxLen).toLowerCase();
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

const SAFE_URL_SCHEME = /^(https?:|mailto:)/i;
const ANY_URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A safe, bounded link URL — or '' if it carries a DANGEROUS scheme
 * (`javascript:`/`data:`/`vbscript:`/…). Schemeless/relative values pass (treated
 * as http(s)-navigable). The single guard shared by features that persist
 * user-authored links (cms, profiles) — a stored-XSS vector otherwise.
 */
export function safeUrl(raw: unknown, max: number): string {
  const url = cleanString(raw, max);
  if (!url) return '';
  if (ANY_URL_SCHEME.test(url) && !SAFE_URL_SCHEME.test(url)) return '';
  return url;
}

/** Escape the five XML predefined entities — the canonical escaper for any
 *  hand-built XML/RSS/sitemap output (publishing, …). NOTE: distinct from
 *  `promptInjectionGuard.escapeAttr`, which is a deliberately narrower,
 *  determinism-locked attribute escaper for the conformance UNTRUSTED tag. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
