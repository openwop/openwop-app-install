/**
 * Channel settings dialog (ADR 0154 Phase 2) — chat CHROME launched from the
 * channel-only settings control in the header. Rename · archive · members, all
 * OWNER-gated. Ownership is decided by the SERVER (`detail.viewerIsOwner`) — the
 * client never reconstructs the backend identity (ownerUserId is `oidc:<sub>` /
 * `user:<hash>`, not the raw uid); the backend `assertChannelManage` is the real
 * authority regardless. Visibility is read-only (fixed at creation). Archive
 * confirms INLINE (not via a second Modal — stacked Modals fight over Escape +
 * the focus trap).
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../ui/Modal.js';
import {
  getChannel, renameChannel, archiveChannel, addChannelMember, addChannelAgent, removeChannelMember, removeChannelAgent,
  type ChannelDetail,
} from '../../client/channelsClient.js';
import { BotIcon } from '../../ui/icons/index.js';

interface Props {
  channelId: string;
  onClose: () => void;
  /** Refresh the rail's conversation list after a change (name/membership). */
  onChanged: () => void | Promise<void>;
  /** The channel was archived — the surface should drop it (reset/close). */
  onArchived: () => void;
}

/** `user:abc` / `agent:abc` → `abc` for display (no name resolution in v1). */
function subjectLabel(ref: string): string {
  const i = ref.indexOf(':');
  return i >= 0 ? ref.slice(i + 1) : ref;
}

export function ChannelManageDialog({ channelId, onClose, onChanged, onArchived }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  const { t: tc } = useTranslation('common');
  const [detail, setDetail] = useState<ChannelDetail | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [name, setName] = useState('');
  const [newMember, setNewMember] = useState('');
  const [newAgent, setNewAgent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingArchive, setConfirmingArchive] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    setLoadFailed(false);
    try {
      const d = await getChannel(channelId);
      setDetail(d);
      setName(d.channel?.name ?? '');
    } catch {
      setLoadFailed(true);
    }
  }, [channelId]);

  useEffect(() => { void reload(); }, [reload]);

  const isOwner = detail?.viewerIsOwner === true;

  const run = useCallback(async (op: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await op();
      await reload();
      await onChanged();
    } catch {
      setError(t('manageError'));
    } finally {
      setBusy(false);
    }
  }, [reload, onChanged, t]);

  const onRename = (): void => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === detail?.channel?.name) return;
    void run(() => renameChannel(channelId, trimmed));
  };

  const onAdd = (): void => {
    const uid = newMember.trim();
    if (!uid) return;
    void run(async () => { await addChannelMember(channelId, uid); setNewMember(''); });
  };

  const onAddAgent = (): void => {
    const aid = newAgent.trim();
    if (!aid) return;
    void run(async () => { await addChannelAgent(channelId, aid); setNewAgent(''); });
  };

  const doArchive = (): void => {
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await archiveChannel(channelId);
        await onChanged();
        onArchived();
        onClose();
      } catch {
        setError(t('manageError'));
        setBusy(false);
        setConfirmingArchive(false);
      }
    })();
  };

  // Load-failure terminal state — never a perpetual skeleton (the Modal's
  // `loading` only covers the in-flight fetch).
  if (loadFailed) {
    return (
      <Modal onClose={onClose} label={t('manageChannelTitle')} showClose error={t('manageError')}>
        <h2 className="u-mt-0 u-fs-16">{t('manageChannelTitle')}</h2>
        <div className="u-flex u-justify-end u-gap-2 u-mt-3">
          <button type="button" className="secondary" onClick={onClose}>{tc('close')}</button>
          <button type="button" className="btn-primary" onClick={() => void reload()}>{tc('retry')}</button>
        </div>
      </Modal>
    );
  }

  const members = detail?.participants ?? [];

  return (
    <Modal onClose={onClose} label={t('manageChannelTitle')} showClose loading={detail === null} {...(error ? { error } : {})}>
      <h2 className="u-mt-0 u-fs-16">{t('manageChannelTitle')}</h2>

      {/* Name — the owner edits; everyone else sees static text. */}
      {isOwner ? (
        <>
          <label className="field">
            <span className="field-label">{t('renameChannelLabel')}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} disabled={busy} maxLength={80} />
          </label>
          <div className="u-flex u-justify-end u-mb-2">
            <button type="button" className="secondary btn-sm" disabled={busy || !name.trim() || name.trim() === detail?.channel?.name} onClick={onRename}>{tc('save')}</button>
          </div>
        </>
      ) : (
        <p className="u-fs-12 u-mb-2">
          <span className="field-label">{t('renameChannelLabel')}: </span>
          <span>{detail?.channel?.name}</span>
        </p>
      )}

      {/* Visibility — always read-only (fixed at creation; no mutate route). */}
      <p className="u-fs-12 u-mb-2">
        <span className="field-label">{t('visibilityLabel')}: </span>
        <span className="muted">{detail?.channel?.visibility === 'private' ? t('visibilityPrivate') : t('visibilityPublic')}</span>
      </p>

      {/* Members. */}
      <h3 className="u-fs-13 u-mb-1">{t('membersLabel')}</h3>
      <ul className="u-list-none u-m-0 u-p-0 u-mb-2">
        {members.map((m) => {
          const isAgent = m.subjectRef.startsWith('agent:');
          const id = subjectLabel(m.subjectRef);
          const roleLabel = m.role === 'owner' ? t('roleOwner') : isAgent ? t('roleAgent') : t('roleMember');
          return (
            <li key={m.subjectRef} className="u-flex u-items-center u-justify-between u-gap-2 u-fs-12 u-pad-1-2">
              <span className="u-flex u-items-center u-gap-1-5">
                {isAgent ? <span aria-hidden className="u-iflex"><BotIcon size={12} /></span> : null}
                {id} <span className="muted">· {roleLabel}</span>
              </span>
              {/* The owner can remove any non-owner member — a user or an agent. */}
              {isOwner && m.role !== 'owner' ? (
                <button type="button" className="secondary btn-sm" disabled={busy} onClick={() => void run(() => (isAgent ? removeChannelAgent(channelId, id) : removeChannelMember(channelId, id)))} aria-label={t('removeMemberAria', { member: id })}>
                  {tc('remove')}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>

      {isOwner ? (
        <>
          <label className="field">
            <span className="field-label">{t('addMemberLabel')}</span>
            <div className="u-flex u-gap-2">
              <input value={newMember} onChange={(e) => setNewMember(e.target.value)} placeholder={t('addMemberPlaceholder')} disabled={busy} />
              <button type="button" className="secondary" disabled={busy || !newMember.trim()} onClick={onAdd}>{t('addMemberSubmit')}</button>
            </div>
          </label>
          {/* ADR 0154 Phase 4 — add an AGENT member; an addressed agent responds in-channel. */}
          <label className="field">
            <span className="field-label">{t('addAgentLabel')}</span>
            <div className="u-flex u-gap-2">
              <input value={newAgent} onChange={(e) => setNewAgent(e.target.value)} placeholder={t('addAgentPlaceholder')} disabled={busy} aria-describedby="channel-add-agent-hint" />
              <button type="button" className="secondary" disabled={busy || !newAgent.trim()} onClick={onAddAgent} aria-label={t('addAgentSubmit')}>{t('addMemberSubmit')}</button>
            </div>
          </label>
          <p id="channel-add-agent-hint" className="muted u-fs-11 u-mt-1 u-mb-2">{t('addAgentHint')}</p>

          {confirmingArchive ? (
            <div className="u-mt-3">
              {/* Archive is reversible → no danger treatment (ConfirmDialog convention). */}
              <p className="u-fs-12 u-mb-1">{t('archiveChannelConfirm')}</p>
              <div className="u-flex u-gap-2 u-justify-end">
                <button type="button" className="secondary" disabled={busy} onClick={() => setConfirmingArchive(false)}>{tc('cancel')}</button>
                <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={doArchive}>{t('archiveChannelCta')}</button>
              </div>
            </div>
          ) : (
            <div className="u-flex u-justify-between u-items-center u-mt-3">
              <button type="button" className="secondary btn-sm" disabled={busy} onClick={() => setConfirmingArchive(true)}>{t('archiveChannelCta')}</button>
              <button type="button" className="secondary" onClick={onClose}>{tc('close')}</button>
            </div>
          )}
        </>
      ) : (
        <p className="muted u-fs-12 u-mt-2">{t('ownerOnlyNote')}</p>
      )}
    </Modal>
  );
}
