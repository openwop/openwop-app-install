/**
 * ChannelEmptyState (ADR 0192 D8) — the beginning-of-channel moment, replacing
 * the AI WelcomeCard whose suggestion pills would post inert text into an empty
 * room (the "channel impersonates the AI chat" gap).
 *
 * Design (frontend-design pass): the page's one signature moment. A square
 * clay-wash `#` tile (deliberately NOT a circle, so it can't read as an avatar
 * — the `#` is the channel's identity mark in the rail, header, and here),
 * an editorial left-aligned title on the composer spine, the description as
 * the body, and quiet secondary actions — the composer below stays the page's
 * real primary, so no solid CTA competes with it. One orchestrated reveal
 * (tile → title, single stagger), inside the reduced-motion guard.
 */
import { Button } from '../../ui/Button.js';
import { useTranslation } from 'react-i18next';
import { HashIcon, BotIcon, UsersIcon } from '../../ui/icons/index.js';

export function ChannelEmptyState({
  name,
  description,
  viewerIsOwner,
  hasAgents,
  onOpenDetails,
}: {
  /** The normalized channel name (no `#` — the component renders the glyph). */
  name: string;
  description?: string | undefined;
  viewerIsOwner: boolean;
  /** Whether any agent members exist — drives the member hint copy. */
  hasAgents: boolean;
  /** All actions land in the channel-details dialog (one roster surface). */
  onOpenDetails: () => void;
}): JSX.Element {
  const { t } = useTranslation('chat');
  // Locale-safe word order: the catalog value carries a {{name}} placeholder;
  // we substitute an invisible-separator marker and split around it so the
  // styled #name span can land anywhere the locale puts it.
  const MARK = '\u2063';
  const [titleBefore, titleAfter = ''] = t('channelEmptyTitle', { name: MARK }).split(MARK);
  return (
    <div className="cv-spine">
      <div className="chanempty">
        <div className="chanempty-glyph" aria-hidden>
          <HashIcon size={24} />
        </div>
        <h2 className="chanempty-title">
          {titleBefore}
          <span className="chanempty-name">#{name}</span>
          {titleAfter}
        </h2>
        {description ? (
          <p className="chanempty-body">{description}</p>
        ) : viewerIsOwner ? (
          <p className="chanempty-body muted">{t('channelEmptyNoDescription')}</p>
        ) : null}
        {viewerIsOwner ? (
          <div className="action-bar u-wrap u-mt-3">
            <Button variant="secondary" size="sm" className="u-iflex u-items-center u-gap-1" onClick={onOpenDetails}>
              <UsersIcon size={13} /> {t('channelEmptyAddPeople')}
            </Button>
            <Button variant="secondary" size="sm" className="u-iflex u-items-center u-gap-1" onClick={onOpenDetails}>
              <BotIcon size={13} /> {t('channelEmptyAddAgent')}
            </Button>
            {!description && (
              <Button variant="quiet" size="sm" onClick={onOpenDetails}>
                {t('channelEmptySetDescription')}
              </Button>
            )}
          </div>
        ) : (
          <p className="chanempty-body muted u-mt-2">
            {hasAgents ? t('channelEmptyMemberHint') : t('channelEmptyMemberHintNoAgents')}
          </p>
        )}
      </div>
    </div>
  );
}
