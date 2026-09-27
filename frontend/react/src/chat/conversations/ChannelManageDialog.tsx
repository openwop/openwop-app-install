/**
 * Channel details dialog (ADR 0154 Phase 2, re-grounded by ADR 0192 D8) — chat
 * CHROME launched from the header's channel controls (settings gear + the
 * facepile) and the roster panel. THE one full-roster surface:
 *   - everyone: resolved member list (names + avatars, never raw ids),
 *     visibility, description;
 *   - the owner: rename (normalized), description edit, add people/agents via
 *     name-resolving pickers, remove members, archive (inline confirm — stacked
 *     Modals fight over Escape + the focus trap);
 *   - a non-owner member: Leave channel (the owner's exit is archive — the
 *     backend 409s an owner leave).
 * Ownership is decided by the SERVER (`detail.viewerIsOwner`); the backend
 * `assertChannelManage` is the real authority regardless.
 */

import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../ui/Modal.js';
import {
  getChannel, renameChannel, archiveChannel, addChannelMember, addChannelAgent, removeChannelMember, removeChannelAgent,
  updateChannelDescription, leaveChannel, setChannelAgentPolicy,
  type ChannelDetail,
} from '../../client/channelsClient.js';
import { Avatar } from '../../ui/Avatar.js';
import { MemberPicker, AgentPicker } from './MemberPickers.js';
import { ChannelSchedulePanel } from './ChannelSchedulePanel.js';
import { normalizeChannelName } from './channelName.js';

interface Props {
  channelId: string;
  onClose: () => void;
  /** Refresh the rail's conversation list after a change (name/membership). */
  onChanged: () => void | Promise<void>;
  /** The channel was archived — the surface should drop it (reset/close). */
  onArchived: () => void;
  /** The viewer left the channel — the surface should drop it (reset/close). */
  onLeft?: () => void;
}

export function ChannelManageDialog({ channelId, onClose, onChanged, onArchived, onLeft }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  const { t: tc } = useTranslation('common');
  const [detail, setDetail] = useState<ChannelDetail | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [addUserIds, setAddUserIds] = useState<string[]>([]);
  const [addAgentIds, setAddAgentIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [confirmingLeave, setConfirmingLeave] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    setLoadFailed(false);
    try {
      const d = await getChannel(channelId);
      setDetail(d);
      setName(d.channel?.name ?? '');
      setDescription(d.channel?.description ?? '');
    } catch {
      setLoadFailed(true);
    }
  }, [channelId]);

  useEffect(() => { void reload(); }, [reload]);

  const isOwner = detail?.viewerIsOwner === true;
  const roster = detail?.roster ?? [];
  const viewerRef = detail?.viewerSubjectRef ?? null;

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

  const onSaveDescription = (): void => {
    if (description.trim() === (detail?.channel?.description ?? '')) return;
    void run(() => updateChannelDescription(channelId, description.trim()));
  };

  const onAddSelected = (): void => {
    if (!addUserIds.length && !addAgentIds.length) return;
    // Sequential adds are safe to retry: addParticipant/addChannelAgent are
    // idempotent server-side (an existing member is a no-op), so a mid-loop
    // failure + retry can't duplicate anyone.
    void run(async () => {
      for (const uid of addUserIds) await addChannelMember(channelId, uid);
      for (const aid of addAgentIds) await addChannelAgent(channelId, aid);
      setAddUserIds([]);
      setAddAgentIds([]);
    });
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

  const doLeave = (): void => {
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await leaveChannel(channelId);
        await onChanged();
        onLeft?.();
        onClose();
      } catch {
        setError(t('leaveChannelError'));
        setBusy(false);
        setConfirmingLeave(false);
      }
    })();
  };

  // Load-failure terminal state — never a perpetual skeleton (the Modal's
  // `loading` only covers the in-flight fetch).
  if (loadFailed) {
    return (
      <Modal onClose={onClose} label={t('channelDetailsTitle')} showClose error={t('manageError')}>
        <h2 className="u-mt-0 u-fs-16">{t('channelDetailsTitle')}</h2>
        <div className="u-flex u-justify-end u-gap-2 u-mt-3">
          <Button variant="secondary" onClick={onClose}>{tc('close')}</Button>
          <Button variant="primary" onClick={() => void reload()}>{tc('retry')}</Button>
        </div>
      </Modal>
    );
  }

  const memberIdsInChannel = roster.filter((r) => r.kind === 'user').map((r) => r.subjectRef.slice('user:'.length));
  const agentIdsInChannel = roster.filter((r) => r.kind === 'agent').map((r) => r.subjectRef.slice('agent:'.length));

  return (
    <Modal onClose={onClose} label={t('channelDetailsTitle')} showClose loading={detail === null} {...(error ? { error } : {})}>
      <h2 className="u-mt-0 u-fs-16">{t('channelDetailsTitle')}</h2>

      {/* Name + description — the owner edits; everyone else reads. */}
      {isOwner ? (
        <>
          <label className="field">
            <span className="field-label">{t('renameChannelLabel')}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} disabled={busy} maxLength={80} />
          </label>
          {/* Live normalized preview — parity with the create dialog (names are
              lowercase slugs; the server is authoritative). */}
          {normalizeChannelName(name) && normalizeChannelName(name) !== name.trim() && (
            <p className="muted u-fs-11 u-mt-0 u-mb-1">{t('channelNamePreview', { name: `#${normalizeChannelName(name)}` })}</p>
          )}
          <div className="u-flex u-justify-end u-mb-2">
            <Button variant="secondary" size="sm" disabled={busy || !name.trim() || name.trim() === detail?.channel?.name} onClick={onRename}>{tc('save')}</Button>
          </div>
          <label className="field">
            <span className="field-label">{t('channelDescriptionLabel')}</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('channelDescriptionPlaceholder')} rows={2} maxLength={1000} disabled={busy} />
          </label>
          <div className="u-flex u-justify-end u-mb-2">
            <Button variant="secondary" size="sm" disabled={busy || description.trim() === (detail?.channel?.description ?? '')} onClick={onSaveDescription}>{tc('save')}</Button>
          </div>
        </>
      ) : (
        <>
          <p className="u-fs-13 u-mb-1">
            <span className="field-label">{t('renameChannelLabel')}: </span>
            <span>#{detail?.channel?.name}</span>
          </p>
          {detail?.channel?.description && <p className="muted u-fs-12 u-mb-2">{detail.channel.description}</p>}
        </>
      )}

      {/* Visibility — always read-only (fixed at creation; no mutate route). */}
      <p className="u-fs-12 u-mb-2">
        <span className="field-label">{t('visibilityLabel')}: </span>
        <span className="muted">{detail?.channel?.visibility === 'private' ? t('visibilityPrivate') : t('visibilityPublic')}</span>
      </p>

      {/* Members — the RESOLVED roster (ADR 0192 D2): names + avatars, never raw refs. */}
      <h3 className="u-fs-13 u-mb-1">{t('membersLabel')}</h3>
      <ul className="u-list-none u-m-0 u-p-0 u-mb-2">
        {roster.map((m) => {
          const isAgent = m.kind === 'agent';
          const isSelf = viewerRef !== null && m.subjectRef === viewerRef;
          const roleLabel = m.role === 'owner' ? t('roleOwner') : isAgent ? t('roleAgent') : t('roleMember');
          return (
            <li key={m.subjectRef} className="u-flex u-items-center u-justify-between u-gap-2 u-fs-12 u-pad-1-2">
              <span className="u-flex u-items-center u-gap-1-5">
                <Avatar name={m.displayName} size={22} kind={isAgent ? 'agent' : 'user'} />
                <span className="u-truncate">{m.displayName}</span>
                {isAgent && <span className="msgbubble-bot-badge">{t('botBadge')}</span>}
                {isSelf && <span className="chip chip--muted u-fs-10">{t('rosterYou')}</span>}
                <span className="muted">· {isAgent && m.mentionSlug ? `@${m.mentionSlug}` : roleLabel}</span>
              </span>
              {/* ADR 0202 D1/D4 — the agent's reply policy, visible + owner-editable
                  (the invisible sole-agent auto-reply, now a real control). */}
              {isAgent && (
                isOwner ? (
                  <label className="u-flex u-items-center u-gap-1 u-fs-11 muted">
                    {t('responsePolicyLabel')}
                    <select
                      className="chanroster-policy-select"
                      value={m.responsePolicy ?? 'mention'}
                      disabled={busy}
                      onChange={(e) => void run(() => setChannelAgentPolicy(channelId, m.subjectRef.slice('agent:'.length), e.target.value === 'all' ? 'all' : 'mention'))}
                      aria-label={t('responsePolicyAria', { agent: m.displayName })}
                    >
                      <option value="all">{t('responsePolicyAll')}</option>
                      <option value="mention">{t('responsePolicyMention')}</option>
                    </select>
                  </label>
                ) : (
                  <span className="muted u-fs-11">{t('responsePolicyLabel')}: {m.responsePolicy === 'all' ? t('responsePolicyAll') : t('responsePolicyMention')}</span>
                )
              )}
              {/* The owner can remove any non-owner member — a user or an agent. */}
              {isOwner && m.role !== 'owner' ? (
                <Button
                  variant="secondary" size="sm"
                  disabled={busy}
                  onClick={() => void run(() => (isAgent ? removeChannelAgent(channelId, m.subjectRef.slice('agent:'.length)) : removeChannelMember(channelId, m.subjectRef.slice('user:'.length))))}
                  aria-label={t('removeMemberAria', { member: m.displayName })}
                >
                  {tc('remove')}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>

      {isOwner ? (
        <>
          {/* Add people + agents — the same pickers as the create flow (no raw IDs). */}
          <MemberPicker selectedIds={addUserIds} onChange={setAddUserIds} excludeUserIds={memberIdsInChannel} />
          <AgentPicker selectedIds={addAgentIds} onChange={setAddAgentIds} excludeAgentIds={agentIdsInChannel} />
          <div className="u-flex u-justify-end u-mb-2">
            <Button variant="secondary" size="sm" disabled={busy || (!addUserIds.length && !addAgentIds.length)} onClick={onAddSelected}>{t('addMemberSubmit')}</Button>
          </div>

          {/* ADR 0202 D3 — recurring agent posts, bound to a channel-member agent. */}
          <ChannelSchedulePanel
            channelId={channelId}
            agents={roster.filter((r) => r.kind === 'agent').map((r) => ({ agentId: r.subjectRef.slice('agent:'.length), displayName: r.displayName }))}
          />

          {confirmingArchive ? (
            <div className="u-mt-3">
              {/* Archive is reversible → no danger treatment (ConfirmDialog convention). */}
              <p className="u-fs-12 u-mb-1">{t('archiveChannelConfirm')}</p>
              <div className="u-flex u-gap-2 u-justify-end">
                <Button variant="secondary" disabled={busy} onClick={() => setConfirmingArchive(false)}>{tc('cancel')}</Button>
                <Button variant="primary" size="sm" disabled={busy} onClick={doArchive}>{t('archiveChannelCta')}</Button>
              </div>
            </div>
          ) : (
            <div className="u-flex u-justify-between u-items-center u-mt-3">
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirmingArchive(true)}>{t('archiveChannelCta')}</Button>
              <Button variant="secondary" onClick={onClose}>{tc('close')}</Button>
            </div>
          )}
        </>
      ) : confirmingLeave ? (
        <div className="u-mt-3">
          <p className="u-fs-12 u-mb-1">{t('leaveChannelConfirmBody')}</p>
          <div className="u-flex u-gap-2 u-justify-end">
            <Button variant="secondary" disabled={busy} onClick={() => setConfirmingLeave(false)}>{tc('cancel')}</Button>
            <Button variant="primary" size="sm" disabled={busy} onClick={doLeave}>{t('leaveChannelCta')}</Button>
          </div>
        </div>
      ) : (
        <div className="u-flex u-justify-between u-items-center u-mt-3">
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirmingLeave(true)}>{t('leaveChannelCta')}</Button>
          <Button variant="secondary" onClick={onClose}>{tc('close')}</Button>
        </div>
      )}
    </Modal>
  );
}
