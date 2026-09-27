/**
 * Channel-name normalization (ADR 0192 D4) — the FE mirror of the backend
 * policy (`channelService.cleanName`): lowercase `[a-z0-9._-]`, spaces →
 * dashes, ≤80. Preview-only — the server remains authoritative.
 */
export function normalizeChannelName(raw: string): string {
  return raw.trim().toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^[._-]+/, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 80);
}
