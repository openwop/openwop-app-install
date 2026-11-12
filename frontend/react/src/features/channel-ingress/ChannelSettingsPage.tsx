/**
 * Chat channels — the channels settings page (ADR 1042, CHAN-P0-8).
 *
 * Gated on the `channel-ingress` toggle. Three things a workspace owner does here:
 *  1. Sees each connection that can carry chat messages (Telegram, Discord,
 *     Slack, WhatsApp via Twilio or the Cloud API), its inbound mode and the
 *     agent that answers it, and opens one to change its settings.
 *  2. Reviews that connection's senders: approves or denies pending requests
 *     (a group only after the D9 warning is acknowledged), revokes approvals,
 *     and marks their own account "this is me".
 *  3. Sees the workspace's relay devices (owner, account, heartbeat) and
 *     revokes one it may revoke (its own, or any as a workspace admin).
 *  4. ADR 1043 D9 (CHAN-P1b) — opens one of THEIR OWN devices to approve or deny
 *     who may write to it, with the connection's own senders section and group
 *     warning; a workspace admin opens any device to revoke an approval.
 *  5. CHAN-F11 — a workspace admin switches one relay channel off for the whole
 *     workspace (say, WhatsApp only); everyone sees which channels are off, and a
 *     device on one shows as paused.
 *
 * NOT a chat (CLAUDE.md "AI chat — reuse"): channel conversations land in the
 * main chat; this page only manages who may write in and who answers.
 *
 * Every read is one of the routes ADR 1042 exposes (see channelIngressClient).
 * A connection the caller cannot manage answers 403 on its settings reads, so
 * the row says so instead of guessing.
 */
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../../ui/PageHeader.js';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { StatusBadge } from '../../ui/StatusBadge.js';
import { confirm } from '../../ui/confirm.js';
import { toast } from '../../ui/toast.js';
import { MessageCircleIcon, SmartphoneIcon } from '../../ui/icons/index.js';
import { formatDateTime } from '../../i18n/format.js';
import { useHub } from '../../chrome/hubContext.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { listAgents, type AgentEntry } from '../../client/agentsClient.js';
import { ConnectionChannelPanel } from './ConnectionChannelPanel.js';
import { SendersSection } from './SendersSection.js';
import {
  getChannelSettings, getInbound, getRelayChannels, listChannelConnections, listRelayDevices, refusalMessage, revokeRelayDevice, setRelayChannel,
  type ChannelConnection, type ChannelSettings, type InboundConfig, type RelayChannelSwitches, type RelayDevice,
} from './channelIngressClient.js';

export const CHANNEL_INGRESS_FEATURE = 'channel-ingress';

type RowInfo =
  | { state: 'loading' }
  | { state: 'ok'; inbound: InboundConfig | null; settings: ChannelSettings | null }
  | { state: 'forbidden' }
  | { state: 'error' };

const statusOf = (err: unknown): number | undefined => {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
};

function useProviderLabel(): (provider: string) => string {
  const { t } = useTranslation('channel-ingress');
  return useCallback((provider: string) => t(`provider_${provider}`, { defaultValue: provider }), [t]);
}

function ConnectionsSection(): JSX.Element {
  const { t } = useTranslation('channel-ingress');
  const navigate = useNavigate();
  const providerLabel = useProviderLabel();
  const [connections, setConnections] = useState<ChannelConnection[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [info, setInfo] = useState<Record<string, RowInfo>>({});
  const [agents, setAgents] = useState<readonly AgentEntry[] | null>(null);
  const [agentsFailed, setAgentsFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const loadRow = useCallback(async (c: ChannelConnection): Promise<RowInfo> => {
    const [inbound, settings] = await Promise.allSettled([getInbound(c.connectionId), getChannelSettings(c.connectionId)]);
    if (inbound.status === 'fulfilled' && settings.status === 'fulfilled') return { state: 'ok', inbound: inbound.value, settings: settings.value };
    const refused = [inbound, settings].some((r) => r.status === 'rejected' && (statusOf(r.reason) === 403 || statusOf(r.reason) === 404));
    return refused ? { state: 'forbidden' } : { state: 'error' };
  }, []);

  const load = useCallback(() => {
    setFailed(false);
    setConnections(null);
    void listChannelConnections().then((cs) => {
      setConnections(cs);
      setInfo(Object.fromEntries(cs.map((c) => [c.connectionId, { state: 'loading' } as RowInfo])));
      for (const c of cs) void loadRow(c).then((r) => setInfo((prev) => ({ ...prev, [c.connectionId]: r })));
    }).catch(() => setFailed(true));
  }, [loadRow]);
  useEffect(load, [load]);
  useEffect(() => { void listAgents().then(setAgents).catch(() => setAgentsFailed(true)); }, []);

  const agentName = useCallback((agentId?: string): string => {
    if (!agentId) return t('defaultAssistant');
    return agents?.find((a) => a.agentId === agentId)?.label || agentId;
  }, [agents, t]);

  const columns = useMemo<DataColumn<ChannelConnection>[]>(() => [
    { key: 'name', header: t('colConnection'), sortValue: (c) => c.displayName, render: (c) => {
      const row = info[c.connectionId];
      const inboundProvider = row?.state === 'ok' && row.inbound ? row.inbound.provider : c.provider;
      return (
        <span className="u-flex u-flex-col u-gap-0-5 u-min-w-0">
          <strong className="u-truncate">{c.displayName}</strong>
          <span className="u-fs-12 muted">{providerLabel(inboundProvider)}</span>
        </span>
      );
    } },
    { key: 'mode', header: t('colMode'), render: (c) => {
      const row = info[c.connectionId];
      if (!row || row.state === 'loading') return <span className="u-fs-12 muted" aria-busy="true">{t('rowLoading')}</span>;
      if (row.state === 'forbidden') return <span className="u-fs-12 muted">{t('notManageable')}</span>;
      if (row.state === 'error') return <span className="u-fs-12 u-text-danger">{t('rowLoadError')}</span>;
      const mode = !row.inbound ? 'none' : row.inbound.mode === 'conversation' ? 'conversation' : 'workflow';
      return <StatusBadge status={mode === 'conversation' ? 'completed' : mode === 'workflow' ? 'waiting' : 'cancelled'} label={t(`mode_${mode}`)} />;
    } },
    { key: 'agent', header: t('colAgent'), render: (c) => {
      const row = info[c.connectionId];
      return row?.state === 'ok' ? agentName(row.settings?.agentId) : '—';
    } },
    { key: 'actions', header: '', align: 'right', render: (c) => (
      info[c.connectionId]?.state === 'ok' ? (
        <Button variant="secondary" size="sm" aria-expanded={selected === c.connectionId} aria-label={t('manageAria', { name: c.displayName })}
          onClick={() => setSelected((s) => (s === c.connectionId ? null : c.connectionId))}>{t('manage')}</Button>
      ) : null
    ) },
  ], [t, info, selected, agentName, providerLabel]);

  const current = connections?.find((c) => c.connectionId === selected);
  const currentInfo = current ? info[current.connectionId] : undefined;

  return (
    <section className="u-grid u-gap-3" aria-labelledby="chan-connections-title">
      <div>
        <h2 id="chan-connections-title" className="u-fs-16 u-m-0">{t('connectionsTitle')}</h2>
        <p className="muted u-fs-13 u-m-0">{t('connectionsHint')}</p>
      </div>
      {failed ? (
        <>
          <Notice variant="error" announce={t('connectionsLoadError')}>{t('connectionsLoadError')}</Notice>
          <div><Button variant="quiet" size="sm" onClick={load}>{t('retry')}</Button></div>
        </>
      ) : connections === null ? (
        <SkeletonRows rows={3} columns={['1fr', '160px', '160px', '120px']} />
      ) : (
        <DataTable stack columns={columns} rows={connections} rowKey={(c) => c.connectionId} caption={t('connectionsCaption')}
          empty={<StateCard icon={<MessageCircleIcon />} title={t('connectionsEmpty')} body={t('connectionsEmptyBody')}
            action={<Button variant="secondary" onClick={() => navigate('/access?tab=connections')}>{t('openConnections')}</Button>} />} />
      )}
      {current && currentInfo?.state === 'ok' ? (
        <ConnectionChannelPanel
          connection={current}
          inbound={currentInfo.inbound}
          settings={currentInfo.settings}
          agents={agents}
          agentsFailed={agentsFailed}
          onSettingsSaved={(s) => setInfo((prev) => ({ ...prev, [current.connectionId]: { ...currentInfo, settings: s } }))}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </section>
  );
}

/** ADR 1043 D9 — one device's senders, for its owner (or an admin, who may revoke). */
function RelaySendersPanel({ device, onClose }: { device: RelayDevice; onClose: () => void }): JSX.Element {
  const { t } = useTranslation('channel-ingress');
  const id = useId();
  return (
    <section className="surface-card u-grid u-gap-4" aria-labelledby={`${id}-title`}>
      <div className="u-flex u-items-center u-justify-between u-gap-2">
        <h3 id={`${id}-title`} className="u-fs-16 u-m-0">{t('relayPanelTitle', { device: device.deviceName ?? device.relayId })}</h3>
        <Button variant="quiet" size="sm" onClick={onClose}>{t('close')}</Button>
      </div>
      <p className="muted u-fs-13 u-m-0">{t('relayPanelHint')}</p>
      <SendersSection key={`r-${device.relayId}`} relayId={device.relayId} />
    </section>
  );
}

/** Who may open a device's senders: its owner, or a workspace admin (`canRevoke` on another's device). */
const canOpenSenders = (d: RelayDevice): boolean => d.status === 'active' && d.owner !== null && (d.owner.ownedByCaller || d.canRevoke);

/** CHAN-F11 — the per-channel relay switch. Admins get the switches; everyone else
 *  sees a notice only when a channel is off. */
function RelayChannelSwitchesPanel({ onChanged }: { onChanged: () => void }): JSX.Element | null {
  const { t } = useTranslation('channel-ingress');
  const [view, setView] = useState<RelayChannelSwitches | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => { void getRelayChannels().then(setView).catch(() => setView(null)); }, []);
  if (!view) return null;
  const nameOf = (channel: string): string => t(`channel_${channel}`, { defaultValue: channel });
  const off = view.channels.filter((c) => !c.enabled).map((c) => nameOf(c.channel));
  if (!view.canManage) {
    return off.length ? <Notice variant="info">{t('channelsPausedNotice', { channels: off.join(', ') })}</Notice> : null;
  }
  const toggle = async (channel: string, enabled: boolean): Promise<void> => {
    if (pending) return;
    setPending(channel);
    try {
      const channels = await setRelayChannel(channel, enabled);
      setView({ ...view, channels });
      toast.success(t(enabled ? 'channelSwitchedOn' : 'channelSwitchedOff', { channel: nameOf(channel) }));
      onChanged();
    } catch (err) {
      toast.error(refusalMessage(err) ?? t('channelSwitchFailed'));
    } finally {
      setPending(null);
    }
  };
  return (
    <fieldset className="u-grid u-gap-2 u-m-0 u-p-0 u-border-0">
      <legend className="u-fs-14 u-fw-600">{t('channelSwitchTitle')}</legend>
      <p className="muted u-fs-13 u-m-0">{t('channelSwitchHint')}</p>
      <div className="u-flex u-flex-wrap u-gap-4">
        {view.channels.map((c) => (
          <label key={c.channel} className="u-flex u-items-center u-gap-1">
            <input
              type="checkbox"
              role="switch"
              checked={c.enabled}
              aria-disabled={pending !== null || undefined}
              aria-busy={pending === c.channel || undefined}
              aria-label={t('channelSwitchLabel', { channel: nameOf(c.channel) })}
              onChange={() => void toggle(c.channel, !c.enabled)}
            />
            <span>{nameOf(c.channel)}</span>
            <span className="muted u-fs-12" aria-hidden="true">{c.enabled ? t('channelOn') : t('channelOff')}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function RelayDevicesSection(): JSX.Element {
  const { t } = useTranslation('channel-ingress');
  const [devices, setDevices] = useState<RelayDevice[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const load = useCallback(() => {
    setFailed(false);
    void listRelayDevices().then(setDevices).catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);

  const nameOf = (d: RelayDevice): string => d.deviceName ?? d.relayId;
  const revoke = useCallback(async (d: RelayDevice) => {
    if (busy) return;
    if (!(await confirm({ title: t('revokeDeviceTitle', { device: nameOf(d) }), body: t('revokeDeviceBody'), confirmLabel: t('revokeDevice'), danger: true }))) return;
    setBusy(d.relayId);
    try { await revokeRelayDevice(d.relayId); toast.success(t('deviceRevoked')); load(); } catch (err) { toast.error(refusalMessage(err) ?? t('deviceRevokeFailed')); } finally { setBusy(null); }
  }, [busy, load, t]);

  const columns: DataColumn<RelayDevice>[] = [
    { key: 'device', header: t('colDevice'), sortValue: nameOf, render: (d) => (
      <span className="u-flex u-flex-col u-gap-0-5 u-min-w-0">
        <strong className="u-truncate">{nameOf(d)}</strong>
        <span className="u-fs-12 muted">{d.channel}</span>
      </span>
    ) },
    { key: 'owner', header: t('colOwner'), render: (d) => (
      !d.owner ? <span className="u-flex u-flex-col"><span>{t('ownerNone')}</span><span className="u-fs-11 muted">{t('ownerNoneHint')}</span></span>
        : d.owner.ownedByCaller ? t('ownerYou') : t('ownerOther')
    ) },
    { key: 'account', header: t('colAccount'), render: (d) => (
      d.owner?.accountId ? <code className="u-fs-12">{d.owner.accountId}</code>
        : d.owner && !d.owner.ownedByCaller ? <span className="u-fs-12 muted">{t('accountHidden')}</span> : '—'
    ) },
    { key: 'status', header: t('colStatus'), render: (d) => {
      // CHAN-F11 — an active device on a switched-off channel is paused, whatever its heartbeat.
      const s = d.status === 'revoked' ? 'revoked' : d.status === 'registered' ? 'registered' : d.channelEnabled === false ? 'channelPaused' : d.online ? 'online' : 'offline';
      const tone = s === 'online' ? 'completed' : s === 'revoked' ? 'cancelled' : s === 'registered' || s === 'channelPaused' ? 'paused' : 'waiting';
      return <StatusBadge status={tone} label={t(`status_${s}`)} />;
    } },
    { key: 'heartbeat', header: t('colHeartbeat'), cellClassName: 'u-tabular', sortValue: (d) => d.lastHeartbeatAt ?? null, render: (d) => (d.lastHeartbeatAt ? formatDateTime(d.lastHeartbeatAt) : t('never')) },
    { key: 'actions', header: '', align: 'right', render: (d) => (
      <span className="u-flex u-flex-wrap u-gap-1 u-justify-end">
        {canOpenSenders(d) ? (
          <Button variant="secondary" size="sm" aria-expanded={selected === d.relayId} aria-label={t('deviceSendersAria', { device: nameOf(d) })}
            onClick={() => setSelected((s) => (s === d.relayId ? null : d.relayId))}>{t('deviceSenders')}</Button>
        ) : null}
        {/* ADR 1043 D3 — the server says who may revoke (the owner or a workspace admin). */}
        {d.status === 'revoked' || !d.canRevoke ? null : (
          <Button variant="quiet" size="sm" disabled={busy !== null} aria-label={t('revokeDeviceAria', { device: nameOf(d) })} onClick={() => void revoke(d)}>{t('revokeDevice')}</Button>
        )}
      </span>
    ) },
  ];
  const current = devices?.find((d) => d.relayId === selected && canOpenSenders(d));

  return (
    <section className="u-grid u-gap-3" aria-labelledby="chan-devices-title">
      <div>
        <h2 id="chan-devices-title" className="u-fs-16 u-m-0">{t('devicesTitle')}</h2>
        <p className="muted u-fs-13 u-m-0">{t('devicesHint')}</p>
      </div>
      <RelayChannelSwitchesPanel onChanged={load} />
      {failed ? (
        <>
          <Notice variant="error" announce={t('devicesLoadError')}>{t('devicesLoadError')}</Notice>
          <div><Button variant="quiet" size="sm" onClick={load}>{t('retry')}</Button></div>
        </>
      ) : devices === null ? (
        <SkeletonRows rows={2} columns={['1fr', '120px', '140px', '100px', '160px', '100px']} />
      ) : (
        <DataTable stack columns={columns} rows={devices} rowKey={(d) => d.relayId} caption={t('devicesCaption')}
          empty={<StateCard icon={<SmartphoneIcon />} title={t('devicesEmpty')} body={t('devicesEmptyBody')} />} />
      )}
      {current ? <RelaySendersPanel device={current} onClose={() => setSelected(null)} /> : null}
    </section>
  );
}

export function ChannelSettingsPage(): JSX.Element {
  const { t } = useTranslation('channel-ingress');
  const { embedded } = useHub(); // a tab inside the Access console → drop our own header
  const access = useFeatureAccess(CHANNEL_INGRESS_FEATURE);
  const header = embedded ? null : <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />;

  // Unresolved toggle: a skeleton, never the terminal "off" answer (DESIGN.md §4.6).
  if (access.loading) {
    return (
      <>
        {header}
        <SkeletonRows rows={4} columns={['1fr', '160px', '160px', '120px']} />
      </>
    );
  }
  if (!access.enabled) {
    return (
      <>
        {header}
        <StateCard icon={<MessageCircleIcon />} title={t('disabled')} body={t('disabledHint')} />
      </>
    );
  }
  return (
    <>
      {header}
      {embedded ? <p className="muted u-m-0">{t('lede')}</p> : null}
      <div className="u-flex u-flex-col u-gap-6">
        <ConnectionsSection />
        <RelayDevicesSection />
      </div>
    </>
  );
}
