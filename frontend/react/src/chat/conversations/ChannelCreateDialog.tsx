/**
 * Create-a-channel dialog (ADR 0154 Phase 2, one-flow per ADR 0192 D4) — chat
 * CHROME launched from the "+" on the Channels rail section. One flow: name
 * (with a live normalized preview mirroring the backend slug rule) →
 * description → visibility → invite people + agents via name-resolving pickers
 * (no raw IDs). On success it hands the new conversationId back so the surface
 * refreshes the rail and opens it.
 */

import { Button } from '../../ui/Button.js';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../ui/Modal.js';
import { createChannel } from '../../client/channelsClient.js';
import { MemberPicker, AgentPicker } from './MemberPickers.js';
import { normalizeChannelName } from './channelName.js';

interface Props {
  onClose: () => void;
  /** The new channel's conversationId, after a successful create. */
  onCreated: (channelId: string) => void;
}

export function ChannelCreateDialog({ onClose, onCreated }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  const { t: tc } = useTranslation('common');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [memberUserIds, setMemberUserIds] = useState<string[]>([]);
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalized = useMemo(() => normalizeChannelName(name), [name]);
  // Mirrors the backend MAX_INITIAL_MEMBERS (channelService) so an oversized
  // invite list fails HERE with a reason, not as a generic 400 toast.
  const overCap = memberUserIds.length > 50 || agentIds.length > 50;

  const submit = async (): Promise<void> => {
    if (!normalized || busy) return;
    setBusy(true);
    setError(null);
    try {
      const ch = await createChannel({
        name: name.trim(),
        visibility,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(memberUserIds.length ? { memberUserIds } : {}),
        ...(agentIds.length ? { agentIds } : {}),
      });
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
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('channelNamePlaceholder')} autoFocus maxLength={80} disabled={busy} />
        </label>
        {/* Live normalized preview — names are lowercase slugs (`#ops-oncall`);
            showing the real result beats rejecting it after submit. */}
        {normalized && normalized !== name.trim() && (
          <p className="muted u-fs-11 u-mt-0 u-mb-2">{t('channelNamePreview', { name: `#${normalized}` })}</p>
        )}
        <label className="field">
          <span className="field-label">{t('channelDescriptionLabel')}</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('channelDescriptionPlaceholder')} rows={2} maxLength={1000} disabled={busy} />
        </label>
        <label className="field u-w-auto">
          <span className="field-label">{t('visibilityLabel')}</span>
          <select value={visibility} onChange={(e) => setVisibility(e.target.value === 'private' ? 'private' : 'public')} disabled={busy}>
            <option value="public">{t('visibilityPublic')}</option>
            <option value="private">{t('visibilityPrivate')}</option>
          </select>
        </label>
        <p className="muted u-fs-12 u-mt-1">{visibility === 'private' ? t('visibilityPrivateHint') : t('visibilityPublicHint')}</p>
        {/* ADR 0192 D4 — invite people + agents in the SAME flow, so the room
            is alive from message one. */}
        <MemberPicker selectedIds={memberUserIds} onChange={setMemberUserIds} />
        <AgentPicker selectedIds={agentIds} onChange={setAgentIds} />
        {overCap && <p className="u-fs-12 chanpicker-error">{t('channelInviteCap')}</p>}
        <div className="u-flex u-gap-2 u-justify-end u-mt-3">
          <Button variant="secondary" onClick={onClose} disabled={busy}>{tc('cancel')}</Button>
          <Button variant="primary" type="submit" disabled={!normalized || busy || overCap}>{tc('create')}</Button>
        </div>
      </form>
    </Modal>
  );
}
