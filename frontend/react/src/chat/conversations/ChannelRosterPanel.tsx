/**
 * ChannelRosterPanel (ADR 0192 D8) — rail Zone 1 for an open CHANNEL: the
 * resolved member roster (humans + agents), replacing the 1:1 active-agents
 * lineup (whose switch-voice/remove semantics don't apply to a room —
 * deliberately a separate component from `ConversationLineup`, per the FE
 * architect gate F5). `strip` mirrors the lineup's compact multi-tab variant.
 *
 * Presentational: the parent supplies the roster (one `useChannelRoster`
 * fetch shared across Zone 1 / header / composer) and the two actions —
 * Manage (owner → the details dialog) and Leave (non-owner members).
 */
import { Button } from '../../ui/Button.js';
import { useTranslation } from 'react-i18next';
import { Avatar } from '../../ui/Avatar.js';
import { SettingsIcon, LogOutIcon } from '../../ui/icons/index.js';
import type { ChannelRosterEntry } from '../../client/channelsClient.js';

export function ChannelRosterPanel({
  roster,
  viewerIsOwner,
  viewerSubjectRef,
  onManage,
  onLeave,
  variant = 'rail',
}: {
  roster: readonly ChannelRosterEntry[];
  viewerIsOwner: boolean;
  viewerSubjectRef: string | null;
  onManage: () => void;
  onLeave: () => void;
  variant?: 'rail' | 'strip';
}): JSX.Element {
  const { t } = useTranslation('chat');
  if (variant === 'strip') {
    const shown = roster.slice(0, 6);
    const overflow = roster.length - shown.length;
    return (
      <section aria-label={t('channelRosterHeading')} className="convlineup-strip u-border-b">
        <ul className="convlineup-strip__list">
          {shown.map((r) => (
            <li key={r.subjectRef}>
              <span className="convlineup-chip">
                <Avatar name={r.displayName} hueKey={r.subjectRef} size={20} kind={r.kind === 'agent' ? 'agent' : 'user'} />
                <span className="convlineup-chip__name u-truncate">{r.displayName}</span>
              </span>
            </li>
          ))}
          {overflow > 0 && (
            <li><span className="convlineup-chip"><span className="convlineup-chip__name muted">+{overflow}</span></span></li>
          )}
        </ul>
      </section>
    );
  }
  return (
    <section aria-label={t('channelRosterHeading')} className="u-border-b">
      <h3 className="muted sesshist-group-head">{t('channelRosterHeading')}</h3>
      <ul className="u-list-none u-m-0 u-p-1-5 u-flex u-flex-col u-gap-1">
        {roster.map((r) => {
          const isSelf = viewerSubjectRef !== null && r.subjectRef === viewerSubjectRef;
          return (
            <li key={r.subjectRef}>
              <div className="chanroster-row">
                  <Avatar name={r.displayName} hueKey={r.subjectRef} size={28} kind={r.kind === 'agent' ? 'agent' : 'user'} />
                  <span className="convrail-participant-text">
                    <span className="convrail-participant-name u-truncate">
                      {r.displayName}
                      {isSelf && <span className="chip chip--muted chanroster-you">{t('rosterYou')}</span>}
                    </span>
                    <span className="convrail-participant-tagline u-truncate">
                      {r.kind === 'agent' && r.mentionSlug ? `@${r.mentionSlug}` : r.role === 'owner' ? t('roleOwner') : t('roleMember')}
                    </span>
                  </span>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="u-pad-2-4 u-flex u-gap-2">
        {viewerIsOwner ? (
          <Button variant="quiet" size="sm" className="u-iflex u-items-center u-gap-1" onClick={onManage}>
            <SettingsIcon size={13} /> {t('manageMembersCta')}
          </Button>
        ) : (
          <Button variant="quiet" size="sm" className="u-iflex u-items-center u-gap-1" onClick={onLeave}>
            <LogOutIcon size={13} /> {t('leaveChannelCta')}
          </Button>
        )}
      </div>
    </section>
  );
}
