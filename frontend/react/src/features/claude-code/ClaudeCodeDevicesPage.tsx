/**
 * Claude Code — paired devices (ADR 0785 P1).
 *
 * Two decisions this page encodes:
 *   - The pairing command is the primary action, not a settings form: pairing
 *     starts on the user's machine (the companion has no identity until then),
 *     so the page hands over the one command and waits for the approval link.
 *   - Revoking is ordinary, not alarming. The dialog says what stops (this
 *     workspace, on the device's next request) and what does not (Claude Code
 *     itself), because a scary revoke makes people keep devices they don't use.
 *
 * Status is DERIVED server-side from each device's developer key — the
 * authority — so "revoked" here means the key is revoked, not a flag that could
 * disagree with it.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Panel } from '../../ui/layout.js';
import { Button } from '../../ui/Button.js';
import { IconButton } from '../../ui/IconButton.js';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { StatusBadge } from '../../ui/StatusBadge.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { toast } from '../../ui/toast.js';
import { copyToClipboard } from '../../ui/copyToClipboard.js';
import { formatDate, formatRelativeTime } from '../../i18n/format.js';
import { ClipboardIcon, TerminalIcon } from '../../ui/icons/index.js';
import { listDevices, revokeDevice, setWorkflowTasks, type DeviceView } from './claudeCodeClient.js';
import { config } from '../../client/config.js';

/**
 * The command a user runs on their own machine, built from where THIS SPA reaches
 * its API — so every deploy hands out a command that actually works against it
 * (code review #3: the bare `--host <origin>` missed app.openwop.dev's `/api`).
 *   - `--host` is always the app origin: the approval link must open the app.
 *   - `--api-base` is the API location: a same-origin path (`/api`), or an
 *     absolute URL when the API lives on another origin. Omitted when the API is
 *     served at the app origin's root.
 *
 * Built from `config.sseBaseUrl`, NOT `config.baseUrl`: the companion holds a
 * long-lived WebSocket, and on app.openwop.dev the `/api` door is a Firebase
 * Hosting rewrite that drops the `Upgrade` header — MEASURED 2026-10-04, a device
 * upgrade through `/api` answers 404 while the same request to Cloud Run answers
 * 401, so every device paired with `--api-base /api` showed "offline" forever.
 * `sseBaseUrl` is the direct base the SPA already uses for exactly this reason
 * (streams + the terminal viewer socket); it falls back to `baseUrl` where there
 * is no proxy in the way.
 */
export function pairCommand(origin: string, apiBaseUrl: string): string {
  let apiBase = '';
  if (/^https?:\/\//i.test(apiBaseUrl)) {
    const u = new URL(apiBaseUrl);
    const path = u.pathname.replace(/\/+$/, '');
    apiBase = u.origin === origin ? path : `${u.origin}${path}`;
  } else {
    apiBase = apiBaseUrl.replace(/\/+$/, '');
  }
  return `npx @openwop/agent-host pair --host ${origin}${apiBase ? ` --api-base ${apiBase}` : ''}`;
}

/** `ccd_XRqyAV_D6S1M` → `ccd_XRqy…` — enough to tell same-named pairings apart. */
export function shortDeviceId(deviceId: string): string {
  return deviceId.length > 9 ? `${deviceId.slice(0, 8)}…` : deviceId;
}

const STATUS_TONE: Record<DeviceView['status'], string> = { active: 'success', revoked: 'neutral', expired: 'warning' };

export function ClaudeCodeDevicesPage(): JSX.Element {
  const { t } = useTranslation('claude-code');
  const [devices, setDevices] = useState<DeviceView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState<DeviceView | null>(null);
  const [busy, setBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  // ADR 0785 D7 — workflow tasks: turning ON asks first (it lets unattended runs reach
  // this machine); turning OFF is immediate.
  const [allowing, setAllowing] = useState<DeviceView | null>(null);
  const [tasksBusy, setTasksBusy] = useState(false);
  const [tasksError, setTasksError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try { setDevices(await listDevices()); } catch { setFailed(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const command = pairCommand(window.location.origin, config.sseBaseUrl);

  const onRevoke = useCallback(async () => {
    if (!confirming) return;
    setBusy(true);
    setRevokeError(null);
    try {
      await revokeDevice(confirming.deviceId);
      toast.success(t('revoked'));
      setConfirming(null);
      await load();
    } catch {
      setRevokeError(t('revokeFailed'));
    } finally {
      setBusy(false);
    }
  }, [confirming, load, t]);

  const onWorkflowTasks = useCallback(async (d: DeviceView, enabled: boolean) => {
    setTasksBusy(true);
    setTasksError(null);
    try {
      await setWorkflowTasks(d.deviceId, enabled);
      setAllowing(null);
      await load();
    } catch {
      setTasksError(t('workflowTasksFailed'));
    } finally {
      setTasksBusy(false);
    }
  }, [load, t]);

  const statusLabel = (s: DeviceView['status']): string =>
    s === 'active' ? t('statusActive') : s === 'revoked' ? t('statusRevoked') : t('statusExpired');

  const columns: DataColumn<DeviceView>[] = [
    // Every pairing from one machine shares its hostname, so the label alone cannot
    // tell them apart: a user revoked the device they were running (2026-10-05).
    // The short id + live state disambiguate before anyone chooses Revoke.
    {
      key: 'label', header: t('colDevice'), sortValue: (d) => d.label,
      render: (d) => (
        <span className="u-flex u-flex-col">
          <strong>{d.label}</strong>
          <span className="u-text-sm u-text-muted">
            <span className="u-mono">{shortDeviceId(d.deviceId)}</span>
            {d.online ? ` · ${t('deviceOnline')}` : ''}
          </span>
        </span>
      ),
    },
    { key: 'platform', header: t('colPlatform'), render: (d) => <code>{d.platform}</code>, sortValue: (d) => d.platform },
    { key: 'status', header: t('colStatus'), render: (d) => <StatusBadge status={STATUS_TONE[d.status]} label={statusLabel(d.status)} />, sortValue: (d) => d.status },
    { key: 'paired', header: t('colPaired'), render: (d) => formatDate(d.createdAt), sortValue: (d) => d.createdAt },
    { key: 'lastUsed', header: t('colLastUsed'), render: (d) => (d.lastUsedAt ? formatRelativeTime(d.lastUsedAt) : t('neverUsed')), sortValue: (d) => d.lastUsedAt ?? null },
    {
      key: 'workflowTasks', header: t('colWorkflowTasks'), sortValue: (d) => (d.workflowTasks ? 1 : 0),
      render: (d) => {
        if (d.status !== 'active') return <span className="u-text-muted">—</span>;
        const name = `${d.label} ${shortDeviceId(d.deviceId)}`;
        return d.workflowTasks
          ? (
            <span className="u-flex u-gap-2 u-items-center">
              <StatusBadge status="success" label={t('workflowTasksOn')} />
              <Button variant="quiet" size="sm" disabled={tasksBusy} aria-label={t('workflowTasksTurnOffAria', { label: name })} onClick={() => { void onWorkflowTasks(d, false); }}>{t('workflowTasksTurnOff')}</Button>
            </span>
          )
          : <Button variant="secondary" size="sm" aria-label={t('workflowTasksAllowAria', { label: name })} onClick={() => { setTasksError(null); setAllowing(d); }}>{t('workflowTasksAllow')}</Button>;
      },
    },
    {
      key: 'actions', header: t('colActions'), align: 'right',
      render: (d) => d.status === 'active'
        ? <Button variant="quiet" size="sm" aria-label={t('revokeAria', { label: `${d.label} ${shortDeviceId(d.deviceId)}` })} onClick={() => { setRevokeError(null); setConfirming(d); }}>{t('revoke')}</Button>
        : null,
    },
  ];

  return (
    <div className="u-flex-col u-gap-4" data-walkthrough="claude-code.devices">
      <PageHeader eyebrow={t('eyebrow')} title={t('devicesTitle')} lede={t('devicesLede')} />

      <Panel title={t('installTitle')}>
        <p className="u-mt-0">{t('installBody')}</p>
        <div className="surface-card u-p-3 u-flex u-gap-2 u-items-center">
          <TerminalIcon size={18} />
          <code className="u-flex-1">{command}</code>
          <IconButton
            label={t('installCopy')}
            icon={<ClipboardIcon size={16} />}
            onClick={() => { void copyToClipboard(command, t('installCopied')); }}
          />
        </div>
        <p className="u-mb-0 u-mt-2">{t('apiKeyTip')}</p>
      </Panel>

      <Panel>
        {failed ? (
          <StateCard
            announce
            icon={<TerminalIcon size={20} />}
            title={t('loadFailed')}
            action={<Button variant="secondary" size="sm" onClick={() => { void load(); }}>{t('retry')}</Button>}
          />
        ) : devices === null ? (
          <div role="status" aria-busy="true" aria-label={t('devicesTableCaption')} className="u-flex u-flex-col u-gap-2">
            {['80%', '65%'].map((w, i) => <Skeleton key={i} width={w} height={18} />)}
          </div>
        ) : devices.length === 0 ? (
          <StateCard icon={<TerminalIcon size={20} />} title={t('emptyTitle')} body={t('emptyBody')} />
        ) : (
          <DataTable
            caption={t('devicesTableCaption')}
            columns={columns}
            rows={devices}
            rowKey={(d) => d.deviceId}
            stack
          />
        )}
      </Panel>

      {tasksError && !allowing ? <Notice variant="error" announce={tasksError}>{tasksError}</Notice> : null}
      {allowing ? (
        <ConfirmDialog
          title={t('workflowTasksConfirmTitle', { label: `${allowing.label} (${shortDeviceId(allowing.deviceId)})` })}
          body={t('workflowTasksConfirmBody')}
          confirmLabel={t('workflowTasksConfirm')}
          busy={tasksBusy}
          error={tasksError ?? undefined}
          errorAnnounce={tasksError ?? undefined}
          onConfirm={() => { void onWorkflowTasks(allowing, true); }}
          onCancel={() => setAllowing(null)}
        />
      ) : null}
      {confirming ? (
        <ConfirmDialog
          title={t('revokeTitle', { label: `${confirming.label} (${shortDeviceId(confirming.deviceId)})` })}
          body={t('revokeBody')}
          confirmLabel={t('revokeConfirm')}
          busy={busy}
          error={revokeError ?? undefined}
          errorAnnounce={revokeError ?? undefined}
          onConfirm={() => { void onRevoke(); }}
          onCancel={() => setConfirming(null)}
        />
      ) : null}
    </div>
  );
}
