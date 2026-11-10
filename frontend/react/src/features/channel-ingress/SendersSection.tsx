/**
 * ADR 1042 D3/D9 — one connection's senders: the pending requests (approve or
 * deny) and the approved senders (revoke; "this is me").
 *
 * ADR 1043 D9 (CHAN-P1b) — the same section for ONE relay device's senders
 * (`relayId`). Its owner approves and denies; a workspace admin who is not the
 * owner (`canApprove: false`) sees only the approved senders and may revoke one.
 * A device has no "this is me": its owner's own lane is the note-to-self chat.
 *
 * "This is me" is offered only on a row the server marked `mine` (the caller
 * approved it, the one person `PUT …/self` accepts) and never on a group. The
 * server is still the authority; the page only avoids offering a control that
 * would be refused.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { Notice } from '../../ui/Notice.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { StatusBadge } from '../../ui/StatusBadge.js';
import { confirm } from '../../ui/confirm.js';
import { toast } from '../../ui/toast.js';
import { formatDateTime } from '../../i18n/format.js';
import { ApproveSenderDialog } from './ApproveSenderDialog.js';
import {
  approveRelaySender, approveSender, denyPendingSender, denyRelayPendingSender, isGroupSender, listRelaySenders, listSenders,
  refusalMessage, revokeRelaySender, revokeSender, setSenderSelf,
  type ApprovedSender, type PendingSender,
} from './channelIngressClient.js';

const senderName = (s: { senderId: string; label?: string | undefined }): string => s.label ? `${s.label} (${s.senderId})` : s.senderId;

function SenderCell({ senderId, label, self }: { senderId: string; label?: string | undefined; self?: boolean | undefined }): JSX.Element {
  const { t } = useTranslation('channel-ingress');
  return (
    <span className="u-flex u-flex-wrap u-items-center u-gap-1 u-min-w-0">
      <span className="u-flex u-flex-col u-min-w-0">
        {label ? <strong className="u-truncate">{label}</strong> : null}
        <code className={`u-fs-12 u-truncate${label ? ' muted' : ''}`}>{senderId}</code>
      </span>
      {isGroupSender(senderId) ? <StatusBadge status="waiting" label={t('groupBadge')} /> : null}
      {self ? <StatusBadge status="completed" label={t('selfBadge')} /> : null}
    </span>
  );
}

/** Which lane's senders: a hosted connection, or one relay device (ADR 1043 D9). */
export type SendersLane =
  | { connectionId: string; botHandle?: string | undefined; relayId?: undefined }
  | { relayId: string; connectionId?: undefined; botHandle?: undefined };

/** The lane's routes, chosen once: the section's controls never branch on the lane. */
function laneApi(lane: SendersLane) {
  if (lane.relayId !== undefined) {
    const id = lane.relayId;
    return {
      key: `relay-${id}`,
      list: () => listRelaySenders(id),
      approve: (s: string, label?: string) => approveRelaySender(id, s, label),
      deny: (s: string) => denyRelayPendingSender(id, s),
      revoke: (s: string) => revokeRelaySender(id, s),
      setSelf: null,
    };
  }
  const id = lane.connectionId;
  return {
    key: id,
    list: async () => ({ ...(await listSenders(id)), canApprove: true }),
    approve: (s: string, label?: string) => approveSender(id, s, label),
    deny: (s: string) => denyPendingSender(id, s),
    revoke: (s: string) => revokeSender(id, s),
    setSelf: (s: string, self: boolean) => setSenderSelf(id, s, self),
  };
}

export function SendersSection(lane: SendersLane): JSX.Element {
  const { t } = useTranslation('channel-ingress');
  const { relayId, connectionId, botHandle } = lane;
  const api = useMemo(() => laneApi(relayId !== undefined ? { relayId } : { connectionId: connectionId ?? '' }), [relayId, connectionId]);
  const scope = api.key;
  const [data, setData] = useState<{ approved: ApprovedSender[]; pending: PendingSender[]; canApprove: boolean } | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [approving, setApproving] = useState<string | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);

  const load = useCallback(() => {
    setFailed(false);
    void api.list().then(setData).catch(() => setFailed(true));
  }, [api]);
  useEffect(() => { setData(null); load(); }, [load]);

  /** One write at a time; a failure is a toast in the server's own words when it gave any. */
  const act = useCallback(async (key: string, op: () => Promise<unknown>, ok: string, failedMsg: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(key);
    try { await op(); toast.success(ok); load(); return true; } catch (err) { toast.error(refusalMessage(err) ?? failedMsg); return false; } finally { setBusy(null); }
  }, [busy, load]);

  const approve = useCallback(async (label: string | undefined) => {
    if (!approving || busy) return;
    setBusy(approving);
    setApproveError(null);
    try {
      await api.approve(approving, label);
      toast.success(t('approved'));
      setApproving(null);
      load();
    } catch (err) {
      setApproveError(refusalMessage(err) ?? t('approveFailed'));
    } finally {
      setBusy(null);
    }
  }, [approving, busy, api, load, t]);

  const deny = useCallback(async (p: PendingSender) => {
    if (!(await confirm({ title: t('denyTitle', { sender: p.senderId }), body: t('denyBody'), confirmLabel: t('deny'), danger: true }))) return;
    await act(p.senderId, () => api.deny(p.senderId), t('denied'), t('denyFailed'));
  }, [act, api, t]);

  const revoke = useCallback(async (s: ApprovedSender) => {
    if (!(await confirm({ title: t('revokeTitle', { sender: senderName(s) }), body: t('revokeBody'), confirmLabel: t('revoke'), danger: true }))) return;
    await act(s.senderId, () => api.revoke(s.senderId), t('revoked'), t('revokeFailed'));
  }, [act, api, t]);

  const toggleSelf = useCallback(async (s: ApprovedSender) => {
    const setSelf = api.setSelf;
    if (!setSelf) return;
    const next = s.self !== true;
    if (next && !(await confirm({ title: t('selfTitle', { sender: senderName(s) }), body: t('selfBody'), confirmLabel: t('selfConfirm') }))) return;
    await act(s.senderId, () => setSelf(s.senderId, next), t('selfSaved'), t('selfFailed'));
  }, [act, api, t]);

  const pendingColumns: DataColumn<PendingSender>[] = [
    { key: 'sender', header: t('colSender'), sortValue: (p) => p.senderId, render: (p) => <SenderCell senderId={p.senderId} /> },
    { key: 'seen', header: t('colSeen'), cellClassName: 'u-tabular', sortValue: (p) => p.lastSeenAt, render: (p) => formatDateTime(p.lastSeenAt) },
    { key: 'count', header: t('colMessages'), align: 'right', cellClassName: 'u-tabular', sortValue: (p) => p.count, render: (p) => p.count },
    { key: 'actions', header: '', align: 'right', render: (p) => (
      <span className="u-flex u-flex-wrap u-gap-1 u-justify-end">
        <Button variant="primary" size="sm" disabled={busy !== null} aria-label={t('approveAria', { sender: p.senderId })} onClick={() => { setApproveError(null); setApproving(p.senderId); }}>{t('approve')}</Button>
        <Button variant="quiet" size="sm" disabled={busy !== null} aria-label={t('denyAria', { sender: p.senderId })} onClick={() => void deny(p)}>{t('deny')}</Button>
      </span>
    ) },
  ];

  const approvedColumns: DataColumn<ApprovedSender>[] = [
    { key: 'sender', header: t('colSender'), sortValue: (s) => s.label ?? s.senderId, render: (s) => <SenderCell senderId={s.senderId} label={s.label} self={s.self} /> },
    { key: 'by', header: t('colApprovedBy'), render: (s) => (s.mine ? t('approvedByYou') : t('approvedByOther')) },
    { key: 'at', header: t('colApprovedAt'), cellClassName: 'u-tabular', sortValue: (s) => s.approvedAt, render: (s) => formatDateTime(s.approvedAt) },
    { key: 'actions', header: '', align: 'right', render: (s) => (
      <span className="u-flex u-flex-wrap u-gap-1 u-justify-end">
        {api.setSelf && s.mine && !isGroupSender(s.senderId) ? (
          <Button
            variant="secondary" size="sm" disabled={busy !== null} aria-pressed={s.self === true}
            aria-label={s.self ? t('unmarkSelfAria', { sender: senderName(s) }) : t('markSelfAria', { sender: senderName(s) })}
            onClick={() => void toggleSelf(s)}
          >{s.self ? t('unmarkSelf') : t('markSelf')}</Button>
        ) : null}
        <Button variant="quiet" size="sm" disabled={busy !== null} aria-label={t('revokeAria', { sender: senderName(s) })} onClick={() => void revoke(s)}>{t('revoke')}</Button>
      </span>
    ) },
  ];

  if (failed) {
    return (
      <div className="u-grid u-gap-2">
        <Notice variant="error" announce={t('sendersLoadError')}>{t('sendersLoadError')}</Notice>
        <div><Button variant="quiet" size="sm" onClick={load}>{t('retry')}</Button></div>
      </div>
    );
  }
  if (!data) return <SkeletonRows rows={3} columns={['1fr', '160px', '80px', '180px']} />;

  return (
    <>
      {data.canApprove ? (
        <section className="u-grid u-gap-2" aria-labelledby={`pending-${scope}`}>
          <div>
            <h4 id={`pending-${scope}`} className="u-fs-14 u-m-0">{t('pendingTitle')}</h4>
            <p className="muted u-fs-13 u-m-0">{t('pendingHint')}</p>
          </div>
          <DataTable stack columns={pendingColumns} rows={data.pending} rowKey={(p) => p.senderId} caption={t('pendingTitle')}
            empty={<p className="muted u-fs-13 u-m-0">{t('pendingEmpty')}</p>} />
        </section>
      ) : (
        <Notice variant="info">{t('relayAdminOnly')}</Notice>
      )}
      <section className="u-grid u-gap-2" aria-labelledby={`approved-${scope}`}>
        <div>
          <h4 id={`approved-${scope}`} className="u-fs-14 u-m-0">{t('approvedTitle')}</h4>
          <p className="muted u-fs-13 u-m-0">{relayId !== undefined ? t('relayApprovedHint') : `${t('approvedHint')} ${t('selfExplain')}`}</p>
        </div>
        <DataTable stack columns={approvedColumns} rows={data.approved} rowKey={(s) => s.senderId} caption={t('approvedTitle')}
          empty={<p className="muted u-fs-13 u-m-0">{t('approvedEmpty')}</p>} />
      </section>
      {approving ? (
        <ApproveSenderDialog
          senderId={approving}
          botHandle={botHandle}
          {...(relayId !== undefined ? { groupNote: t('approveGroupRelay') } : {})}
          busy={busy === approving}
          error={approveError}
          onApprove={(label) => void approve(label)}
          onClose={() => { if (!busy) setApproving(null); }}
        />
      ) : null}
    </>
  );
}
