/**
 * Create-a-channel dialog (ADR 0154 Phase 2) — chat CHROME launched from the "+"
 * on the Channels rail section. Replaces the standalone ChannelsPage create form;
 * composes the shared Modal + channelsClient.createChannel. On success it hands
 * the new conversationId back so the surface refreshes the rail and opens it.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../ui/Modal.js';
import { createChannel } from '../../client/channelsClient.js';

interface Props {
  onClose: () => void;
  /** The new channel's conversationId, after a successful create. */
  onCreated: (channelId: string) => void;
}

export function ChannelCreateDialog({ onClose, onCreated }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  const { t: tc } = useTranslation('common');
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const ch = await createChannel({ name: trimmed, visibility });
      onCreated(ch.conversationId);
      onClose();
    } catch {
      setError(t('createChannelError'));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={t('createChannelTitle')} showClose {...(error ? { error } : {})}>
      <h2 className="u-mt-0 u-fs-16">{t('createChannelTitle')}</h2>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label className="field">
          <span className="field-label">{t('channelNameLabel')}</span>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('channelNamePlaceholder')} autoFocus maxLength={80} disabled={busy} />
        </label>
        <label className="field u-w-auto">
          <span className="field-label">{t('visibilityLabel')}</span>
          <select value={visibility} onChange={(e) => setVisibility(e.target.value === 'private' ? 'private' : 'public')} disabled={busy}>
            <option value="public">{t('visibilityPublic')}</option>
            <option value="private">{t('visibilityPrivate')}</option>
          </select>
        </label>
        <p className="muted u-fs-12 u-mt-1">{visibility === 'private' ? t('visibilityPrivateHint') : t('visibilityPublicHint')}</p>
        <div className="u-flex u-gap-2 u-justify-end u-mt-3">
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>{tc('cancel')}</button>
          <button type="submit" className="btn-primary" disabled={!name.trim() || busy}>{tc('create')}</button>
        </div>
      </form>
    </Modal>
  );
}
