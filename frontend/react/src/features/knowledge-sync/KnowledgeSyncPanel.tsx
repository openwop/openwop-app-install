/**
 * Knowledge-sync panel (ADR 0107 Phase 5) — the "Add sync" surface, mounted in a
 * KB collection's view. Binds a connected Drive folder → this collection on a
 * cadence, lists the collection's sync sources with status + last-sync, and offers
 * Sync-now / pause / remove. SELF-GATES: if the `knowledge-sync` toggle is off the
 * list call 404s and the panel renders nothing (the GovernancePanel pattern).
 *
 * ADR 1101 D8 — it offers only what the host will do. A reader (no `workspace:write`)
 * sees the list and what each source last did, and no write control at all
 * (`KS2UX-1`: every one used to end in a 403 toast). While access is still being
 * read the controls render DISABLED rather than absent (the page's sibling
 * convention), so a writer sees no layout jump. And every failure is a sentence in
 * the reader's language (D7), with the server's English kept behind "Details".
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '../../ui/toast.js';
import { confirm } from '../../ui/confirm.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { Notice } from '../../ui/Notice.js';
import { PlusIcon, TrashIcon, RotateCwIcon, PauseIcon, PlayIcon, ImageIcon } from '../../ui/icons/index.js';
import { formatDateTime } from '../../i18n/format.js';
import { classifyHttpError, errorReasonOf } from '../../client/classifyHttpError.js';
import { listConnections, type Connection } from '../connections/connectionsClient.js';
import { FolderPicker } from './FolderPicker.js';
import {
  listSyncSources, createSyncSource, deleteSyncSource, setSyncPaused, setSyncIncludeMedia, syncNow, rebindSyncSource,
  type SyncSource, type SyncCadence,
} from './knowledgeSyncClient.js';

const CADENCES: SyncCadence[] = ['15m', 'hourly', 'daily'];
const SYNC_PROVIDERS = new Set(['google', 'microsoft-graph', 'dropbox', 'box']);
/** The provider family a source and a connection must share to be rebound. */
const family = (p: string): string => (p === 'microsoft-sharepoint' ? 'microsoft-graph' : p);
/** Pauses whose exit is a person with access, not Resume (ADR 1101 D5b). */
const NEEDS_REBIND = new Set(['creator-erased', 'creator-no-access']);
/** Codes whose exit is a different account, so Rebind is offered for them. */
const REBIND_CODES = new Set(['connection_revoked', 'connection_unusable', 'connection_missing', 'connection_owner_changed', 'creator_erased', 'creator_no_access']);
/** The cause for a row written before ADR 1101 (no `lastErrorCode`), from its pause
 *  reason — so a revoked or erased source keeps a readable instruction, not "failed". */
const CODE_FOR_PAUSE: Readonly<Record<string, string>> = {
  'connection-revoked': 'connection_revoked',
  'creator-erased': 'creator_erased',
  'creator-no-access': 'creator_no_access',
  removing: 'removing',
};
const codeOf = (s: SyncSource): string | undefined =>
  s.lastErrorCode ?? (s.status === 'paused' && s.pausedReason ? CODE_FOR_PAUSE[s.pausedReason] : undefined);

export function KnowledgeSyncPanel({ orgId, collectionId, showWrites = true, writesDisabled = false }: {
  orgId: string;
  collectionId: string;
  /** ADR 1101 D8 — the caller may write this org (or access is still loading). */
  showWrites?: boolean;
  /** Writes are temporarily impossible (access loading, or a reindex holds the lock). */
  writesDisabled?: boolean;
}): JSX.Element | null {
  const { t } = useTranslation('knowledge-sync');
  const mediaHelpId = useId();
  const [sources, setSources] = useState<SyncSource[] | null>(null);
  const [available, setAvailable] = useState(true); // toggled off ⇒ hide
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /** ADR 1101 D8 — the rows with a request in flight, each on its own (one shared
   *  flag froze every row; one shared id let row B's action un-busy row A). */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const headingRef = useRef<HTMLHeadingElement>(null);
  // add-form state
  const [connectionId, setConnectionId] = useState('');
  const [folderId, setFolderId] = useState('');
  const [folderName, setFolderName] = useState<string | undefined>(undefined);
  const [cadence, setCadence] = useState<SyncCadence>('daily');
  const [includeMedia, setIncludeMedia] = useState(true);
  // For a Microsoft Graph connection, the same credential serves OneDrive OR SharePoint;
  // the user picks which (SharePoint folders are addressed `{driveId}` or `{driveId}:{itemId}`).
  const [msSourceType, setMsSourceType] = useState<'onedrive' | 'sharepoint'>('onedrive');
  const [picking, setPicking] = useState(false);

  /** ADR 1101 D7 — the sentence for a failed action, never the server's English. */
  const failure = useCallback((err: unknown, fallbackKey: string): string => {
    const c = classifyHttpError(err);
    if (c.kind === 'forbidden') return t('errForbidden');
    const reason = errorReasonOf(err);
    if (reason === 'in_flight') return t('errInFlight');
    if (reason === 'removing') return t('errRemoving');
    if (reason === 'paused_revoked') return t('syncNowReconnectFirst');
    if (reason === 'creator_no_access') return t('error_creator_no_access');
    if (reason === 'creator_erased') return t('error_creator_erased');
    if (reason === 'source_active') return t('errPauseFirst');
    if (reason === 'org_connection') return t('errOrgConnection');
    if (reason === 'provider_mismatch') return t('errProviderMismatch');
    if (reason === 'write_contention') return t('errContention');
    if (reason === 'legal_hold') return t('errLegalHold');
    if (c.kind === 'offline') return t('errOffline');
    return t(fallbackKey);
  }, [t]);

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
        // ADR 1101 D2 — an org-shared connection (an `orgId`, no person) cannot drive
        // a sync, and the server refuses it at create, so it is not offered.
        setConnections(c.filter((x) => SYNC_PROVIDERS.has(x.provider) && !(x.orgId && !x.userId)));
      })
      // Falling back to [] rendered "Connect a Google Drive or OneDrive account
      // first" — telling the user to go do work they may already have done.
      .catch((e) => setConnectionsError(e instanceof Error ? e.message : String(e)));
  }, [load]);

  const add = useCallback(async () => {
    if (!connectionId || !folderId.trim()) return;
    setAdding(true);
    try {
      const conn = connections.find((c) => c.connectionId === connectionId);
      const provider =
        conn?.provider === 'microsoft-graph' && msSourceType === 'sharepoint' ? 'microsoft-sharepoint' : (conn?.provider ?? 'google');
      await createSyncSource({ orgId, connectionId, provider, externalFolderId: folderId.trim(), collectionId, cadence, includeMedia, ...(folderName ? { folderName } : {}) });
      setFolderId('');
      setFolderName(undefined);
      toast.success(t('added'));
      load();
    } catch (err) {
      toast.error(failure(err, 'addFailed'));
    } finally { setAdding(false); }
  }, [orgId, collectionId, connectionId, folderId, folderName, cadence, includeMedia, msSourceType, connections, t, load, failure]);

  const selectedProvider = connections.find((c) => c.connectionId === connectionId)?.provider;
  const selectedIsMicrosoft = selectedProvider === 'microsoft-graph';
  // Browsable today: Google / OneDrive / Dropbox / Box (SharePoint browsing is deferred → raw id).
  const canBrowse = !!connectionId && (
    selectedProvider === 'google' || selectedProvider === 'dropbox' || selectedProvider === 'box' ||
    (selectedIsMicrosoft && msSourceType === 'onedrive')
  );

  /** Run one row action with that row (and only that row) marked busy. */
  const onRow = useCallback(async (s: SyncSource, fn: () => Promise<void>) => {
    setBusy((b) => new Set(b).add(s.id));
    try { await fn(); } finally { setBusy((b) => { const n = new Set(b); n.delete(s.id); return n; }); }
  }, []);
  /** After an action that unmounts what had focus (a removed row, a closed notice),
   *  put focus somewhere sensible rather than on <body>. */
  const refocus = useCallback(() => { headingRef.current?.focus(); }, []);

  const runNow = useCallback((s: SyncSource) => onRow(s, async () => {
    try {
      const { result } = await syncNow(s.id);
      // The result already CARRIES a `failed` count (and `errors[]`), and the copy
      // already prints it — but it was announced with success styling, so a sync
      // that dropped documents looked like a clean one. Severity tracks the outcome.
      // ADR 0605 Tier 6 (`KSU-8`) — `skippedMedia` is reported, so a media-off source
      // over a folder of images does not read as a clean full sync.
      const msg = t('syncResult', {
        ingested: result.ingested, pruned: result.pruned,
        skipped: result.skippedMedia, failed: result.failed,
      });
      // ADR 0605 Tier 1 — a pass that could not read the whole folder pruned NOTHING
      // by refusal. ADR 1101 D1 — nor did one the source changed under.
      if (result.listingIncomplete) toast.warning(`${msg} ${t('syncPartial')}`);
      else if (result.pruneSkipped) toast.warning(`${msg} ${t('syncPruneSkipped')}`);
      else if (result.failed > 0) toast.warning(`${msg} ${t('syncSomeFailed')}`);
      else toast.success(msg);
    } catch (err) {
      toast.error(failure(err, 'syncFailed'));
    }
    load();
  }), [t, load, failure, onRow]);

  // `error` ⇒ Resume (ADR 1101 D8, `KSC-6`): an errored source used to show PAUSE.
  const togglePause = useCallback((s: SyncSource) => onRow(s, async () => {
    try { await setSyncPaused(s.id, s.status === 'active'); load(); }
    catch (err) { toast.error(failure(err, 'updateFailed')); }
  }), [load, failure, onRow]);

  const remove = useCallback((s: SyncSource) => onRow(s, async () => {
    // ADR 1101 D5 (`KS2UX-3`) — say what Remove takes with it. It used to ask
    // "Remove this sync source?" and silently leave every synced document behind.
    const n = s.syncedDocuments ?? 0;
    if (!(await confirm({
      title: t('removeSourceConfirm'),
      body: n > 0 ? t('removeSourceBody', { count: n }) : t('removeSourceBodyNone'),
      confirmLabel: t('remove'),
      danger: true,
    }))) return;
    try {
      const out = await deleteSyncSource(s.id);
      if (out.removing) toast.warning(t('removeIncomplete'));
      else toast.success(out.documentsRemoved > 0 ? t('removed', { count: out.documentsRemoved }) : t('removedNone'));
      refocus();
      load();
    } catch (err) { toast.error(failure(err, 'removeFailed')); load(); }
  }), [t, load, failure, onRow, refocus]);

  const toggleMedia = useCallback((s: SyncSource) => onRow(s, async () => {
    // currently off (includeMedia === false) → turn on (true); else turn off (false)
    const turningOn = s.includeMedia === false;
    // ADR 0605 Tier 6 (`KSU-4`) — turning media OFF is a one-click DESTRUCTIVE act:
    // the next pass PRUNES every already-synced image and audio file. The warning
    // sits on the control that causes it.
    if (!turningOn && !(await confirm({
      title: t('mediaOffConfirmTitle'),
      body: t('mediaOffConfirmBody'),
      confirmLabel: t('mediaOffConfirmAction'),
      danger: true,
    }))) return;
    try { await setSyncIncludeMedia(s.id, turningOn); load(); }
    catch (err) { toast.error(failure(err, 'updateFailed')); }
  }), [t, load, failure, onRow]);

  // ADR 1101 D5b — switch a stopped source to one of MY connections for the same
  // provider, keeping the source and every document it synced.
  const rebind = useCallback((s: SyncSource, conn: Connection) => onRow(s, async () => {
    if (!(await confirm({
      title: t('rebindConfirmTitle'),
      body: t('rebindConfirmBody', { account: conn.displayName }),
      confirmLabel: t('rebindAction'),
    }))) return;
    try { await rebindSyncSource(s.id, conn.connectionId); toast.success(t('rebound')); refocus(); load(); }
    catch (err) { toast.error(failure(err, 'updateFailed')); }
  }), [t, load, failure, onRow, refocus]);

  if (!available) return null; // feature off

  // ADR 0605 R1 (review LOW 7) — announce ONCE for the whole list: the single
  // `GlobalLiveRegion` assertive slot holds ONE string, so N errored rows would
  // stomp each other. Exactly one row carries the announcement, as a `t()` sentence.
  const firstErrorId = sources?.find((s) => s.lastError || codeOf(s))?.id;
  const mine = (s: SyncSource): Connection | undefined => connections.find((c) => c.connectionId === s.connectionId);

  return (
    <div className="surface-card u-gap-2">
      <div className="u-grid u-gap-1">
        <h2 ref={headingRef} tabIndex={-1} className="u-fs-16 u-m-0">{t('title')}</h2>
        <p className="u-label-sm u-m-0">{t('blurb')}</p>
        {/* ADR 1101 D8 — one line for a reader, who sees no write controls below. */}
        {showWrites ? null : <p className="u-label-sm u-text-muted u-m-0">{t('readOnlyNote')}</p>}
      </div>

      {loadError ? (
        <Notice variant="error" announce={t('loadFailed')}>
          {t('loadFailed')}
          <details className="u-mt-1"><summary className="u-label-sm">{t('details')}</summary><span className="u-label-sm">{loadError}</span></details>
        </Notice>
      ) : null}

      {/* existing sources */}
      {loadError ? null : !sources ? <Skeleton /> : sources.length === 0 ? (
        <span className="u-label-sm">{t('none')}</span>
      ) : sources.map((s) => {
        // ADR 0605 Tier 6 (`KSU-3`) — a REVOKED credential is not a user pause.
        const needsReconnect = s.status === 'paused' && s.pausedReason === 'connection-revoked';
        const removing = s.status === 'paused' && s.pausedReason === 'removing';
        const needsRebind = s.status === 'paused' && NEEDS_REBIND.has(s.pausedReason ?? '');
        const rowBusy = busy.has(s.id);
        const blocked = writesDisabled || rowBusy;
        const own = mine(s);
        // Rebind targets: MY connections (or the workspace's) for this provider family,
        // other than the one the source already uses.
        const rebindTargets = connections.filter((c) => family(c.provider) === family(s.provider) && c.connectionId !== s.connectionId);
        const code = codeOf(s);
        // Only where the exit IS a different account — not on every transient error.
        const offerRebind = showWrites && !removing && (needsRebind || needsReconnect || (s.status === 'error' && REBIND_CODES.has(code ?? ''))) && rebindTargets.length > 0;
        const statusChip = needsReconnect
          ? <span className="chip chip--danger">{t('statusReconnect')}</span>
          : removing
            ? <span className="chip chip--muted">{t('statusRemoving')}</span>
            : needsRebind
              ? <span className="chip chip--warning">{t('statusNeedsAccount')}</span>
              : <span className={`chip ${s.status === 'error' ? 'chip--danger' : s.status === 'paused' ? 'chip--muted' : 'chip--success'}`}>{t(`status_${s.status}`)}</span>;
        return (
        <div key={s.id} className="u-grid u-gap-1" aria-busy={rowBusy || undefined}>
          <div className="u-flex u-gap-2 u-items-center u-wrap">
            <span className="u-flex-1 u-truncate u-min-w-0" title={s.folderName ?? s.externalFolderId}>{s.folderName ?? s.externalFolderId}</span>
            {statusChip}
            <span className="u-label-sm">{t(`cadence_${s.cadence}`)}</span>
            {showWrites ? (
              <>
                {/* ADR 0605 R1 — "Sync now" is refused server-side for a REVOKED or a
                    REMOVING source, and cannot succeed for one whose person has no
                    access (ADR 1101 D3), so it is not offered there. While this row is
                    busy it is aria-disabled, not disabled, so focus stays on it. */}
                <Button
                  variant="quiet"
                  disabled={writesDisabled || needsReconnect || removing || needsRebind}
                  aria-disabled={rowBusy || undefined}
                  title={needsReconnect ? t('syncNowReconnectFirst') : rowBusy ? t('syncing') : t('syncNow')}
                  aria-label={needsReconnect ? t('syncNowReconnectFirst') : rowBusy ? t('syncing') : t('syncNow')}
                  onClick={() => { if (!rowBusy) void runNow(s); }}
                >
                  <RotateCwIcon size={14} />
                </Button>
                {/* Resume stays offered for a revoked source: after the user reconnects
                    it is the ONLY way back (no `onConnectionRestored` hook exists). It is
                    not offered where it cannot work: a removal, or a pause whose exit is a
                    person with access (ADR 1101 D5b) — except `creator-no-access`, where a
                    restored membership makes the next pass's check pass. */}
                {removing || s.pausedReason === 'creator-erased' ? null : (
                  <Button
                    variant="quiet"
                    disabled={blocked}
                    title={s.status === 'active' ? t('pause') : t('resume')}
                    aria-label={s.status === 'active' ? t('pause') : t('resume')}
                    onClick={() => void togglePause(s)}
                  >
                    {s.status === 'active' ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
                  </Button>
                )}
                {removing ? null : (
                  <Button variant="quiet" disabled={blocked} title={s.includeMedia === false ? t('mediaOff') : t('mediaOn')} aria-label={s.includeMedia === false ? t('mediaOff') : t('mediaOn')} onClick={() => void toggleMedia(s)}><ImageIcon size={14} /></Button>
                )}
                <Button variant="quiet" disabled={blocked} title={removing ? t('removeContinue') : t('remove')} aria-label={removing ? t('removeContinue') : t('remove')} onClick={() => void remove(s)}><TrashIcon size={14} /></Button>
              </>
            ) : null}
          </div>

          {/* Whose account every pass reads the folder as — a pass acts as that person. */}
          <span className="u-label-sm u-text-muted">
            {own ? (own.userId ? t('syncsAsYou', { account: own.displayName }) : t('syncsAsWorkspace', { account: own.displayName })) : t('syncsAsOther')}
          </span>

          {/* ADR 0605 Tier 6 (`KSU-1`/`KSU-2`) — THE LAST RUN, as readable text. */}
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

          {/* ADR 1101 D7 — the cause in the reader's language, the retry state from the
              structured fields, and the server's English detail behind "Details". */}
          {code || s.lastError ? (
            <Notice
              variant={s.status === 'error' || needsReconnect || needsRebind ? 'error' : 'warning'}
              {...(s.id === firstErrorId ? { announce: t('sourceErrorAnnounce') } : {})}
            >
              <span>{t(`error_${code ?? 'sync_failed'}`, { ...(s.lastErrorParams ?? {}), defaultValue: t('error_sync_failed') })}</span>
              {s.status === 'error'
                ? <> {s.consecutiveFailures ? t('retryStopped', { count: s.consecutiveFailures }) : t('retryStoppedNoCount')}</>
                : s.consecutiveFailures ? <> {t('retrying', { count: s.consecutiveFailures })}</> : null}
              {needsReconnect ? (
                <> <a href="/access?tab=connections">{t('reconnectAction')}</a></>
              ) : null}
              {offerRebind ? (
                <span className="u-flex u-gap-1 u-wrap u-mt-1">
                  {rebindTargets.map((c) => (
                    <Button key={c.connectionId} variant="quiet" className="u-break-anywhere" disabled={blocked} onClick={() => void rebind(s, c)}>
                      {t('rebindTo', { account: c.displayName })}
                    </Button>
                  ))}
                </span>
              ) : null}
            </Notice>
          ) : null}
          {/* The server's English detail, outside the Notice (a <details> cannot sit in
              its inline <span>), one disclosure per row. */}
          {s.lastError ? (
            <details>
              <summary className="u-label-sm">{t('details')}</summary>
              <span className="u-label-sm u-break-anywhere">{s.lastError}</span>
            </details>
          ) : null}
        </div>
        );
      })}

      {/* add form — writers only */}
      {!showWrites ? null : connectionsError ? (
        // NOT "connect an account first" — that instructs the user to redo work
        // they may already have done, on the authority of a read that failed.
        <Notice variant="error" announce={t('connectionsFailed')}>
          {t('connectionsFailed')}
          <details className="u-mt-1"><summary className="u-label-sm">{t('details')}</summary><span className="u-label-sm">{connectionsError}</span></details>
        </Notice>
      ) : connections.length === 0 ? (
        <span className="u-label-sm">{t('noConnections')}</span>
      ) : (
        <div className="surface-form">
          <label className="field u-flex-1">
            <span className="field-label">{t('connectionLabel')}</span>
            {/* A folder picked under one account means nothing under another: reset it. */}
            <select value={connectionId} onChange={(e) => { setConnectionId(e.target.value); setFolderId(''); setFolderName(undefined); setPicking(false); }}>
              <option value="">{t('connectionPlaceholder')}</option>
              {connections.map((c) => <option key={c.connectionId} value={c.connectionId}>{c.displayName}</option>)}
            </select>
          </label>
          {selectedIsMicrosoft ? (
            <label className="field">
              <span className="field-label">{t('sourceTypeLabel')}</span>
              <select value={msSourceType} onChange={(e) => setMsSourceType(e.target.value as 'onedrive' | 'sharepoint')}>
                <option value="onedrive">{t('sourceTypeOneDrive')}</option>
                <option value="sharepoint">{t('sourceTypeSharePoint')}</option>
              </select>
            </label>
          ) : null}
          <div className="field u-flex-1">
            <label className="field-label" htmlFor={`${mediaHelpId}-folder`}>{t('folderLabel')}</label>
            <div className="u-flex u-gap-1 u-items-center">
              <input id={`${mediaHelpId}-folder`} className="u-flex-1 u-min-w-0" value={folderId} onChange={(e) => { setFolderId(e.target.value); setFolderName(undefined); }} placeholder={selectedIsMicrosoft && msSourceType === 'sharepoint' ? t('folderPlaceholderSharePoint') : t('folderPlaceholder')} />
              {canBrowse ? <Button variant="quiet" aria-expanded={picking} onClick={() => setPicking((p) => !p)}>{picking ? t('browseClose') : t('browse')}</Button> : null}
            </div>
          </div>
          {/* The picker and the picked name take a FULL row of the form (a field item is
              a third of it, and the row aligns to its bottom edge). */}
          {folderName || (picking && canBrowse) ? (
            <div className="u-w-full u-grid u-gap-1">
              {folderName ? <span className="u-label-sm u-text-muted">{t('folderPicked', { name: folderName })}</span> : null}
              {picking && canBrowse ? (
                <FolderPicker orgId={orgId} connectionId={connectionId} onSelect={(id, name) => { setFolderId(id); setFolderName(id === 'root' ? undefined : name); setPicking(false); }} />
              ) : null}
            </div>
          ) : null}
          <label className="field">
            <span className="field-label">{t('cadenceLabel')}</span>
            <select value={cadence} onChange={(e) => setCadence(e.target.value as SyncCadence)}>
              {CADENCES.map((c) => <option key={c} value={c}>{t(`cadence_${c}`)}</option>)}
            </select>
          </label>
          {/* Accessible name = the concise visible label; the longer help text is
              wired via aria-describedby so the two no longer diverge. */}
          <div className="u-w-full">
            <label className="u-flex u-gap-1 u-items-center">
              <input type="checkbox" checked={includeMedia} onChange={(e) => setIncludeMedia(e.target.checked)} aria-describedby={mediaHelpId} />
              <span className="u-label-sm">{t('includeMediaLabel')}</span>
            </label>
            <p id={mediaHelpId} className="u-label-sm u-text-muted u-m-0">{t('includeMediaHelp')}</p>
          </div>
          {/* ADR 0605 Tier 6 — the destructive semantic, disclosed BEFORE the user
              commits: the collection becomes a mirror of the folder. */}
          <p className="u-label-sm u-text-muted u-m-0 u-w-full">{t('pruneWarning')}</p>
          <Button variant="primary" disabled={adding || writesDisabled || !connectionId || !folderId.trim()} onClick={() => void add()}><PlusIcon size={14} /> {t('add')}</Button>
        </div>
      )}
    </div>
  );
}
