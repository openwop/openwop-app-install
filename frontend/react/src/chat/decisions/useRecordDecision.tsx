/**
 * ADR 0853 D2 — "Record as decision" on a message in a project's chat or a
 * channel bound to a project.
 *
 * The hook resolves the conversation's project (a project chat's owner subject,
 * or a channel's bound project) and, when that project HAS a ledger and the
 * ledger toggle is on, returns `onRecord` for the message actions plus the
 * dialog to render. Nothing is written until the person presses Record: the
 * dialog is prefilled from the message (title from its first line), and the
 * ledger OWNER may also tick "Accept it now" — anyone else's record is a
 * proposal the owner decides on.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Modal } from '../../ui/Modal.js';
import { Notice } from '../../ui/Notice.js';
import { toast } from '../../ui/toast.js';
import { useBackendSession } from '../../auth/backendSession.js';
import { getChannel } from '../../client/channelsClient.js';
import { getTeamLedger, recordDecision, type RecordDecisionInput } from '../../features/projects/teamLedgerClient.js';
import { messageText, type ChatMessage } from '../types.js';

const TITLE_MAX = 160;

export function titleFrom(text: string): string {
  const first = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

export function useRecordDecision({ sessionId, projectIdHint, isChannel }: { sessionId: string; projectIdHint: string | null; isChannel: boolean }): {
  onRecord: ((m: ChatMessage) => void) | undefined;
  dialog: JSX.Element | null;
} {
  const me = useBackendSession().user?.userId;
  const [target, setTarget] = useState<{ projectId: string; ownerSubject: string } | null>(null);
  const [open, setOpen] = useState<ChatMessage | null>(null);

  useEffect(() => {
    setTarget(null);
    let live = true;
    void (async () => {
      try {
        const projectId = projectIdHint ?? (isChannel ? (await getChannel(sessionId)).channel?.boundProjectId ?? null : null);
        if (!projectId) return;
        const { ledger } = await getTeamLedger(projectId);
        if (live && ledger) setTarget({ projectId, ownerSubject: ledger.ownerSubject });
      } catch { /* no action offered: the message menu stays as it was */ }
    })();
    return () => { live = false; };
  }, [sessionId, projectIdHint, isChannel]);

  const onRecord = useCallback((m: ChatMessage) => setOpen(m), []);
  if (!target) return { onRecord: undefined, dialog: null };
  return {
    onRecord,
    dialog: open ? (
      <RecordDecisionDialog
        projectId={target.projectId}
        isOwner={!!me && me === target.ownerSubject}
        prefill={{ title: titleFrom(messageText(open)), text: messageText(open) }}
        source={{ kind: 'message', ref: open.id, link: `/chat?conversation=${encodeURIComponent(sessionId)}` }}
        onClose={() => setOpen(null)}
      />
    ) : null,
  };
}

/** The one record dialog: from a message (above) or from a suggestion (the Ledger tab). */
export function RecordDecisionDialog({ projectId, isOwner, prefill, source, suggestionId, onClose, onDone }: {
  projectId: string; isOwner: boolean;
  prefill: { title: string; text: string };
  source?: NonNullable<RecordDecisionInput['source']>;
  suggestionId?: string;
  onClose: () => void;
  onDone?: () => void;
}): JSX.Element {
  const { t } = useTranslation('chat');
  const [title, setTitle] = useState(prefill.title);
  const [decision, setDecision] = useState(prefill.text);
  const [rationale, setRationale] = useState('');
  const [accept, setAccept] = useState(isOwner);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const canSend = title.trim().length > 0 && decision.trim().length > 0 && !busy;

  const submit = async (): Promise<void> => {
    setBusy(true); setFailed(false);
    try {
      const r = await recordDecision(projectId, {
        title: title.trim(), decision: decision.trim(), ...(rationale.trim() ? { rationale: rationale.trim() } : {}),
        ...(source ? { source } : {}),
        ...(suggestionId ? { suggestionId } : {}),
        ...(isOwner && accept ? { accept: true } : {}),
      });
      toast.success(r.accepted ? t('decisionRecordedAccepted') : t('decisionRecordedProposed'));
      onDone?.();
      onClose();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={t('recordDecisionTitle')} showClose>
      <h2 className="u-mt-0 u-fs-16">{t('recordDecisionTitle')}</h2>
      <p className="muted u-fs-12">{isOwner ? t('recordDecisionLedeOwner') : t('recordDecisionLede')}</p>
      {failed ? <Notice variant="error" announce={t('recordDecisionFailed')}>{t('recordDecisionFailed')}</Notice> : null}
      <form onSubmit={(e) => { e.preventDefault(); if (canSend) void submit(); }}>
        <label className="field">
          <span className="field-label">{t('recordDecisionTitleLabel')}</span>
          <input value={title} maxLength={TITLE_MAX} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
        </label>
        <label className="field">
          <span className="field-label">{t('recordDecisionTextLabel')}</span>
          <textarea value={decision} rows={4} maxLength={4000} onChange={(e) => setDecision(e.target.value)} disabled={busy} />
        </label>
        <label className="field">
          <span className="field-label">{t('recordDecisionRationaleLabel')}</span>
          <textarea value={rationale} rows={2} maxLength={4000} onChange={(e) => setRationale(e.target.value)} disabled={busy} />
        </label>
        {isOwner ? (
          <label className="u-flex u-items-center u-gap-1 u-fs-13 u-mb-2">
            <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} disabled={busy} /> {t('recordDecisionAcceptNow')}
          </label>
        ) : null}
        <div className="u-flex u-justify-end u-gap-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>{t('common:cancel')}</Button>
          <Button type="submit" variant="accent-solid" size="sm" disabled={!canSend}>{t('recordDecisionSubmit')}</Button>
        </div>
      </form>
    </Modal>
  );
}
