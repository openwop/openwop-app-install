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
    '[REDACTED:secret-shaped]',
  );
}
