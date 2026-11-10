/**
 * ADR 1042 D9 — the approve dialog. One dialog, two shapes:
 *
 *  - a PERSON: says what an approval does (the sender's messages run as the
 *    approver) and that an outside sender gets only the reviewed read tools.
 *  - a GROUP (`group:<chatId>`): the D9 warning first — every member acts with
 *    the approver's authority — and the Approve button stays disabled until the
 *    approver ticks the acknowledgement. The ADR requires this page to say it
 *    BEFORE a group is approved, so the warning is not dismissable and the
 *    confirmation is not optional.
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../ui/Modal.js';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { CheckboxField, TextField } from '../../ui/Field.js';
import { isGroupSender } from './channelIngressClient.js';

export function ApproveSenderDialog({ senderId, botHandle, groupNote, busy, error, onApprove, onClose }: {
  senderId: string;
  /** The connection's bot handle, if set: a group is answered only when mentioned. */
  botHandle?: string | undefined;
  /** ADR 1043 D9 — replaces the bot-handle line where the lane has no handle (a relay device). */
  groupNote?: string | undefined;
  busy: boolean;
  error: string | null;
  onApprove: (label: string | undefined) => void;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation('channel-ingress');
  const id = useId();
  const group = isGroupSender(senderId);
  const [ack, setAck] = useState(false);
  const [label, setLabel] = useState('');
  const title = group ? t('approveGroupTitle', { sender: senderId }) : t('approveTitle', { sender: senderId });
  const armed = !busy && (!group || ack);
  return (
    <Modal onClose={onClose} label={title} showClose describedBy={`${id}-body`} error={error ?? undefined} errorAnnounce={error ?? undefined}>
      <form
        className="u-grid u-gap-3"
        aria-busy={busy || undefined}
        onSubmit={(e) => { e.preventDefault(); if (armed) onApprove(label.trim() || undefined); }}
      >
        <h2 className="u-m-0">{title}</h2>
        <div id={`${id}-body`} className="u-grid u-gap-2">
          {group ? (
            <>
              <Notice variant="warning">{t('approveGroupWarning')}</Notice>
              <p className="muted u-m-0 u-fs-13">{groupNote ?? (botHandle ? t('approveGroupMention') : t('approveGroupNoHandle'))}</p>
            </>
          ) : (
            <Notice variant="info">{t('approveDmBody')}</Notice>
          )}
        </div>
        <TextField label={t('approveLabel')} help={t('approveLabelHelp')} value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
        {group ? (
          <CheckboxField label={t('approveGroupAck')} required checked={ack} onChange={(e) => setAck(e.target.checked)} />
        ) : null}
        <div className="action-bar">
          <Button variant="secondary" type="button" onClick={onClose}>{t('common:cancel')}</Button>
          <Button variant="primary" type="submit" disabled={!armed}>{group ? t('approveGroupConfirm') : t('approveConfirm')}</Button>
        </div>
      </form>
    </Modal>
  );
}
