/**
 * Agent avatar — the one place that renders a coworker's circular avatar:
 * the uploaded profile photo when set, else the persona initials, always with
 * the role-glyph badge overlay. Shared by the `/agents` list cards
 * (`AgentCard.tsx`, display-only) and the individual agent dashboard header
 * (`AgentWorkspacePage.tsx`, where `onEdit` turns the circle into the
 * profile-photo edit affordance).
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RoleTheme } from './roleTheme.js';
import { ImageIcon } from '../ui/icons/index.js';
import { Avatar, initials } from '../ui/Avatar.js';

/** Re-export — `ui/Avatar` owns the helper now (ADR 0192 D8); existing
 *  call sites (`MessageBubble`, `AgentCard`, …) keep importing from here. */
export { initials };

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
  const { t } = useTranslation('agents');
  const RoleIcon = roleTheme.Icon;
  const [active, setActive] = useState(false); // hover OR keyboard focus

  // Badge geometry scales with the circle so it reads consistently at 40 / 48.
  const badge = Math.round(size * 0.42);
  const badgeIcon = Math.max(11, Math.round(size * 0.26));

  // The circle itself is the shared ui/Avatar primitive (ADR 0192 D8); this
  // component keeps the agent chrome — role badge, edit scrim, wrapper.
  const circle = <Avatar name={persona} size={size} kind="agent" photoUrl={avatarUrl} ring={ring} alt={alt} />;

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
          title={t('avatarEditTitle')}
          aria-label={t('avatarEditAria', { persona })}
          className="agentavatar-edit-btn"
          style={{ outline: active ? '2px solid var(--clay-text)' : 'none' }}
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
          title={t('avatarRoleTitle', { role: roleTheme.label })}
          className="agentavatar-badge"
          style={{ width: badge, height: badge }}
        >
          <RoleIcon size={badgeIcon} strokeWidth={2} />
        </div>
      ) : null}
    </div>
  );
}
