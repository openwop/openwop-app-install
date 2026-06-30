/**
 * Knowledge-sync panel (ADR 0107 Phase 5) — the "Add sync" surface, mounted in a
 * KB collection's view. Binds a connected Drive folder → this collection on a
 * cadence, lists the collection's sync sources with status + last-sync, and offers
 * Sync-now / pause / remove. SELF-GATES: if the `knowledge-sync` toggle is off the
 * list call 404s and the panel renders nothing (the GovernancePanel pattern).
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '../../ui/toast.js';
import { confirm } from '../../ui/confirm.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { PlusIcon, TrashIcon, RotateCwIcon, PauseIcon, PlayIcon, ImageIcon } from '../../ui/icons/index.js';
import { listConnections, type Connection } from '../connections/connectionsClient.js';
import { FolderPicker } from './FolderPicker.js';
import {
  listSyncSources, createSyncSource, deleteSyncSource, setSyncPaused, setSyncIncludeMedia, syncNow,
  type SyncSource, type SyncCadence,
} from './knowledgeSyncClient.js';

const CADENCES: SyncCadence[] = ['15m', 'hourly', 'daily'];

export function KnowledgeSyncPanel({ orgId, collectionId }: { orgId: string; collectionId: string }): JSX.Element | null {
  const { t } = useTranslation('knowledge-sync');
  const mediaHelpId = useId();
  const [sources, setSources] = useState<SyncSource[] | null>(null);
  const [available, setAvailable] = useState(true); // toggled off ⇒ hide
  const [connections, setConnections] = useState<Connection[]>([]);
  const [busy, setBusy] = useState(false);
  // add-form state
  const [connectionId, setConnectionId] = useState('');
  const [folderId, setFolderId] = useState('');
  const [cadence, setCadence] = useState<SyncCadence>('daily');
  const [includeMedia, setIncludeMedia] = useState(true);
  // For a Microsoft Graph connection, the same credential serves OneDrive OR SharePoint;
  // the user picks which (SharePoint folders are addressed `{driveId}` or `{driveId}:{itemId}`).
  const [msSourceType, setMsSourceType] = useState<'onedrive' | 'sharepoint'>('onedrive');
  const [picking, setPicking] = useState(false);

  const load = useCallback(() => {
    void listSyncSources(orgId)
      .then((all) => { setSources(all.filter((s) => s.collectionId === collectionId)); setAvailable(true); })
      .catch(() => setAvailable(false)); // 404 ⇒ feature off ⇒ render nothing
  }, [orgId, collectionId]);

  useEffect(() => {
    load();
    void listConnections()
      .then((c) => setConnections(c.filter((x) => x.provider === 'google' || x.provider === 'microsoft-graph' || x.provider === 'dropbox' || x.provider === 'box')))
      .catch(() => setConnections([]));
  }, [load]);

  const add = useCallback(async () => {
    if (!connectionId || !folderId.trim()) return;
    setBusy(true);
    try {
      const conn = connections.find((c) => c.connectionId === connectionId);
      const provider =
        conn?.provider === 'microsoft-graph' && msSourceType === 'sharepoint' ? 'microsoft-sharepoint' : (conn?.provider ?? 'google');
      await createSyncSource({ orgId, connectionId, provider, externalFolderId: folderId.trim(), collectionId, cadence, includeMedia });
      setFolderId('');
      toast.success(t('added'));
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('addFailed'));
    } finally { setBusy(false); }
  }, [orgId, collectionId, connectionId, folderId, cadence, includeMedia, msSourceType, connections, t, load]);

  const selectedProvider = connections.find((c) => c.connectionId === connectionId)?.provider;
  const selectedIsMicrosoft = selectedProvider === 'microsoft-graph';
  // Browsable today: Google / OneDrive / Dropbox / Box (SharePoint browsing is deferred → raw id).
  const canBrowse = !!connectionId && (
    selectedProvider === 'google' || selectedProvider === 'dropbox' || selectedProvider === 'box' ||
    (selectedIsMicrosoft && msSourceType === 'onedrive')
  );

  const runNow = useCallback(async (s: SyncSource) => {
    setBusy(true);
    try {
      const { result } = await syncNow(s.id);
      toast.success(t('syncResult', { ingested: result.ingested, pruned: result.pruned, failed: result.failed }));
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('syncFailed'));
    } finally { setBusy(false); }
  }, [t, load]);

  const togglePause = useCallback(async (s: SyncSource) => {
    try { await setSyncPaused(s.id, s.status !== 'paused'); load(); }
    catch (err) { toast.error(err instanceof Error ? err.message : t('updateFailed')); }
  }, [t, load]);

  const remove = useCallback(async (s: SyncSource) => {
    if (!(await confirm({ title: t('removeSourceConfirm'), confirmLabel: t('remove'), danger: true }))) return;
    try { await deleteSyncSource(s.id); toast.success(t('removed')); load(); }
    catch (err) { toast.error(err instanceof Error ? err.message : t('removeFailed')); }
  }, [t, load]);

  const toggleMedia = useCallback(async (s: SyncSource) => {
    // currently off (includeMedia === false) → turn on (true); else turn off (false)
    try { await setSyncIncludeMedia(s.id, s.includeMedia === false); load(); }
    catch (err) { toast.error(err instanceof Error ? err.message : t('updateFailed')); }
  }, [t, load]);

  if (!available) return null; // feature off

  return (
    <div className="surface-card u-gap-2">
      <div className="u-grid u-gap-1">
        <h2 className="u-fs-16 u-m-0">{t('title')}</h2>
        <p className="u-label-sm u-m-0">{t('blurb')}</p>
      </div>

      {/* existing sources */}
      {!sources ? <Skeleton /> : sources.length === 0 ? (
        <span className="u-label-sm">{t('none')}</span>
      ) : sources.map((s) => (
        <div key={s.id} className="u-flex u-gap-2 u-items-center">
          <span className="u-flex-1 u-truncate" title={s.externalFolderId}>{s.externalFolderId}</span>
          <span className={`chip ${s.status === 'error' ? 'chip--danger' : s.status === 'paused' ? 'chip--muted' : ''}`}>{t(`status_${s.status}`)}</span>
          <span className="u-label-sm">{t(`cadence_${s.cadence}`)}</span>
          {s.lastError ? <span className="chip chip--danger" title={s.lastError} aria-label={s.lastError}>!</span> : null}
          <button type="button" className="btn-ghost" disabled={busy} title={t('syncNow')} aria-label={t('syncNow')} onClick={() => void runNow(s)}><RotateCwIcon size={14} /></button>
          <button type="button" className="btn-ghost" title={s.status === 'paused' ? t('resume') : t('pause')} aria-label={s.status === 'paused' ? t('resume') : t('pause')} onClick={() => void togglePause(s)}>
            {s.status === 'paused' ? <PlayIcon size={14} /> : <PauseIcon size={14} />}
          </button>
          <button type="button" className="btn-ghost" disabled={busy} aria-pressed={s.includeMedia !== false} title={s.includeMedia === false ? t('mediaOff') : t('mediaOn')} aria-label={s.includeMedia === false ? t('mediaOff') : t('mediaOn')} onClick={() => void toggleMedia(s)}><ImageIcon size={14} /></button>
          <button type="button" className="btn-ghost" title={t('remove')} aria-label={t('remove')} onClick={() => void remove(s)}><TrashIcon size={14} /></button>
        </div>
      ))}

      {/* add form */}
      {connections.length === 0 ? (
        <span className="u-label-sm">{t('noConnections')}</span>
      ) : (
        <div className="u-flex u-gap-1 u-items-end u-flex-wrap">
          <label className="field u-flex-1">
            <span className="field-label">{t('connectionLabel')}</span>
            <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)} aria-label={t('connectionLabel')}>
              <option value="">{t('connectionPlaceholder')}</option>
              {connections.map((c) => <option key={c.connectionId} value={c.connectionId}>{c.displayName}</option>)}
            </select>
          </label>
          {selectedIsMicrosoft ? (
            <label className="field">
              <span className="field-label">{t('sourceTypeLabel')}</span>
              <select value={msSourceType} onChange={(e) => setMsSourceType(e.target.value as 'onedrive' | 'sharepoint')} aria-label={t('sourceTypeLabel')}>
                <option value="onedrive">{t('sourceTypeOneDrive')}</option>
                <option value="sharepoint">{t('sourceTypeSharePoint')}</option>
              </select>
            </label>
          ) : null}
          <label className="field u-flex-1">
            <span className="field-label">{t('folderLabel')}</span>
            <div className="u-flex u-gap-1 u-items-center">
              <input className="u-flex-1" value={folderId} onChange={(e) => setFolderId(e.target.value)} placeholder={selectedIsMicrosoft && msSourceType === 'sharepoint' ? t('folderPlaceholderSharePoint') : t('folderPlaceholder')} aria-label={t('folderLabel')} />
              {canBrowse ? <button type="button" className="btn-ghost" onClick={() => setPicking((p) => !p)}>{picking ? t('browseClose') : t('browse')}</button> : null}
            </div>
          </label>
          <label className="field">
            <span className="field-label">{t('cadenceLabel')}</span>
            <select value={cadence} onChange={(e) => setCadence(e.target.value as SyncCadence)} aria-label={t('cadenceLabel')}>
              {CADENCES.map((c) => <option key={c} value={c}>{t(`cadence_${c}`)}</option>)}
            </select>
          </label>
          <button type="button" className="btn-primary" disabled={busy || !connectionId || !folderId.trim()} onClick={() => void add()}><PlusIcon size={14} /> {t('add')}</button>
        </div>
      )}
      {available ? (
        <div className="u-mt-1">
          {/* Accessible name = the concise visible label; the longer help text is
              wired via aria-describedby so the two no longer diverge. */}
          <label className="u-flex u-gap-1 u-items-center">
            <input type="checkbox" checked={includeMedia} onChange={(e) => setIncludeMedia(e.target.checked)} aria-describedby={mediaHelpId} />
            <span className="u-label-sm">{t('includeMediaLabel')}</span>
          </label>
          <p id={mediaHelpId} className="u-label-sm u-text-muted u-m-0">{t('includeMediaHelp')}</p>
        </div>
      ) : null}
      {picking && canBrowse ? (
        <FolderPicker orgId={orgId} connectionId={connectionId} onSelect={(id) => { setFolderId(id); setPicking(false); }} />
      ) : null}
    </div>
  );
}
