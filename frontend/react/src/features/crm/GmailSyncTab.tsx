/**
 * Gmail sync tab (org-scoped — ADR 0252 P3) — the per-user opt-in panel over
 * `/host/openwop-app/crm/gmail-sync`. Placed as a CrmPage tab (not a
 * settings page) because, like Companies/Deals/Tasks, it is per-org CRM
 * config: the backend contract takes `orgId` on every call and RBAC-gates on
 * org scope (`requireOrgScope`), the exact shape the other org-scoped tabs
 * already use — CrmPage's existing org picker drives it with no new chrome.
 *
 * ADR 0252 §1 (refs-only PII posture): the panel leads with an explicit
 * privacy Notice — the backend records ONLY that an email was exchanged with
 * a matched contact (timestamp + a Gmail deep-link id), never the subject or
 * body. No PII crosses this component either.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { SelectField } from '../../ui/Field.js';
import { confirm } from '../../ui/confirm.js';
import { toast } from '../../ui/toast.js';
import { MailIcon, RotateCwIcon, TrashIcon, PlusIcon, ShieldIcon } from '../../ui/icons/index.js';
import { formatRelativeTime } from '../../i18n/format.js';
import { listConnections, type Connection } from '../connections/connectionsClient.js';
import {
  listGmailSyncs,
  createGmailSync,
  updateGmailSync,
  deleteGmailSync,
  syncGmailNow,
  GMAIL_SYNC_CADENCES,
  type GmailSync,
  type GmailSyncCadence,
} from './gmailSyncClient.js';
import { crmActionError } from './crmUiHelpers.js';

interface Props {
  orgId: string;
}

export function GmailSyncTab({ orgId }: Props): JSX.Element {
  const { t } = useTranslation('crm');
  const [syncs, setSyncs] = useState<GmailSync[] | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  // R2 CC-SP-2 — a FAILED connections read must never render as "No Google
  // connection, go connect one": that's a false instruction over a read error.
  const [connectionsFailed, setConnectionsFailed] = useState(false);
  const [syncsFailed, setSyncsFailed] = useState(false);
  const [connectionId, setConnectionId] = useState('');
  const [cadence, setCadence] = useState<GmailSyncCadence>('daily');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const googleConnections = useMemo(() => connections.filter((c) => c.provider === 'google'), [connections]);
  const connectionLabel = useMemo(() => {
    const byId = new Map(connections.map((c) => [c.connectionId, c.displayName]));
    return (id: string): string => byId.get(id) ?? id;
  }, [connections]);

  const load = useCallback(() => {
    setSyncsFailed(false);
    void listGmailSyncs(orgId)
      .then(setSyncs)
      .catch((e) => {
        // Terminal state on failure — never strand the skeleton behind the error.
        // CRM-UX-14 — the wire string is for the developer; the user gets the
        // canonical announced failed-read card (the ReportsTab shape).
        console.warn('[crm] gmail syncs read failed:', e);
        setSyncs([]);
        setSyncsFailed(true);
      });
  }, [orgId]);

  useEffect(() => { setSyncs(null); if (orgId) load(); }, [orgId, load]);

  const loadConnections = useCallback(() => {
    setConnectionsFailed(false);
    void listConnections()
      .then(setConnections)
      .catch(() => { setConnections([]); setConnectionsFailed(true); });
  }, []);
  useEffect(() => { loadConnections(); }, [loadConnections]);

  useEffect(() => {
    setConnectionId((cur) => (cur && googleConnections.some((c) => c.connectionId === cur) ? cur : googleConnections[0]?.connectionId ?? ''));
  }, [googleConnections]);

  const onCreate = useCallback(async () => {
    if (!connectionId) return;
    setCreating(true);
    try {
      await createGmailSync({ orgId, connectionId, cadence });
      toast.success(t('gmailSyncCreated'));
      load();
    } catch (err) {
      toast.error(crmActionError(err, 'gmailSyncCreateFailed'));
    } finally {
      setCreating(false);
    }
  }, [orgId, connectionId, cadence, t, load]);

  const onToggle = useCallback(async (s: GmailSync) => {
    setBusyId(s.syncId);
    try {
      const next = s.status === 'active' ? 'paused' : 'active';
      await updateGmailSync(s.syncId, { status: next });
      toast.success(next === 'active' ? t('gmailSyncResumed', { connection: connectionLabel(s.connectionId) }) : t('gmailSyncPaused', { connection: connectionLabel(s.connectionId) }));
      load();
    } catch (err) {
      toast.error(crmActionError(err, 'gmailSyncToggleFailed'));
    } finally {
      setBusyId(null);
    }
  }, [t, load, connectionLabel]);

  const onSyncNow = useCallback(async (s: GmailSync) => {
    setBusyId(s.syncId);
    try {
      await syncGmailNow(s.syncId);
      toast.success(t('gmailSyncNowStarted'));
      load();
    } catch (err) {
      toast.error(crmActionError(err, 'gmailSyncNowFailed'));
    } finally {
      setBusyId(null);
    }
  }, [t, load]);

  const onDelete = useCallback(async (s: GmailSync) => {
    const label = connectionLabel(s.connectionId);
    const ok = await confirm({
      title: t('gmailSyncDeleteConfirmTitle', { connection: label }),
      body: t('gmailSyncDeleteConfirmBody'),
      danger: true,
      confirmLabel: t('common:delete'),
    });
    if (!ok) return;
    setBusyId(s.syncId);
    try {
      await deleteGmailSync(s.syncId);
      toast.success(t('gmailSyncDeleted'));
      load();
    } catch (err) {
      toast.error(crmActionError(err, 'gmailSyncDeleteFailed'));
    } finally {
      setBusyId(null);
    }
  }, [t, load, connectionLabel]);

  const columns: DataColumn<GmailSync>[] = [
    {
      key: 'connection', header: t('gmailSyncColConnection'),
      render: (s) => <span>{connectionLabel(s.connectionId)}</span>,
      sortValue: (s) => connectionLabel(s.connectionId),
    },
    {
      key: 'cadence', header: t('gmailSyncColCadence'),
      render: (s) => <span>{t(`gmailSyncCadence_${s.cadence}`)}</span>,
      sortValue: (s) => s.cadence,
    },
    {
      key: 'status', header: t('gmailSyncColStatus'),
      render: (s) => (
        <button
          type="button"
          className={`chip ${s.status === 'active' ? 'chip--success' : 'chip--muted'}`}
          aria-pressed={s.status === 'active'}
          disabled={busyId === s.syncId}
          onClick={() => void onToggle(s)}
          aria-label={`${s.status === 'active' ? t('gmailSyncStatusActive') : t('gmailSyncStatusPaused')} — ${t('gmailSyncToggleAria', { connection: connectionLabel(s.connectionId) })}`}
        >
          {s.status === 'active' ? t('gmailSyncStatusActive') : t('gmailSyncStatusPaused')}
        </button>
      ),
      sortValue: (s) => (s.status === 'active' ? 1 : 0),
    },
    {
      key: 'lastSyncedAt', header: t('gmailSyncColLastSynced'),
      render: (s) => <span className="u-fs-12">{s.lastSyncedAt ? formatRelativeTime(s.lastSyncedAt) : t('gmailSyncNeverSynced')}</span>,
      sortValue: (s) => s.lastSyncedAt ?? '',
    },
    {
      key: 'actions', header: '', align: 'right',
      render: (s) => (
        <span className="action-bar">
          <Button
            variant="quiet" size="sm"
            disabled={busyId === s.syncId}
            onClick={() => void onSyncNow(s)}
            aria-label={t('gmailSyncNowAria', { connection: connectionLabel(s.connectionId) })}
          >
            <RotateCwIcon size={13} /> {t('gmailSyncNowLabel')}
          </Button>
          <Button
            variant="secondary" size="sm"
            disabled={busyId === s.syncId}
            onClick={() => void onDelete(s)}
            aria-label={t('gmailSyncDeleteAria', { connection: connectionLabel(s.connectionId) })}
          >
            <TrashIcon size={13} /> {t('common:delete')}
          </Button>
        </span>
      ),
    },
  ];

  return (
    <section className="u-grid u-gap-4">
      <Notice variant="info">
        <span className="u-flex u-gap-2 u-items-start">
          <ShieldIcon size={15} aria-hidden="true" />
          <span>{t('gmailSyncPrivacyNotice')}</span>
        </span>
      </Notice>
      {syncsFailed ? (
        <StateCard
          announce
          icon={<MailIcon size={20} />}
          title={t('common:loadFailedTitle')}
          body={t('common:loadFailedBody')}
          action={<Button variant="secondary" onClick={load}>{t('common:retry')}</Button>}
        />
      ) : null}

      <div className="surface-card u-mb-3">
        <h2 className="u-fs-16 u-mt-0">{t('gmailSyncCreateHeading')}</h2>
        {connectionsFailed ? (
          <StateCard
            announce
            icon={<MailIcon size={20} />}
            title={t('gmailSyncConnectionsFailedTitle')}
            body={t('gmailSyncConnectionsFailedBody')}
            action={<Button variant="secondary" onClick={loadConnections}>{t('common:retry')}</Button>}
          />
        ) : googleConnections.length === 0 ? (
          <StateCard
            icon={<MailIcon size={20} />}
            title={t('gmailSyncNoConnectionTitle')}
            body={t('gmailSyncNoConnectionBody')}
            action={<Link to="/connections" className="btn btn-accent-solid">{t('gmailSyncManageConnections')}</Link>}
          />
        ) : (
          <form
            onSubmit={(e) => { e.preventDefault(); void onCreate(); }}
            className="surface-form"
            aria-label={t('gmailSyncCreateHeading')}
          >
            <SelectField
              label={t('gmailSyncConnectionLabel')}
              value={connectionId}
              onChange={(e) => setConnectionId(e.target.value)}
              required
            >
              {googleConnections.map((c) => <option key={c.connectionId} value={c.connectionId}>{c.displayName}</option>)}
            </SelectField>
            <SelectField
              label={t('gmailSyncCadenceLabel')}
              value={cadence}
              onChange={(e) => setCadence(e.target.value as GmailSyncCadence)}
              required
            >
              {GMAIL_SYNC_CADENCES.map((c) => <option key={c} value={c}>{t(`gmailSyncCadence_${c}`)}</option>)}
            </SelectField>
            <Button type="submit" variant="accent-solid" disabled={creating || !connectionId}>
              <PlusIcon size={14} /> {creating ? t('gmailSyncEnabling') : t('gmailSyncEnable')}
            </Button>
          </form>
        )}
      </div>

      {syncs === null ? (
        <SkeletonRows rows={2} columns={['25%', '15%', '15%', '20%', '25%']} />
      ) : syncs.length === 0 ? (
        // The failed-read card above already owns the failure — don't also
        // show the success-toned "no syncs yet" empty state (reads contradictory).
        syncsFailed ? null : <StateCard icon={<MailIcon size={20} />} title={t('gmailSyncEmptyTitle')} body={t('gmailSyncEmptyBody')} />
      ) : (
        <DataTable columns={columns} rows={syncs} rowKey={(s) => s.syncId} stack caption={t('gmailSyncCaption')} />
      )}
    </section>
  );
}
