/**
 * Defense-in-depth redaction for USER-AUTHORED free text before it is persisted
 * (annotations, profile fields, …). Replaces secret-shaped tokens — provider API
 * keys, AWS access-key ids, GitHub PATs, Slack tokens, and long opaque
 * `[A-Za-z0-9_-]{40,}` blobs — with a marker so a user can't smuggle a live
 * credential into a stored, later-rendered surface.
 *
 * This is NOT a substitute for SR-1 resolved-secret redaction (which scrubs
 * HOST-injected secrets from run surfaces); it is a separate guard on inbound
 * user text. Single source of truth so the pattern can't drift between callers.
 */
export function scrubSecretShaped(text: string): string {
  return text.replace(
    /\b(sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{12,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{8,}|[A-Za-z0-9_-]{40,})\b/g,
    (match) => (isWordSlug(match) ? match : '[REDACTED:secret-shaped]'),
  );
}

/** A 40+ char URL slug made of lowercase WORDS (`plans-that-adapt-without-erasing-progress`).
 *
 *  The opaque-blob rule matched any `[A-Za-z0-9_-]{40,}` run, so every long readable
 *  slug was destroyed wherever text is scrubbed — including every `safeUrl` (it calls
 *  `cleanString`): a 41-char blog slug's `canonicalUrl` was stored as the redaction
 *  marker on kicktodo.com from 2026-09-19 on, and re-saving reproduced it. A slug is
 *  all lowercase letters/digits in at least four hyphen-separated segments, none
 *  longer than 20 characters. Generated credentials do not look like that: they mix
 *  case or carry `_`, or are one long run, and the named-prefix rules above still
 *  catch `sk-`/`ghp_`/`xox?-`/`AKIA` keys whatever their shape. */
function isWordSlug(run: string): boolean {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+){3,}$/.test(run)) return false;
  // The generic match can begin before a named credential (e.g. notes-sk-…).
  // A readable prefix must not exempt the credential embedded in that match.
  if (/(?:^|-)(sk-|xox[baprs]-)/.test(run)) return false;
  return run.split('-').every((seg) => seg.length <= 20);
}
