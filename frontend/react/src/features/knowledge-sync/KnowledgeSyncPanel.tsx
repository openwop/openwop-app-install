/**
 * Knowledge-sync panel (ADR 0107 Phase 5) — the "Add sync" surface, mounted in a
 * KB collection's view. Binds a connected Drive folder → this collection on a
 * cadence, lists the collection's sync sources with status + last-sync, and offers
 * Sync-now / pause / remove. SELF-GATES: if the `knowledge-sync` toggle is off the
 * list call 404s and the panel renders nothing (the GovernancePanel pattern).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '../../ui/toast.js';
import { confirm } from '../../ui/confirm.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { Notice } from '../../ui/Notice.js';
import { PlusIcon, TrashIcon, RotateCwIcon, PauseIcon, PlayIcon, ImageIcon } from '../../ui/icons/index.js';
import { formatDateTime } from '../../i18n/format.js';
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
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
    setLoadError(null);
    void listSyncSources(orgId)
      .then((all) => {
        // null ⇒ 404 ⇒ the feature really is off for this tenant ⇒ render nothing.
        if (all === null) { setAvailable(false); return; }
        setSources(all.filter((s) => s.collectionId === collectionId));
        setAvailable(true);
      })
      // Anything else is a FAILURE, not an absence. Hiding the whole panel here
      // told a user whose Drive may be actively syncing that no sync exists.
      .catch((e) => { setAvailable(true); setLoadError(e instanceof Error ? e.message : String(e)); });
  }, [orgId, collectionId]);

  useEffect(() => {
    load();
    void listConnections()
      .then((c) => {
        setConnectionsError(null);
        setConnections(c.filter((x) => x.provider === 'google' || x.provider === 'microsoft-graph' || x.provider === 'dropbox' || x.provider === 'box'));
      })
      // Falling back to [] rendered "Connect a Google Drive or OneDrive account
      // first" — telling the user to go do work they may already have done.
      .catch((e) => setConnectionsError(e instanceof Error ? e.message : String(e)));
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
      // The result already CARRIES a `failed` count (and `errors[]`), and the copy
      // already prints it — but it was announced with success styling, so a sync
      // that dropped documents looked like a clean one. Severity now tracks the
      // outcome, and the server's first error text is surfaced rather than left
      // in an array nobody reads.
      // ADR 0605 Tier 6 (`KSU-8`) — `skippedMedia` was computed and logged by the
      // backend and DROPPED at the client type, so a media-off source over a folder
      // of 40 images toasted "0 updated, 0 removed, 0 failed": a total no-op that
      // read as a clean full sync. It is reported now.
      const msg = t('syncResult', {
        ingested: result.ingested, pruned: result.pruned,
        skipped: result.skippedMedia, failed: result.failed,
      });
      // ADR 0605 Tier 1 — a pass that could not read the whole folder pruned NOTHING
      // by refusal. Reporting that as a clean sync would hide the very condition the
      // fix exists to surface.
      if (result.listingIncomplete) toast.warning(`${msg} ${t('syncPartial')}`);
      else if (result.failed > 0) toast.warning(result.errors[0] ? `${msg} ${result.errors[0]}` : msg);
      else toast.success(msg);
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
    const turningOn = s.includeMedia === false;
    // ADR 0605 Tier 6 (`KSU-4`) — turning media OFF is a one-click DESTRUCTIVE act:
    // the next pass PRUNES every already-synced image and audio file from the
    // collection. It had no confirm at all, while `remove` — which destroys less —
    // did gate on one; and the only disclosure of the consequence lived on the
    // ADD-FORM checkbox, a control no existing source's owner ever sees again.
    // The warning now sits on the control that causes it.
    if (!turningOn && !(await confirm({
      title: t('mediaOffConfirmTitle'),
      body: t('mediaOffConfirmBody'),
      confirmLabel: t('mediaOffConfirmAction'),
      danger: true,
    }))) return;
    try { await setSyncIncludeMedia(s.id, turningOn); load(); }
    catch (err) { toast.error(err instanceof Error ? err.message : t('updateFailed')); }
  }, [t, load]);

  if (!available) return null; // feature off

  // ADR 0605 R1 (review LOW 7) — announce ONCE for the whole list.
  //
  // `<Notice announce>` delegates to the single `GlobalLiveRegion`, whose
  // assertive slot holds ONE string, so N errored rows firing on the same commit
  // stomp each other and only the last is ever spoken. The same trade-off is
  // already recorded in `check-notice-announce.mjs`'s DocumentsPage exemption:
  // "one disclosure that is heard beats two that race". So exactly one row
  // carries the announcement, and it is a `t()` sentence rather than the raw
  // composed server blob — the case `Notice.tsx`'s string parameter documents
  // itself as existing to prevent.
  const firstErrorId = sources?.find((s) => s.lastError)?.id;

  return (
    <div className="surface-card u-gap-2">
      <div className="u-grid u-gap-1">
        <h2 className="u-fs-16 u-m-0">{t('title')}</h2>
        <p className="u-label-sm u-m-0">{t('blurb')}</p>
      </div>

      {loadError ? <Notice variant="error" announce={t('loadFailed', { error: loadError })}>{t('loadFailed', { error: loadError })}</Notice> : null}

      {/* existing sources */}
      {loadError ? null : !sources ? <Skeleton /> : sources.length === 0 ? (
        <span className="u-label-sm">{t('none')}</span>
      ) : sources.map((s) => {
        // ADR 0605 Tier 6 (`KSU-3`) — a REVOKED credential is not a user pause.
        // It needs a different chip and a different action: Resume cannot work.
        const needsReconnect = s.status === 'paused' && s.pausedReason === 'connection-revoked';
        return (
        <div key={s.id} className="u-grid u-gap-1">
          <div className="u-flex u-gap-2 u-items-center u-wrap">
            <span className="u-flex-1 u-truncate" title={s.externalFolderId}>{s.externalFolderId}</span>
            {needsReconnect
              ? <span className="chip chip--danger">{t('statusReconnect')}</span>
              : <span className={`chip ${s.status === 'error' ? 'chip--danger' : s.status === 'paused' ? 'chip--muted' : ''}`}>{t(`status_${s.status}`)}</span>}
            <span className="u-label-sm">{t(`cadence_${s.cadence}`)}</span>
            {/* ADR 0605 R1 (review HIGH 3) — "Sync now" is refused server-side for a
                REVOKED source (the run cannot succeed, and its only durable effect
                was to overwrite the reconnect instruction), so do not offer it. */}
            <Button
              variant="quiet"
              disabled={busy || needsReconnect}
              title={needsReconnect ? t('syncNowReconnectFirst') : t('syncNow')}
              aria-label={needsReconnect ? t('syncNowReconnectFirst') : t('syncNow')}
              onClick={() => void runNow(s)}
            >
              <RotateCwIcon size={14} />
            </Button>
            {/* ADR 0605 R1 — RESUME IS NO LONGER DISABLED HERE, and the reasoning
                that disabled it was wrong. Tier 6 read Resume as "guaranteed to
                fail"; it is not an action against the provider at all — it flips
                the row back to `active`, and after the user reconnects it is the
                ONLY way back. With no `onConnectionRestored` hook anywhere
                (`connectionLifecycle.ts` has revoke only), disabling it left a
                revoked source permanently paused with no in-product exit — a
                cure that reproduced the wedge family it was closing. The
                "Reconnect needed" chip plus the Reconnect link below still carry
                the right FIRST action; this is the escape behind it. */}
            <Button
              variant="quiet"
              title={s.status === 'paused' ? t('resume') : t('pause')}
              aria-label={s.status === 'paused' ? t('resume') : t('pause')}
              onClick={() => void togglePause(s)}
            >
              {s.status === 'paused' ? <PlayIcon size={14} /> : <PauseIcon size={14} />}
            </Button>
            <Button variant="quiet" disabled={busy} aria-pressed={s.includeMedia !== false} title={s.includeMedia === false ? t('mediaOff') : t('mediaOn')} aria-label={s.includeMedia === false ? t('mediaOff') : t('mediaOn')} onClick={() => void toggleMedia(s)}><ImageIcon size={14} /></Button>
            <Button variant="quiet" title={t('remove')} aria-label={t('remove')} onClick={() => void remove(s)}><TrashIcon size={14} /></Button>
          </div>

          {/* ADR 0605 Tier 6 (`KSU-1`/`KSU-2`/`KSU-7`/`KSU-8`) — THE LAST RUN, as
              readable text. `lastSyncedAt` was fetched, typed, backend-written and
              never rendered, so "never run", "synced 30s ago" and "last succeeded
              six weeks ago" were one identical Active chip. And a SCHEDULED pass
              that deleted documents said so nowhere at all — the only report in the
              product was a 4-second toast on a manual run. */}
          <span className="u-label-sm u-text-muted">
            {s.lastRun
              ? t('lastRunSummary', {
                  ingested: s.lastRun.ingested,
                  pruned: s.lastRun.pruned,
                  skipped: s.lastRun.skippedMedia,
                  failed: s.lastRun.failed,
                  when: formatDateTime(s.lastRun.at),
                })
              : s.lastSyncedAt
                ? t('lastSyncedAt', { when: formatDateTime(s.lastSyncedAt) })
                : t('neverSynced')}
          </span>

          {/* The failure reason as FOCUSABLE, READABLE text. It used to live only in
              `title`/`aria-label` on a non-focusable <span> showing a "!" glyph:
              unreachable by keyboard, unreachable by touch. A Notice with `announce`
              is the shape this app already uses to tell a user something went wrong. */}
          {s.lastError ? (
            <Notice
              variant={s.status === 'error' ? 'error' : 'warning'}
              {...(s.id === firstErrorId ? { announce: t('sourceErrorAnnounce') } : {})}
            >
              {s.lastError}
              {needsReconnect ? (
                <> <a href="/access?tab=connections">{t('reconnectAction')}</a></>
              ) : null}
            </Notice>
          ) : null}
        </div>
        );
      })}

      {/* add form */}
      {connectionsError ? (
        // NOT "connect an account first" — that instructs the user to redo work
        // they may already have done, on the authority of a read that failed.
        <Notice variant="error" announce={t('connectionsFailed', { error: connectionsError })}>{t('connectionsFailed', { error: connectionsError })}</Notice>
      ) : connections.length === 0 ? (
        <span className="u-label-sm">{t('noConnections')}</span>
      ) : (
        <div className="surface-form">
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
              {canBrowse ? <Button variant="quiet" onClick={() => setPicking((p) => !p)}>{picking ? t('browseClose') : t('browse')}</Button> : null}
            </div>
          </label>
          <label className="field">
            <span className="field-label">{t('cadenceLabel')}</span>
            <select value={cadence} onChange={(e) => setCadence(e.target.value as SyncCadence)} aria-label={t('cadenceLabel')}>
              {CADENCES.map((c) => <option key={c} value={c}>{t(`cadence_${c}`)}</option>)}
            </select>
          </label>
          {/* ADR 0605 Tier 6 — the destructive semantic, disclosed BEFORE the user
              commits. Binding a collection that already holds hand-uploaded
              documents silently makes the drive the source of truth, and nothing
              anywhere said so: the word "removed" appeared only in the post-hoc
              result toast. */}
          <p className="u-label-sm u-text-muted u-m-0">{t('pruneWarning')}</p>
          <Button variant="primary" disabled={busy || !connectionId || !folderId.trim()} onClick={() => void add()}><PlusIcon size={14} /> {t('add')}</Button>
        </div>
      )}
      {/* KB-UX-20 (closed 2026-09-03) — this used to be `{available ? … : null}`.
          The component early-returns `null` when `!available` (see the feature
          gate above), so the guard was UNCONDITIONALLY TRUE and the `: null` arm
          was unreachable: a reader had to trace two hundred lines to learn that
          a conditional decided nothing. A dead branch is a claim that this can
          render without the feature, and it cannot. */}
      <div className="u-mt-1">
        {/* Accessible name = the concise visible label; the longer help text is
            wired via aria-describedby so the two no longer diverge. */}
        <label className="u-flex u-gap-1 u-items-center">
          <input type="checkbox" checked={includeMedia} onChange={(e) => setIncludeMedia(e.target.checked)} aria-describedby={mediaHelpId} />
          <span className="u-label-sm">{t('includeMediaLabel')}</span>
        </label>
        <p id={mediaHelpId} className="u-label-sm u-text-muted u-m-0">{t('includeMediaHelp')}</p>
      </div>
      {picking && canBrowse ? (
        <FolderPicker orgId={orgId} connectionId={connectionId} onSelect={(id) => { setFolderId(id); setPicking(false); }} />
      ) : null}
    </div>
  );
}
