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
import { findCredentialShape, scrubSecretShaped } from './redactSecrets.js';
import { OpenwopError } from '../types.js';

/** Trim + secret-scrub + cap to `max`; empty ⇒ `fallback`.
 *
 *  The LOG/LABEL lane: names, labels, notes, ids, model context. For text that
 *  is published or sent to an audience, use `cleanContent` / `contentUrl`: this
 *  scrub silently rewrites any 40+ character run, which corrupts content. */
export function cleanString(raw: unknown, max: number, fallback = ''): string {
  const v = scrubSecretShaped(String(raw ?? '').trim()).slice(0, max);
  return v.length > 0 ? v : fallback;
}

/** Like `cleanString` but returns `undefined` (not a fallback) when empty. */
export function optionalCleanString(raw: unknown, max: number): string | undefined {
  const v = cleanString(raw, max);
  return v.length > 0 ? v : undefined;
}

/**
 * The CONTENT lane: audience-facing text that is published or sent (page copy,
 * product descriptions, captions, feed text, ad copy). Trimmed and capped, and
 * NEVER rewritten: a credential-shaped token (`findCredentialShape`) is a typed
 * refusal naming the field, so the author keeps their text and decides. Long
 * opaque runs (hashes, slugs, tokens inside links) pass through byte for byte.
 */
export function cleanContent(raw: unknown, max: number, field: string, fallback = ''): string {
  const v = String(raw ?? '').trim();
  refuseCredential(v, field);
  const capped = v.slice(0, max);
  return capped.length > 0 ? capped : fallback;
}

/** Like `cleanContent` but `undefined` when empty. */
export function optionalCleanContent(raw: unknown, max: number, field: string): string | undefined {
  const v = cleanContent(raw, max, field);
  return v.length > 0 ? v : undefined;
}

/** A published link: `safeUrl`'s scheme guard, no scrub (signed and long-path
 *  URLs survive), and a credential-shaped token is a typed refusal. '' when the
 *  scheme is dangerous or the value empty. */
export function contentUrl(raw: unknown, max: number, field: string): string {
  const url = cleanContent(raw, max, field);
  if (!url) return '';
  if (ANY_URL_SCHEME.test(url) && !SAFE_URL_SCHEME.test(url)) return '';
  return url;
}

/** The typed refusal both content helpers share. Never echoes the token. */
export function refuseCredential(text: string, field: string): void {
  const kind = text ? findCredentialShape(text) : null;
  if (kind) {
    // An export path or custom-field name can itself be authored input. Do
    // not echo a credential through the diagnostic's field label either.
    const safeField = findCredentialShape(field) ? '(redacted field)' : field;
    throw new OpenwopError('validation_error', `\`${safeField}\` contains what looks like a credential (${kind}). It will not be published or rewritten; remove it and save again.`, 400, { field: safeField, reason: 'secret_shaped', kind });
  }
}

/** The STRICT internal lane (the projects charter / team ledger precedent): a
 *  value the log scrub WOULD rewrite is a typed refusal instead of a silent
 *  rewrite. Stricter than content: it refuses long opaque runs too. */
export function refuseIfScrubbed(raw: unknown, field: string, message?: string): void {
  const t = String(raw ?? '').trim();
  if (t && scrubSecretShaped(t) !== t) {
    throw new OpenwopError('validation_error', message ?? `\`${field}\` contains a secret-shaped token (an API key, or a 40+ character unbroken blob such as a long hash). It will not be stored or rewritten; remove or break up the token.`, 400, { field, reason: 'secret_shaped' });
  }
}

/**
 * An OPAQUE REFERENCE token (media serve token, storage ref) — trimmed,
 * charset-validated, capped, and NOT secret-scrubbed. `cleanString`'s
 * secret-shape scrub redacts any bare `[A-Za-z0-9_-]{40,}` blob, but media
 * serve tokens are 43-char base64url — running references through the free-TEXT
 * scrub silently destroyed every saved CMS image token (gap-analysis Phase B
 * discovery; ADR 0206). References are never rendered as text (they become
 * `/assets/:token` URLs), so the scrub's paste-a-credential threat model does
 * not apply; charset validation rejects anything that isn't token-shaped.
 * Returns '' when invalid.
 */
export function cleanOpaqueToken(raw: unknown, max: number): string {
  const v = String(raw ?? '').trim();
  if (v.length === 0 || v.length > max) return '';
  return /^[A-Za-z0-9_.:-]+$/.test(v) ? v : '';
}

/**
 * PMX-1 (ADR 0590) — an outbound BEARER credential (RFC 6750 `token68`):
 * trimmed, grammar-validated, capped, and NOT secret-scrubbed. Running a
 * credential through `cleanString` destroys every production-shaped token
 * (any bare `[A-Za-z0-9_-]{40,}` run → `[REDACTED:secret-shaped]`) while the
 * save still reports success — the CMS-image-token class, on the credential
 * lane itself. `cleanOpaqueToken` is the wrong instrument here too: its
 * charset refuses the legal token68 characters `~ + / =` (plain base64 with
 * padding). Grammar: `1*( ALPHA / DIGIT / "-" / "." / "_" / "~" / "+" / "/" )
 * *"="`. Returns '' when invalid (caller refuses loudly, never stores a
 * mangled credential).
 */
export function cleanBearerToken(raw: unknown, max: number): string {
  const v = String(raw ?? '').trim();
  if (v.length === 0 || v.length > max) return '';
  return /^[A-Za-z0-9._~+/-]+=*$/.test(v) ? v : '';
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
