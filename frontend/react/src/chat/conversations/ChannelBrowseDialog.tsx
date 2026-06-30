/**
 * Browse-and-join public channels (ADR 0154 FU-4) — chat CHROME launched from the
 * Channels rail "browse" affordance. Restores public-channel discovery the retired
 * page provided: the rail only shows channels you're a member of, so this lists
 * every PUBLIC channel (+ your private memberships) and lets you self-join one.
 * Composes the shared Modal + channelsClient.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../ui/Modal.js';
import { HashIcon } from '../../ui/icons/index.js';
import { listJoinableChannels, joinChannel, type ChannelListEntry } from '../../client/channelsClient.js';

interface Props {
  onClose: () => void;
  /** Open a channel the viewer is already in. */
  onOpen: (channelId: string) => void;
  /** A channel the viewer just joined — the surface refreshes its list + opens it. */
  onJoined: (channelId: string) => void;
}

export function ChannelBrowseDialog({ onClose, onOpen, onJoined }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  const [rows, setRows] = useState<ChannelListEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try { setRows(await listJoinableChannels()); }
    catch { setError(t('manageError')); setRows([]); }
  }, [t]);
  useEffect(() => { void load(); }, [load]);

  const onJoin = (id: string): void => {
    setBusy(true);
    setError(null);
    void (async () => {
      try { await joinChannel(id); onJoined(id); onClose(); }
      catch { setError(t('joinChannelError')); setBusy(false); }
    })();
  };

  return (
    <Modal onClose={onClose} label={t('browseChannelsTitle')} showClose loading={rows === null} {...(error ? { error } : {})}>
      <h2 className="u-mt-0 u-fs-16">{t('browseChannelsTitle')}</h2>
      {rows && rows.length === 0 ? (
        <p className="muted u-fs-12">{t('noPublicChannels')}</p>
      ) : (
        <ul className="u-list-none u-m-0 u-p-0">
          {(rows ?? []).map((r) => (
            <li key={r.conversationId} className="u-flex u-items-center u-justify-between u-gap-2 u-pad-1-2">
              <span className="u-flex u-items-center u-gap-1-5 u-fs-13">
                <span aria-hidden className="u-iflex muted"><HashIcon size={13} /></span>
                {r.channel?.name ?? r.conversationId}
                {r.channel?.visibility === 'private' ? <span className="muted u-fs-11">· {t('visibilityPrivate')}</span> : null}
              </span>
              {r.joined ? (
                <button type="button" className="secondary btn-sm" onClick={() => { onOpen(r.conversationId); onClose(); }}>{t('openChannelCta')}</button>
              ) : (
                <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => onJoin(r.conversationId)}>{t('joinChannelCta')}</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
