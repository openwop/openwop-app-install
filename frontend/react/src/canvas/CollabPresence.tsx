/**
 * The chassis presence cluster (ADR 0359 Phase 4 / D5) — the visible answer to
 * "why are Save/History locked" (the Phase 2 UX finding): a quiet Live chip
 * (success dot + label; muted "Reconnecting…" when the socket drops) beside an
 * overlapping stack of ≤4 peer avatars (+N overflow). Peers only — never self.
 * Identity is entirely `ui/Avatar`'s deterministic hue (no new color system);
 * the whole cluster sits in the toolbar's status/identity line, reading as
 * part of the document's state, not as chrome.
 */
import { useTranslation } from 'react-i18next';
import { Avatar } from '../ui/Avatar.js';
import type { CollabPeer } from './useCollabPresence.js';

const MAX_SHOWN = 4;

export function CollabPresence({ peers, connected }: { peers: CollabPeer[]; connected: boolean }): JSX.Element {
  const { t } = useTranslation('canvas');
  const shown = peers.slice(0, MAX_SHOWN);
  const overflow = peers.length - shown.length;
  const names = peers.map((p) => p.name).join(', ');
  // RTCU-5 — the accessible NAME must not claim "Live" while the visible chip reads
  // "Reconnecting". It used to branch on peer COUNT only, so a screen-reader user
  // querying this group during a drop heard the opposite of what the socket was doing.
  const groupLabel = connected
    ? (peers.length > 0 ? t('liveCollaborators', { names }) : t('live'))
    : (peers.length > 0 ? t('reconnectingCollaborators', { names }) : t('reconnecting'));
  return (
    <span
      className="cv-presence"
      role="group"
      aria-label={groupLabel}
    >
      <span className={`chip${connected ? '' : ' chip--muted'} cv-presence__live`}>
        <span className={`cv-presence__dot${connected ? '' : ' cv-presence__dot--off'}`} aria-hidden="true" />
        {connected ? t('live') : t('reconnecting')}
      </span>
      {shown.length > 0 ? (
        <span className="cv-presence__stack" aria-hidden="true">
          {shown.map((p) => (
            <span key={p.clientId} className="cv-presence__peer" title={p.name}>
              <Avatar name={p.name} hueKey={p.name} size={18} />
            </span>
          ))}
        </span>
      ) : null}
      {overflow > 0 ? (
        <span className="chip chip--muted cv-presence__more" title={names}>+{overflow}</span>
      ) : null}
    </span>
  );
}
