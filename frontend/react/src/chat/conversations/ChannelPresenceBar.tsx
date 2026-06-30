/**
 * Channel presence, rendered as chat CHROME around `ConversationView`
 * (ADR 0154). It lives OUTSIDE the slim embeddable unit (ADR 0073: "No header,
 * no left rail, no right panel") on purpose — so widgets / EmbeddedChatPanel
 * never inherit channel presence. The presence-DISPLAY is ported from the
 * retired standalone `ChannelMessages` view; local typing-EMIT (`setChannelTyping`
 * from the composer) is deferred to ADR 0154 Phase 2 (needs composer onChange).
 *
 * Honest-silent: when the host hasn't enabled presence the SSE 404s and the
 * subscriber stays empty, so nothing visible renders (only the always-mounted
 * sr-only live region, which announces nothing). Shows a reconnecting cue only
 * after a connection we had actually established dropped.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { subscribeChannelPresence } from '../../client/channelsClient.js';
import { RotateCwIcon } from '../../ui/icons/index.js';

interface Props {
  /** The channel conversation id (`type:'channel'`) — also the channel id. */
  channelId: string;
}

export function ChannelPresenceBar({ channelId }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  const [presence, setPresence] = useState<{ present: string[]; typing: string[] }>({ present: [], typing: [] });
  const [connected, setConnected] = useState(true);
  const everConnected = useRef(false);

  useEffect(() => {
    setPresence({ present: [], typing: [] });
    setConnected(true);
    everConnected.current = false;
    const unsub = subscribeChannelPresence(channelId, (s) => {
      setPresence({ present: s.present, typing: s.typing ?? [] });
      if (s.connected) everConnected.current = true;
      setConnected(s.connected);
    });
    return () => { unsub(); };
  }, [channelId]);

  const reconnecting = everConnected.current && !connected;
  const hasPresence = presence.present.length > 0;
  // ONE source of truth for what assistive tech announces — kept in a single
  // always-mounted live region below so SR reliably picks up changes (a region
  // mounted at the same moment its text appears is announced unreliably).
  const liveText = reconnecting
    ? t('reconnecting')
    : hasPresence
      ? `${t('presentCount', { count: presence.present.length })}${presence.typing.length > 0 ? ` · ${t('typingCount', { count: presence.typing.length })}` : ''}`
      : '';

  return (
    <>
      {/* Visual cue (aria-hidden — the live region below is the SR channel). */}
      {reconnecting ? (
        <div className="u-pad-2-4" aria-hidden>
          <span className="chip chip--warning u-fs-11"><RotateCwIcon size={11} /> {t('reconnecting')}</span>
        </div>
      ) : hasPresence ? (
        <p className="muted u-fs-11 u-pad-2-4 u-m-0" aria-hidden>{liveText}</p>
      ) : null}
      {/* Always-mounted polite live region (sr-only, zero visual footprint). */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">{liveText}</p>
    </>
  );
}
