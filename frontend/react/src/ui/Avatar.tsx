/**
 * Avatar (ADR 0192 D8) — THE circular identity mark for people and agents.
 * Owns `initials()` (moved from `agents/AgentAvatar`, which now composes this
 * primitive and re-exports the helper — import direction: agents/ → ui/ only).
 *
 * Two kinds, encoded by FILL, not decoration (structure is information):
 *   - `agent` — the solid clay circle (the pre-existing `.agentavatar-circle`
 *     treatment, now the `--agent` arm of `.ui-avatar`).
 *   - `user`  — a soft deterministic-hue wash derived from the display name
 *     (FNV-1a hash → hue), painted entirely in CSS from the numeric
 *     `--avatar-h` custom property so no color literal enters TSX.
 * Twenty humans stay quieter than one clay agent on purpose.
 */

/** Initials for the avatar. Falls back to the first two chars of the name.
 *  Single source of truth — AgentAvatar re-exports it. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || name.slice(0, 2).toUpperCase();
}

/** FNV-1a over the name → a stable hue 0..359. Deterministic per identity so
 *  the same person keeps the same wash across sessions and surfaces. Exported
 *  (ADR 0359 grade pass UX-B1) so the collab presence layer derives the SAME
 *  identity hue for remote carets — one hue source, never a second hash. */
export function hueOf(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 360;
}

export function Avatar({
  name,
  hueKey,
  size,
  kind = 'user',
  photoUrl,
  ring,
  alt,
}: {
  /** Display name — drives the initials. */
  name: string;
  /** Stable identity key for the hue (a subjectRef) — a display-name change
   *  must not shift a person's color. Falls back to `name`. */
  hueKey?: string | undefined;
  /** Diameter, px. */
  size: number;
  kind?: 'user' | 'agent';
  photoUrl?: string | undefined;
  /** Status-ring color (a CSS color/token value), same recipe AgentAvatar used. */
  ring?: string | undefined;
  /** Accessible name. Omitted → decorative (aria-hidden), correct where the
   *  name is adjacent text. */
  alt?: string | undefined;
}): JSX.Element {
  return (
    <span
      className={`ui-avatar${kind === 'agent' ? ' ui-avatar--agent' : ''}`}
      role={alt ? 'img' : undefined}
      aria-label={alt}
      aria-hidden={alt ? undefined : true}
      style={{
        width: size,
        height: size,
        fontSize: size <= 22 ? '0.6rem' : size <= 28 ? '0.7rem' : size <= 40 ? '0.95rem' : '1.1rem',
        ...(kind === 'user' ? ({ '--avatar-h': hueOf(hueKey ?? name) } as React.CSSProperties) : {}),
        ...(ring ? { boxShadow: `0 0 0 2px var(--paper), 0 0 0 4px ${ring}` } : {}),
      }}
    >
      {photoUrl ? <img src={photoUrl} alt="" className="ui-avatar-img" /> : initials(name)}
    </span>
  );
}
