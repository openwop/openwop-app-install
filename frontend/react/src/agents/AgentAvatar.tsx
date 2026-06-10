/**
 * Agent avatar — the one place that renders a coworker's circular avatar:
 * the uploaded profile photo when set, else the persona initials, always with
 * the role-glyph badge overlay. Shared by the `/agents` list cards
 * (`AgentCard.tsx`, display-only) and the individual agent dashboard header
 * (`AgentWorkspacePage.tsx`, where `onEdit` turns the circle into the
 * profile-photo edit affordance).
 */

import { useState } from 'react';
import type { RoleTheme } from './roleTemplates.js';
import { ImageIcon } from '../ui/icons/index.js';

/** Initials for the avatar. Falls back to the first two chars of the name.
 *  Single source of truth — both call sites import it from here. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || name.slice(0, 2).toUpperCase();
}

export function AgentAvatar({
  persona,
  avatarUrl,
  roleTheme,
  size,
  onEdit,
  alt,
  showBadge = true,
  ring,
}: {
  persona: string;
  avatarUrl?: string | undefined;
  roleTheme: RoleTheme;
  /** Diameter of the main circle, px. */
  size: number;
  /** When provided the avatar becomes a focusable button that opens the
   *  profile-photo editor; a camera badge + hover/focus scrim signal it. */
  onEdit?: (() => void) | undefined;
  /** Accessible name for the photo. Omitted → decorative (alt=""), correct
   *  where the persona name is adjacent text (list cards, header). Pass a
   *  meaningful alt where the avatar stands more on its own (activity rows). */
  alt?: string | undefined;
  /** Show the role-glyph badge overlay. Off for tiny inline avatars where the
   *  badge would crowd the circle. */
  showBadge?: boolean | undefined;
  /** Status-ring color (a CSS color/token value). Renders a 2px ring offset
   *  from the circle — the roster's at-a-glance status cue. */
  ring?: string | undefined;
}): JSX.Element {
  const RoleIcon = roleTheme.Icon;
  const [active, setActive] = useState(false); // hover OR keyboard focus

  // Badge geometry scales with the circle so it reads consistently at 40 / 48.
  const badge = Math.round(size * 0.42);
  const badgeIcon = Math.max(11, Math.round(size * 0.26));

  const circle = (
    <div
      className="agentavatar-circle"
      style={{
        width: size,
        height: size,
        fontSize: size <= 28 ? '0.7rem' : size <= 40 ? '0.95rem' : '1.1rem',
        ...(ring ? { boxShadow: `0 0 0 2px var(--paper), 0 0 0 4px ${ring}` } : {}),
      }}
    >
      {avatarUrl ? (
        <img src={avatarUrl} alt={alt ?? ''} className="agentavatar-img" />
      ) : (
        initials(persona)
      )}
    </div>
  );

  return (
    <div className="agentavatar-wrap" style={{ width: size, height: size }} aria-hidden={onEdit ? undefined : true}>
      {onEdit ? (
        <button
          type="button"
          onClick={onEdit}
          onMouseEnter={() => setActive(true)}
          onMouseLeave={() => setActive(false)}
          onFocus={() => setActive(true)}
          onBlur={() => setActive(false)}
          title="Edit profile photo"
          aria-label={`Edit ${persona}'s profile photo`}
          className="agentavatar-edit-btn"
          style={{ outline: active ? '2px solid var(--color-accent)' : 'none' }}
        >
          {circle}
          {/* Hover/focus scrim with a camera glyph — the "change photo" cue. */}
          <span
            aria-hidden="true"
            className="agentavatar-scrim"
            style={{ opacity: active ? 1 : 0 }}
          >
            <ImageIcon size={Math.round(size * 0.4)} />
          </span>
        </button>
      ) : (
        circle
      )}

      {/* Role glyph badge — the at-a-glance differentiator between coworkers. */}
      {showBadge ? (
        <div
          aria-hidden="true"
          title={`${roleTheme.label} role`}
          className="agentavatar-badge"
          style={{ width: badge, height: badge }}
        >
          <RoleIcon size={badgeIcon} strokeWidth={2} />
        </div>
      ) : null}
    </div>
  );
}
