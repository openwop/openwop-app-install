/**
 * Knowledge Base / RAG (host-extension product feature — ADR 0011).
 *
 * Gates on useFeatureAccess('kb'). An org picker drives a collection list; a
 * selected collection shows a semantic-search box (ranked chunks with scores +
 * citations) and an ingest form (paste text — the Media-asset-token source is
 * API-supported too). Retrieval rides the host vector store + the deterministic
 * embedder; grounded answers are a workflow step, so the UI surfaces retrieval.
 *
 * ── Read honesty (ADR 0583 / KB-UX-1, KB-UX-2, KB-UX-4) ────────────────────
 *
 * Every read on this page used to have exactly two renderable states where it
 * has three, and in each case the missing state borrowed the meaning of a state
 * that had not happened:
 *
 *  - **Search** (`KB-UX-1`). `runSearch` toasted and returned WITHOUT clearing
 *    `hits`. After a successful empty search it re-rendered the instructional
 *    "No matches — add documents, or try a different question"; after a
 *    successful non-empty one it left the PREVIOUS query's hits on screen under
 *    the new query. A toast is not a state: it expires, and the false claim
 *    stays. `search` is now `idle | searching | results | failed`, `noMatches`
 *    is reachable ONLY from a resolved empty response, and failure gets a
 *    `StateCard announce` + Retry.
 *
 *  - **Reindex** (`KB-UX-2`). `runToCompletion` returns on ANY non-`running`
 *    status and `start` then fired `toast.success('Reindex complete')`
 *    unconditionally — so `failed`, `cancelled` and `paused` all reported
 *    success and the `reindexFailed` string was unreachable from a job that
 *    reports failure. The terminal status is now branched.
 *
 *  - **Orgs / collections / documents** (`KB-UX-4`). A failed list read left
 *    `null` — the same value as "not read yet" — so the page rendered a
 *    skeleton with NO terminal condition and no retry anywhere. Orgs now ride
 *    the shared `useOrgSelection` + `ui/OrgSelectionState` (64/67 adopters),
 *    whose docstring names this exact bug; collections and documents get the
 *    same failed/empty/loading split with their own retry.
 *
 * The trap in the cure, which this repo has reintroduced three times: a retry
 * that clears the failure flag while STALE EMPTY DATA remains re-renders the
 * false-empty state for one frame. So every retry here clears the DATA and the
 * flag together, and `__tests__/readHonesty.test.tsx` asserts the DOM BETWEEN
 * the click and the settle.
 *
 * ── The reindex is a COLLECTION-WIDE WRITE LOCK (KBX-1…KBX-7, 2026-09-03) ───
 *
 * The 2026-08 pass graded the reindex on what it says when it ENDS. The
 * 2026-09-03 pass graded what OWNS it while it runs, and found the page lying in
 * six directions at once. The shape of the fix, stated once here because it
 * touches half this file:
 *
 *  1. **The job is page state, not panel state** (`KBX-5`). While a job is
 *     `running` or `paused`, `assertNoLiveReindex` 409s `ingestDocument`,
 *     `deleteDocument` and `upsertDocument` for the whole collection — so the
 *     ingest card, the upload field, the URL field, the media importer, both
 *     Delete buttons AND the Drive-sync runner three blocks down are all
 *     guaranteed to fail. They are now disabled and EXPLAINED rather than
 *     enabled and rejected. `useReindexJob` owns the job for the page; the panel
 *     is one consumer of it.
 *  2. **The copy describes the mechanism the app HAS** (`KBX-1`). `reindexHint`
 *     promised the rebuild ran "in the background" in all four locales while a
 *     `for` loop in this tab drove it. ADR 0643 D1b makes that promise true —
 *     a scheduler-driven drain on a ten-minute cadence — so the copy is written
 *     for that end state, and the tab is described for what it then is: the
 *     interactive fast path, not the owner.
 *  3. **A frozen job is not painted as a live one** (`KBX-3`). Nothing polled
 *     and `updatedAt` was rendered nowhere, so the screen for a healthy in-flight
 *     reindex and the screen for one abandoned three days ago were pixel
 *     identical. The panel now polls, stamps the last update, and has a distinct
 *     NOT-ADVANCING state (`DESIGN.md` §4.6 `stale` row).
 *  4. **A stranded `running` job has a non-destructive exit** (`KBX-2`). Resume
 *     was gated on `paused` although `resume()` is status-agnostic, so the only
 *     control a stranded job offered was Cancel — i.e. "discard the entire
 *     staged rebuild". Both statuses now offer Continue/Resume, and Cancel is
 *     confirmed and named for what it destroys (`KBX-7`).
 *  5. **The pause is announced** (`KBX-6`). `reportTerminal` suppresses the
 *     `paused` toast because the Notice is on screen persistently — but that
 *     Notice had no `announce`, and `ui/Notice.tsx` documents at length that a
 *     region mounted with its text already inside announces nothing. So the one
 *     ending that was deliberately not toasted was also the one nobody could
 *     hear.
 *  6. **A failure is words, not a wire diagnostic** (`KBX-4`). See
 *     `kbUiHelpers.kbActionError`.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { formatDateTime, formatNumber, formatRelativeTime } from '../../i18n/format.js';
import { PageHeader } from '../../ui/PageHeader.js';

import { confirm } from '../../ui/confirm.js';import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { announce } from '../../ui/announce.js';
import { DeepLinkMissNotice, isDeepLinkMiss } from '../../ui/DeepLinkMissNotice.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { KnowledgeSyncPanel } from '../knowledge-sync/KnowledgeSyncPanel.js';
import { toast } from '../../ui/toast.js';
import { InfoTip } from '../../ui/InfoTip.js';
import { ViewToggle, useViewMode } from '../../ui/ViewToggle.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { ArrowLeftIcon, BoxesIcon, DatabaseIcon, FileTextIcon, LockIcon, PaperclipIcon, PlusIcon, RotateCwIcon, SearchIcon, TrashIcon } from '../../ui/icons/index.js';
import { fileToBase64, inferContentType, KB_UPLOAD_ACCEPT, withinUploadCap, MAX_UPLOAD_MB } from '../../client/fileToBase64.js';
import {
  createCollection,
  deleteCollection,
  deleteDocument,
  ingestFile,
  ingestText,
  ingestUrl,
  ingestMediaCollection,
  setEnrichmentMode,
  listCollections,
  listDocuments,
  getDocument,
  listOrgs,
  search,
  type KbCollection,
  type KbDocument,
  type KbDocumentDetail,
  type Org,
  setRetrievalMode, setEmbedderMode,
  type RetrievalMode,
  type EmbedderMode,
  type EnrichmentMode,
  type SearchHit,
  startReindex, drainReindex, cancelReindex, getReindexJob,
  type EmbeddingProvider, type ReindexJob,
} from './kbClient.js';
import { kbActionError, focusFirst } from './kbUiHelpers.js';
// ADR 0398 P2 — read the tenant's media collections for the "add source" picker (kb→media read).
import { listCollections as listMediaCollections, type MediaCollection } from '../media/mediaClient.js';
import { DocumentCard, DocumentRow } from './KbViews.js';

// Bound the default-open DOM cost of a large doc (grade-code DL-P-1): render a
// preview and reveal the rest on demand. Ingest caps text at 400k chars, so the
// expanded worst case is still bounded.
const DOC_PREVIEW_CHARS = 40_000;
function truncateAtBoundary(text: string, n: number): string {
  if (text.length <= n) return text;
  const slice = text.slice(0, n);
  const lastWs = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
  return `${slice.slice(0, lastWs > n * 0.8 ? lastWs : n)}…`;
}

/** The document reader body — plain-text child (React-escaped; no innerHTML), with
 *  a preview/show-full toggle. Keyed on the doc id by the caller so `showFull`
 *  resets on doc switch (DL-P-1 / architect review). */
function DocReader({ text }: { text: string }): JSX.Element {
  const { t } = useTranslation('kb');
  const [showFull, setShowFull] = useState(false);
  const truncated = !showFull && text.length > DOC_PREVIEW_CHARS;
  return (
    <>
      <div className="kbase-doc-reader">{truncated ? truncateAtBoundary(text, DOC_PREVIEW_CHARS) : text}</div>
      {truncated ? (
        <Button variant="secondary" size="sm" className="u-justify-start" onClick={() => setShowFull(true)}>
          {t('showFullDocument', { n: formatNumber(text.length) })}
        </Button>
      ) : null}
    </>
  );
}

/** How often the page re-reads a live reindex job it is not itself draining
 *  (`KBX-3`). Nothing polled before, so a job that stopped advancing rendered
 *  identically to one that never had. */
const REINDEX_POLL_MS = 10_000;
/**
 * How long a `running` job may go without its `updatedAt` moving before the UI
 * stops calling it live (`KBX-3`).
 *
 * This is deliberately FAR below ADR 0643 D1a's `REINDEX_LEASE_MS` (30 min, the
 * backend's own self-heal). The two answer different questions: the lease asks
 * "may this job keep blocking writes?", the UI asks "should I still be telling
 * the operator this is progressing?". A drain batch that takes two minutes is
 * already worth flagging to a human who is watching the bar.
 */
const REINDEX_STALL_MS = 120_000;

/** Everything the PAGE needs to know about the collection's reindex, and the
 *  handles the panel needs to drive it. Lifted out of `ReindexPanel` for
 *  `KBX-5`: the job is a collection-wide write lock, so it cannot be private to
 *  the control that starts it. */
interface ReindexController {
  job: ReindexJob | null;
  /** KB-UX-11 — the mount read used to be `.catch(() => {})`, so a failed read
   *  rendered the idle Start form OVER a live job: the operator was invited to
   *  start a second reindex of a collection that was already locked. */
  jobReadFailed: boolean;
  /** `running` or `paused` — i.e. every document write to this collection 409s. */
  locked: boolean;
  /** `running`, not advancing, and not being drained by this tab. */
  stalled: boolean;
  draining: boolean;
  setJob: (job: ReindexJob | null) => void;
  setDraining: (draining: boolean) => void;
  refresh: () => void;
  refreshing: boolean;
}

function useReindexJob(orgId: string, collectionId: string): ReindexController {
  const [job, setJob] = useState<ReindexJob | null>(null);
  const [jobReadFailed, setJobReadFailed] = useState(false);
  const [draining, setDraining] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // A ticker, so "last updated 4 minutes ago" and the not-advancing threshold
  // both move without a re-read. Derived state that depends on wall-clock time
  // is stale-by-construction unless something re-renders it.
  const [now, setNow] = useState(() => Date.now());
  const [reload, setReload] = useState(0);

  const refresh = useCallback(() => { setReload((n) => n + 1); }, []);

  useEffect(() => {
    if (!orgId || !collectionId) { setJob(null); setJobReadFailed(false); return; }
    let live = true;
    setRefreshing(true);
    void getReindexJob(orgId, collectionId)
      .then((j) => { if (live) { setJob(j); setJobReadFailed(false); } })
      .catch((e) => { if (live) { console.warn('[kb] reindex job read failed:', e); setJobReadFailed(true); } })
      .finally(() => { if (live) setRefreshing(false); });
    return () => { live = false; };
  }, [orgId, collectionId, reload]);

  const active = !!job && (job.status === 'running' || job.status === 'paused' || job.status === 'cutting-over');

  // Poll while a job is live and this tab is NOT the one draining it — the
  // drain's own responses already carry fresher state, and double-driving it
  // would race two writers onto the same row.
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      setNow(Date.now());
      if (!draining) setReload((n) => n + 1);
    }, REINDEX_POLL_MS);
    return () => window.clearInterval(id);
  }, [active, draining]);

  const updatedMs = job ? Date.parse(job.updatedAt) : Number.NaN;
  const stalled = !!job && job.status === 'running' && !draining
    && Number.isFinite(updatedMs) && now - updatedMs > REINDEX_STALL_MS;

  return { job, jobReadFailed, locked: active, stalled, draining, setJob, setDraining, refresh, refreshing };
}

export function KnowledgeBasePage(): JSX.Element {
  const { t } = useTranslation('kb');
  const access = { enabled: true, loading: false }; // always-on (toggle removed)
  const [searchParams, setSearchParams] = useSearchParams();
  // Deep-link spine (Phase 4): store rides ?org=, the open collection rides
  // ?collection= — the URL owns the selection (Funnels/Forms reference), so a
  // link/reload restores it. `selected` derives from the loaded list.
  //
  // KB-UX-4 — this was a hand-rolled `useState<Org[] | null>` + a `.catch` that
  // set only a toast-shaped `error` string, so a failed read left `orgs` null
  // (indistinguishable from "still reading") and the org-gated collection read
  // never started: a skeleton with no terminal condition. The shared hook keeps
  // `orgs` null on failure BY DESIGN and hands back `orgsFailed` + `retry`;
  // `OrgSelectionState` owns the branch ORDER (failed → empty → children).
  const initialOrgId = useMemo(() => searchParams.get('org') ?? '', []); // eslint-disable-line react-hooks/exhaustive-deps
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } = useOrgSelection<Org>(listOrgs, true, initialOrgId);
  const [collections, setCollections] = useState<KbCollection[] | null>(null);
  const [collectionsFailed, setCollectionsFailed] = useState(false);
  const selectedId = searchParams.get('collection') ?? '';
  const [docs, setDocs] = useState<KbDocument[] | null>(null);
  const [docsFailed, setDocsFailed] = useState(false);
  const [newName, setNewName] = useState('');
  const [docTitle, setDocTitle] = useState('');
  const [docText, setDocText] = useState('');
  const [query, setQuery] = useState('');
  /**
   * KB-UX-1 — the search read's states, as one value rather than a nullable
   * array plus an expiring toast. `query` on the `results` state is the query
   * those hits answer, so a stale render is structurally impossible: the hits
   * and the question they belong to move together.
   *
   * KBX-8 adds the fourth arm. `runSearch` already cleared to `idle` BEFORE
   * awaiting — which is right, and is what the retry-frame test pins — but
   * `idle` renders nothing, so the results region simply emptied on every
   * re-search and the only feedback was the button label. `searching` carries
   * the query too, so the in-flight frame can say what it is answering. The
   * clear is NOT weakened: `setSearchState` still replaces the whole value, so
   * no hit from the previous query survives into it.
   */
  type SearchState =
    | { kind: 'idle' }
    | { kind: 'searching'; query: string }
    | { kind: 'results'; hits: SearchHit[]; query: string }
    | { kind: 'failed'; message: string; query: string };
  const [searchState, setSearchState] = useState<SearchState>({ kind: 'idle' });
  /**
   * KBX-9 — one page-level `busy` used to gate six unrelated controls, so a slow
   * search disabled the whole ingest card and a slow upload disabled search.
   * Each write now owns its own pending flag, and the region it belongs to
   * carries `aria-busy` while it is in flight.
   */
  const [creating, setCreating] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [addingUrl, setAddingUrl] = useState(false);
  const [importingMedia, setImportingMedia] = useState(false);
  const searching = searchState.kind === 'searching';
  // Document list filter + the §4.5 grid/list collection-view canon (rule 11).
  const [docQuery, setDocQuery] = useState('');
  const [viewMode, setViewMode] = useViewMode('kb', 'grid');
  // Collections-rail name filter (rule 13, rail variant — the Forms precedent).
  const [collQuery, setCollQuery] = useState('');

  const visibleDocs = useMemo(() => {
    const q = docQuery.trim().toLowerCase();
    if (!q) return docs ?? [];
    return (docs ?? []).filter((d) => d.title.toLowerCase().includes(q));
  }, [docs, docQuery]);

  const visibleCollections = useMemo(() => {
    const q = collQuery.trim().toLowerCase();
    if (!q) return collections ?? [];
    return (collections ?? []).filter((c) => c.name.toLowerCase().includes(q));
  }, [collections, collQuery]);

  // The selected collection derives from ?collection= (validity: a param naming
  // no loaded collection reads as "none selected"). Writers mirror to the URL.
  const selected = useMemo(() => collections?.find((c) => c.collectionId === selectedId) ?? null, [collections, selectedId]);

  /**
   * KBX-5 — the write lock, owned by the PAGE. Every consumer below derives
   * from this one value, so there is exactly one answer on screen to "can I
   * write to this collection right now?".
   */
  const reindex = useReindexJob(orgId, selected?.collectionId ?? '');
  const writesLocked = reindex.locked;
  const lockReason = writesLocked ? t('writesPausedShort') : undefined;

  const selectOrg = useCallback((id: string) => {
    setOrgId(id);
    setCollQuery(''); // a stale rail filter must not hide the new org's collections
    setSearchParams((p) => { const n = new URLSearchParams(p); n.set('org', id); n.delete('collection'); return n; }, { replace: true });
  }, [setSearchParams, setOrgId]);
  const selectCollection = useCallback((id: string) => {
    setSearchParams((p) => { const n = new URLSearchParams(p); if (id) n.set('collection', id); else n.delete('collection'); n.delete('doc'); return n; }, { replace: true });
  }, [setSearchParams]);
  /** The rail cell's href — the SAME transition `selectCollection` performs, as
   *  a URL the browser can open in a new tab or copy. Keeping both in step is
   *  why this derives from `searchParams` rather than hard-coding the query. */
  const collectionHref = useCallback((id: string): string => {
    const n = new URLSearchParams(searchParams);
    n.set('collection', id); n.delete('doc');
    return `?${n.toString()}`;
  }, [searchParams]);
  // Deep-link spine (ADR 0336): the open document rides ?doc= — a reader in the
  // panel renders the doc's already-loaded text (validity: an unknown id reads closed).
  const selectedDocId = searchParams.get('doc') ?? '';
  const selectedDoc = useMemo(() => docs?.find((d) => d.documentId === selectedDocId) ?? null, [docs, selectedDocId]);
  const selectDoc = useCallback((id: string) => {
    setSearchParams((p) => { const n = new URLSearchParams(p); if (id) n.set('doc', id); else n.delete('doc'); return n; }, { replace: true });
  }, [setSearchParams]);
  // The list carries metadata only, so fetch the open doc's full text on demand.
  const [docContent, setDocContent] = useState<KbDocumentDetail | null>(null);
  const [docLoading, setDocLoading] = useState(false);

  /**
   * KBX-12 — focus after a destructive action, deferred past the reload.
   *
   * A delete unmounts the button that had focus, and `ui/Modal` restores focus
   * to its trigger — a node that no longer exists — so focus fell to `<body>`:
   * no position for a keyboard user, no announcement for a screen-reader one.
   * The target is claimed here and CONSUMED by an effect that runs after the
   * list read commits, because the delete itself changes what is mounted (the
   * last document swaps the list for the empty StateCard; the fourth-to-last
   * unmounts the gated filter). Every chain ends on a heading that is mounted in
   * every state of its region.
   */
  const [pendingFocus, setPendingFocus] = useState<'documents' | 'collections' | null>(null);
  const docsHeadingRef = useRef<HTMLHeadingElement>(null);
  const docFilterRef = useRef<HTMLInputElement>(null);
  const collectionsHeadingRef = useRef<HTMLHeadingElement>(null);
  const newCollectionRef = useRef<HTMLInputElement>(null);

  /**
   * KB-UX-4 — the documents read, with its failure distinguishable from both
   * "not read yet" (`docs === null && !docsFailed`) and "this collection has
   * none" (`docs === []`). The failure branch clears `docs` FIRST: leaving a
   * stale `[]` behind means the retry's in-flight frame re-renders the "No
   * documents" empty state, which is the exact family this repo reintroduced
   * three times while "fixing" it.
   */
  const reloadDocs = useCallback(() => {
    if (!selectedId || !orgId) { setDocs(null); setDocsFailed(false); return; }
    setDocs(null); setDocsFailed(false);
    void listDocuments(orgId, selectedId).then((d) => { setDocs(d); setDocsFailed(false); })
      .catch(() => { setDocs(null); setDocsFailed(true); });
  }, [orgId, selectedId]);

  /** Returns the promise (KBX-10): a select that shows an optimistic value must
   *  know when the authoritative list has caught up before it drops it. */
  const loadCollections = useCallback((org: string): Promise<void> => {
    setCollections(null); setCollectionsFailed(false);
    return listCollections(org).then((c) => { setCollections(c); setCollectionsFailed(false); })
      .catch(() => { setCollections(null); setCollectionsFailed(true); });
  }, []);

  useEffect(() => { if (orgId) void loadCollections(orgId); }, [orgId, loadCollections]);
  // Load the selected collection's docs whenever the selection changes — incl.
  // a ?collection= deep-link resolving once the collections list arrives.
  useEffect(() => { setSearchState({ kind: 'idle' }); setDocQuery(''); reloadDocs(); }, [reloadDocs]);

  useEffect(() => {
    if (!pendingFocus) return;
    if (pendingFocus === 'documents') {
      if (docs === null && !docsFailed) return; // the read has not committed yet
      focusFirst(docFilterRef.current, docsHeadingRef.current);
    } else {
      if (collections === null && !collectionsFailed) return;
      focusFirst(newCollectionRef.current, collectionsHeadingRef.current);
    }
    setPendingFocus(null);
  }, [pendingFocus, docs, docsFailed, collections, collectionsFailed]);

  // Fetch the open document's full text on demand (?doc= deep-link or a click).
  // A local error state renders an inline retry IN the reader — not a perpetual
  // skeleton (grade-ux DL-UX-3). `docReloadKey` re-runs the fetch on retry.
  const [docError, setDocError] = useState(false);
  const [docReloadKey, setDocReloadKey] = useState(0);
  useEffect(() => {
    if (!selectedDocId || !selectedId || !orgId) { setDocContent(null); return; }
    let active = true;
    setDocLoading(true); setDocContent(null); setDocError(false);
    void getDocument(orgId, selectedId, selectedDocId)
      .then((d) => { if (active) setDocContent(d); })
      .catch(() => { if (active) setDocError(true); })
      .finally(() => { if (active) setDocLoading(false); });
    return () => { active = false; };
  }, [selectedDocId, selectedId, orgId, docReloadKey]);

  const create = useCallback(async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await createCollection(orgId, newName.trim());
      const created = newName.trim();
      setNewName('');
      void loadCollections(orgId);
      toast.success(t('collectionCreated', { name: created })); // KBX-11
    }
    catch (e) { toast.error(kbActionError(e, 'createFailed')); }
    finally { setCreating(false); }
  }, [orgId, newName, loadCollections, t]);

  const removeCollection = useCallback(async (collectionId: string, name: string) => {
    if (!(await confirm({ title: t('deleteCollectionConfirm', { name }), body: t('deleteCollectionBody'), danger: true, confirmLabel: t('common:delete') }))) return;
    try {
      await deleteCollection(orgId, collectionId);
      if (selectedId === collectionId) selectCollection('');
      void loadCollections(orgId);
      setPendingFocus('collections'); // KBX-12
      toast.success(t('collectionDeleted', { name })); // KBX-11
    }
    catch (e) { toast.error(kbActionError(e, 'deleteFailed')); }
  }, [orgId, selectedId, selectCollection, loadCollections, t]);

  const [docUrl, setDocUrl] = useState('');

  // ADR 0398 P2 — media-collection → KB source picker.
  const [mediaCollections, setMediaCollections] = useState<MediaCollection[] | null>(null);
  const [mediaCollectionId, setMediaCollectionId] = useState('');
  const [mediaFailed, setMediaFailed] = useState(false);
  useEffect(() => {
    if (!orgId) { setMediaCollections(null); return; }
    // `[]` on failure silently removed the media-ingest option (gated on
    // `length > 0`), making a failed read indistinguishable from "this org has
    // no media collections".
    void listMediaCollections(orgId)
      .then((mc) => { setMediaCollections(mc); setMediaFailed(false); })
      .catch(() => { setMediaCollections([]); setMediaFailed(true); });
  }, [orgId]);

  const ingestFromMediaCollection = useCallback(async () => {
    if (!selected || !mediaCollectionId) return;
    setImportingMedia(true);
    try {
      const r = await ingestMediaCollection(orgId, selected.collectionId, mediaCollectionId);
      setMediaCollectionId('');
      reloadDocs();
      void loadCollections(orgId);
      if (r.skipped.length > 0) {
        toast.info(t('mediaBridgeResultSkipped', { ingested: r.ingested, skipped: r.skipped.length }));
      } else {
        toast.success(t('mediaBridgeResult', { ingested: r.ingested }));
      }
    } catch (e) { toast.error(kbActionError(e, 'ingestFailed')); }
    finally { setImportingMedia(false); }
  }, [orgId, selected, mediaCollectionId, reloadDocs, loadCollections, t]);

  // ADR 0351 P4 — ingest a web page by URL (fenced untrusted server-side).
  const ingestFromUrl = useCallback(async () => {
    if (!selected || !docUrl.trim()) return;
    setAddingUrl(true);
    try {
      await ingestUrl(orgId, selected.collectionId, docUrl.trim());
      setDocUrl('');
      reloadDocs();
      void loadCollections(orgId);
      toast.success(t('documentAdded'));
    } catch (e) { toast.error(kbActionError(e, 'ingestFailed')); }
    finally { setAddingUrl(false); }
  }, [orgId, selected, docUrl, reloadDocs, loadCollections, t]);

  /**
   * KBX-10 — the three retrieval selects derived `value` straight from
   * `selected.retrievalConfig` and only re-derived once `loadCollections`
   * re-read, so the control VISIBLY SNAPPED BACK to the previous option for the
   * duration of the PATCH and then changed again. `cfgPending` holds the
   * operator's choice until the authoritative list confirms it — and, since the
   * PATCH can fail, dropping the optimistic value in `finally` is what makes a
   * failed change revert honestly instead of persisting a lie.
   */
  const [cfgPending, setCfgPending] = useState<{ mode?: RetrievalMode; embedder?: EmbedderMode; enrichment?: EnrichmentMode }>({});
  // A different collection's config is not this one's optimistic value.
  useEffect(() => { setCfgPending({}); }, [selectedId]);

  const changeCfg = useCallback(async (
    patch: { mode?: RetrievalMode; embedder?: EmbedderMode; enrichment?: EnrichmentMode },
    apply: () => Promise<unknown>,
  ): Promise<void> => {
    if (!selected) return;
    const key = Object.keys(patch)[0] as 'mode' | 'embedder' | 'enrichment';
    setCfgPending((p) => ({ ...p, ...patch }));
    try {
      await apply();
      await loadCollections(orgId);
      toast.success(t('retrievalConfigSaved')); // KBX-11
    } catch (e) {
      toast.error(kbActionError(e, 'retrievalModeFailed'));
    } finally {
      setCfgPending((p) => { const n = { ...p }; delete n[key]; return n; });
    }
  }, [orgId, selected, loadCollections, t]);

  const changeEnrichment = useCallback((enrichment: EnrichmentMode) => (
    changeCfg({ enrichment }, () => setEnrichmentMode(orgId, selected!.collectionId, enrichment))
  ), [orgId, selected, changeCfg]);

  const changeRetrievalMode = useCallback((mode: RetrievalMode) => (
    changeCfg({ mode }, () => setRetrievalMode(orgId, selected!.collectionId, mode))
  ), [orgId, selected, changeCfg]);

  // ADR 0351 — the embedder knob (local hash vs BYOK provider embeddings).
  const changeEmbedder = useCallback((embedder: EmbedderMode) => (
    changeCfg({ embedder }, () => setEmbedderMode(orgId, selected!.collectionId, embedder))
  ), [orgId, selected, changeCfg]);

  const ingest = useCallback(async () => {
    if (!selected || !docText.trim()) return;
    setIngesting(true);
    try {
      await ingestText(orgId, selected.collectionId, docTitle.trim() || t('untitled'), docText.trim());
      setDocTitle(''); setDocText('');
      reloadDocs();
      void loadCollections(orgId);
      toast.success(t('documentAdded')); // KBX-11 — this path used to say nothing at all
    } catch (e) { toast.error(kbActionError(e, 'ingestFailed')); }
    finally { setIngesting(false); }
  }, [orgId, selected, docTitle, docText, reloadDocs, loadCollections, t]);

  // Upload a file (text/PDF/DOCX) — extracted to text server-side.
  const uploadFile = useCallback(async (file: File | undefined) => {
    if (!selected || !file) return;
    if (!withinUploadCap(file)) { toast.error(t('fileTooLarge', { max: MAX_UPLOAD_MB })); return; }
    setUploading(true);
    try {
      const contentBase64 = await fileToBase64(file);
      await ingestFile(orgId, selected.collectionId, { title: file.name, contentBase64, contentType: inferContentType(file) });
      reloadDocs();
      void loadCollections(orgId);
      toast.success(t('documentAdded'));
    } catch (e) { toast.error(kbActionError(e, 'ingestFailed')); }
    finally { setUploading(false); }
  }, [orgId, selected, reloadDocs, loadCollections, t]);

  const removeDoc = useCallback(async (documentId: string) => {
    if (!selected) return;
    if (!(await confirm({ title: t('deleteDocConfirm'), body: t('deleteDocBody'), danger: true, confirmLabel: t('common:delete') }))) return;
    try {
      await deleteDocument(orgId, selected.collectionId, documentId);
      if (selectedDocId === documentId) selectDoc('');
      reloadDocs();
      void loadCollections(orgId);
      setPendingFocus('documents'); // KBX-12
      toast.success(t('documentDeleted')); // KBX-11
    }
    catch (e) { toast.error(kbActionError(e, 'deleteFailed')); }
  }, [orgId, selected, selectedDocId, selectDoc, reloadDocs, loadCollections, t]);

  /**
   * KB-UX-1 — a failed search used to toast and RETURN, leaving `hits`
   * untouched: the previous query's results (or the confident "No matches")
   * stayed on screen, now labelled with the new question. The failure is a
   * STATE, not a toast — it persists, it is announced, and it carries its own
   * retry. `setSearchState` replaces the whole value on every transition, so
   * results and their query can never drift apart.
   *
   * KB-UX-9 — the OUTCOME is announced. The failure already was (the StateCard's
   * `announce`), but the two successful endings — N hits, and none — were
   * silent, so a screen-reader user pressed Search and heard nothing whichever
   * way it went.
   */
  const runSearch = useCallback(async () => {
    if (!selected || !query.trim()) return;
    const asked = query.trim();
    // Clear FIRST. A retry that leaves stale hits up while the request is in
    // flight re-renders the previous answer under the new question. `searching`
    // carries no hits, so this is the same clear the tests pin — with a state to
    // render instead of a blank region (KBX-8).
    setSearchState({ kind: 'searching', query: asked });
    try {
      const results = await search(orgId, selected.collectionId, asked);
      setSearchState({ kind: 'results', hits: results, query: asked });
      announce(results.length === 0 ? t('noMatches') : t('searchResultsAnnounce', { count: results.length }));
    } catch (e) {
      setSearchState({ kind: 'failed', message: e instanceof Error ? e.message : t('searchFailed'), query: asked });
    }
  }, [orgId, selected, query, t]);

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title={t('disabledTitle')} body={t('disabledBody')} />;
  }

  const orgPicker = orgs && orgs.length > 0 ? (
    <select value={orgId} onChange={(e) => selectOrg(e.target.value)} className="u-w-auto" aria-label={t('organizationLabel')}>
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : undefined;

  return (
    <div>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} actions={orgPicker} />

      {/* KB-UX-4 — the branch ORDER (failed → zero-orgs → children) is the
          shared component's, not this page's. Taking the layout as the CHILD is
          what makes it unskippable: the page cannot render the rail above the
          failure card, which is how the perpetual skeleton got here. */}
      <OrgSelectionState
        orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs} icon={<BoxesIcon />}
        emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')}
      >
        <div className="kbase-layout">
          {/* Collection list — rule 13 rail variant (the Forms precedent): a name
              filter once the UNFILTERED total passes ~3, compact inline zero-match
              with a ghost clear action (never a blank region). */}
          <div className="surface-card u-gap-2">
            <div className="u-flex u-items-center u-gap-2 u-flex-wrap">
              {/* `tabIndex={-1}` — the end of the KBX-12 focus chain for a
                  collection delete: mounted in every state of this rail. */}
              <h2 className="u-fs-16 u-m-0" ref={collectionsHeadingRef} tabIndex={-1}>{t('collectionsHeading')}</h2>
              {collections && collections.length > 3 ? (
                <input
                  type="search"
                  className="ui-input filterbar-search u-ml-auto"
                  placeholder={t('collectionFilterPlaceholder')}
                  aria-label={t('collectionFilterAria')}
                  value={collQuery}
                  onChange={(e) => setCollQuery(e.target.value)}
                />
              ) : null}
            </div>
            <DeepLinkMissNotice show={isDeepLinkMiss(selectedId, collections !== null, selected)} onClear={() => selectCollection('')} />
            {/* KB-UX-4 — failed ABOVE loading, and never collapsed into "no
                collections yet": that sentence is a claim about the org, and a
                read that failed knows nothing about the org. */}
            {collectionsFailed ? (
              <StateCard
                announce
                title={t('loadCollectionsFailed')}
                body={t('collectionsFailedBody')}
                action={<Button variant="secondary" onClick={() => void loadCollections(orgId)}>{t('common:retry')}</Button>}
              />
            ) : !collections ? <Skeleton /> : collections.length === 0 ? <span className="u-label-sm">{t('noCollections')}</span>
              : visibleCollections.length === 0 ? (
                <span className="u-flex u-items-center u-gap-2 u-label-sm">
                  {t('collectionNoMatch')}
                  <Button variant="quiet" size="sm" onClick={() => setCollQuery('')}>{t('clearCollectionSearch')}</Button>
                </span>
              ) : visibleCollections.map((c) => (
              /* §4.5 rule 12 — a rail cell is a real `<Link>`, not an `onClick`
                 button. The rail keeps its rule-11 exemption (no Grid⇄List
                 toggle in a 280px column) but NOT this: cmd-click, middle-click
                 and "copy link address" have to work here too, and they never
                 did while the cell was a button. `aria-current="true"` marks the
                 open one. Delete is NOT here — it lives on the collection's own
                 pane to the right (rule 12), where it can't be hit by a slip
                 aimed at the row you meant to open. */
              <div key={c.collectionId} className="u-flex u-gap-1 u-items-center">
                <Link
                  to={collectionHref(c.collectionId)}
                  replace
                  className={`${selectedId === c.collectionId ? 'btn-accent' : 'btn-ghost'} u-justify-start u-flex-1`}
                  aria-current={selectedId === c.collectionId ? 'true' : undefined}
                >
                  {c.name}
                </Link>
                {c.managed ? <span className="chip chip--muted" title={t('managedTitle', { source: t(`managedSource_${c.managed}`) })}><LockIcon size={12} /> {t('managedBadge')}</span> : null}
                <span className="chip" title={t('documentsTooltip')}>{formatNumber(c.documentCount)}<span className="sr-only"> {t('documentsTooltip')}</span></span>
              </div>
            ))}
            <div className="u-flex u-gap-1 u-mt-2">
              <input ref={newCollectionRef} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('newCollectionPlaceholder')} aria-label={t('newCollectionPlaceholder')} onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} />
              <Button variant="quiet" disabled={creating || !newName.trim()} aria-label={t('createCollection')} onClick={() => void create()}><PlusIcon /></Button>
            </div>
          </div>

          {/* Selected collection */}
          {!selected ? (
            <StateCard icon={<DatabaseIcon />} title={t('selectCollectionTitle')} body={t('selectCollectionBody')} />
          ) : (
            <div className="u-grid u-gap-4" data-walkthrough="kb.page">
              {/* The open collection's own header. Delete lives HERE (§4.5 rule
                  12), next to the thing it destroys and the name that says which
                  one — not on the rail cell, where it sat one slip away from the
                  row you meant to open. A managed collection is owned by its
                  source, so it is not deletable from here at all. */}
              <div className="u-flex u-items-center u-gap-2 u-wrap">
                <h2 className="u-fs-16 u-m-0 u-flex-1">{selected.name}</h2>
                {selected.managed ? null : (
                  <Button
                    variant="danger"
                    disabled={writesLocked}
                    title={lockReason}
                    onClick={() => void removeCollection(selected.collectionId, selected.name)}
                  >
                    <TrashIcon size={14} /> {t('deleteCollection')}
                  </Button>
                )}
              </div>

              {/* KBX-5 — ONE statement of the write lock, above everything it
                  disables. Without it the six controls below were enabled,
                  unexplained, and guaranteed to 409. `announce` because a
                  conditionally-mounted Notice speaks nothing on its own
                  (`ui/Notice.tsx`). */}
              {/* EXACTLY ONE of the three lock-related notices announces, and
                  which one depends on the job's status. `announce` delegates to
                  the single `GlobalLiveRegion`, whose polite slot holds ONE
                  string, so notices that fire on the same commit STOMP each
                  other and only the last is spoken — the trade-off
                  `KnowledgeSyncPanel` already records ("one disclosure that is
                  heard beats two that race", ADR 0605 R1). So: while the job is
                  `running` and advancing this notice speaks; once it is
                  `paused` or stalled it goes quiet and the panel's budget /
                  not-advancing Notice speaks instead, because the REASON is
                  then the more useful sentence. (`paused` and `stalled` are
                  mutually exclusive — `stalled` requires `running` — so the
                  three conditions partition, and exactly one fires.) The sync
                  notice below never announces: it is a detail of the same
                  fact, and a second string here would silence the first. */}
              {writesLocked ? (
                <Notice
                  variant="warning"
                  {...(reindex.job?.status === 'paused' || reindex.stalled ? {} : { announce: t('writesPausedAnnounce') })}
                >
                  {t('writesPausedNotice', { name: selected.name })}
                </Notice>
              ) : null}

              {/* Search */}
              <div className="surface-card u-gap-3">
                <h2 className="u-fs-16 u-m-0">{t('searchHeading', { name: selected.name })}</h2>
                <div className="u-flex u-gap-1">
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('searchPlaceholder')} aria-label={t('searchPlaceholder')} className="u-flex-1"
                    onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }} />
                  <Button variant="primary" disabled={searching || !query.trim()} onClick={() => void runSearch()}><SearchIcon /> {searching ? t('common:searching') : t('common:search')}</Button>
                </div>
                {/* ADR 0113 — retrieval-mode selector (hybrid lift + local rerank).
                    CS-UX-3: three sibling labels (one labelable control each) —
                    nesting all three selects in one <label> mis-associated them. */}
                {selected.managed ? null : (
                  <div className="u-flex u-items-center u-gap-2 u-wrap">
                    <label className="field u-flex u-items-center u-gap-2">
                      <span className="field-label u-m-0">{t('retrievalModeLabel')}</span>
                      <select
                        value={cfgPending.mode ?? selected.retrievalConfig?.mode ?? 'dense'}
                        onChange={(e) => void changeRetrievalMode(e.target.value as RetrievalMode)}
                        className="u-w-auto"
                        disabled={cfgPending.mode !== undefined}
                      >
                        <option value="dense">{t('retrievalModeDense')}</option>
                        <option value="hybrid">{t('retrievalModeHybrid')}</option>
                        <option value="hybrid+rerank">{t('retrievalModeRerank')}</option>
                      </select>
                    </label>
                    {/* ADR 0351 — embedder: local hash vs the tenant's provider
                        embeddings (degrades to lexical-only when unresolvable).
                        CS-UX-12: the hint rides a keyboard-discoverable InfoTip,
                        not an invisible title= attribute. */}
                    <label className="field u-flex u-items-center u-gap-2">
                      <span className="field-label u-m-0">{t('embedderLabel')}</span>
                      <select
                        value={cfgPending.embedder ?? selected.retrievalConfig?.embedder ?? 'local'}
                        onChange={(e) => void changeEmbedder(e.target.value as EmbedderMode)}
                        className="u-w-auto"
                        disabled={cfgPending.embedder !== undefined}
                      >
                        <option value="local">{t('embedderLocal')}</option>
                        <option value="provider">{t('embedderProvider')}</option>
                      </select>
                    </label>
                    <InfoTip label={t('embedderLabel')} text={t('embedderHint')} />
                    <label className="field u-flex u-items-center u-gap-2">
                      <span className="field-label u-m-0">{t('enrichmentLabel')}</span>
                      <select
                        value={cfgPending.enrichment ?? selected.retrievalConfig?.enrichment ?? 'off'}
                        onChange={(e) => void changeEnrichment(e.target.value as EnrichmentMode)}
                        className="u-w-auto"
                        disabled={cfgPending.enrichment !== undefined}
                      >
                        <option value="off">{t('enrichmentOff')}</option>
                        <option value="heading-path">{t('enrichmentHeadingPath')}</option>
                      </select>
                    </label>
                    <InfoTip label={t('enrichmentLabel')} text={t('enrichmentHint')} />
                  </div>
                )}
                {/* KB-UX-1 — the states, in the order that keeps each honest.
                    `noMatches` is now reachable ONLY from a RESOLVED empty
                    response; it used to be reachable from a failed one too,
                    because the failure never cleared `hits`. */}
                <div aria-busy={searching || undefined}>
                  {searchState.kind === 'failed' ? (
                    <StateCard
                      announce
                      icon={<SearchIcon />}
                      title={t('searchFailedTitle')}
                      body={t('searchFailedBody', { query: searchState.query })}
                      action={<Button variant="primary" onClick={() => void runSearch()}>{t('common:retry')}</Button>}
                    />
                  ) : searchState.kind === 'idle' ? null : searchState.kind === 'searching' ? (
                    /* KBX-8 — the results region no longer empties on a
                       re-search. It says WHICH question is in flight, so the
                       frame is legible rather than merely non-false. */
                    <div className="u-grid u-gap-2">
                      <span className="u-label-sm muted">{t('searchInFlight', { query: searchState.query })}</span>
                      <Skeleton />
                    </div>
                  ) : searchState.hits.length === 0 ? (
                    <span className="u-label-sm">{t('noMatches')}</span>
                  ) : (
                    <div className="u-grid u-gap-2">
                      {searchState.hits.map((h) => (
                        <div key={h.chunkId} className="surface-inset kbase-hit">
                          <div className="u-flex u-gap-2 u-items-center">
                            <strong className="kbase-hit-title">{h.title}</strong>
                            {/* KB-UX-14 — `h.score ?? 0` rendered an ABSENT score
                                as a confident `0.000`, i.e. "we scored this and it
                                matched nothing". An em-dash says what is true. */}
                            {typeof h.score === 'number' ? (
                              <span className="chip" title={t('cosineScoreTooltip')}>{formatNumber(h.score, { minimumFractionDigits: 3, maximumFractionDigits: 3 })}</span>
                            ) : (
                              <span className="chip chip--muted" title={t('scoreUnavailableTooltip')}>—<span className="sr-only"> {t('scoreUnavailableTooltip')}</span></span>
                            )}
                          </div>
                          <span className="kbase-hit-text">{h.text}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Ingest — suppressed for an auto-managed collection (content is synced) */}
              {selected.managed ? (
                <Notice variant="info">{t('managedNotice', { source: t(`managedSource_${selected.managed}`) })}</Notice>
              ) : (
                <div className="surface-card u-gap-2" aria-busy={ingesting || uploading || addingUrl || importingMedia || undefined}>
                  <h2 className="u-fs-16 u-m-0">{t('addDocumentHeading')}</h2>
                  <input value={docTitle} onChange={(e) => setDocTitle(e.target.value)} placeholder={t('titlePlaceholder')} aria-label={t('titlePlaceholder')} disabled={writesLocked} />
                  <textarea value={docText} onChange={(e) => setDocText(e.target.value)} placeholder={t('ingestPlaceholder')} aria-label={t('ingestPlaceholder')} rows={5} disabled={writesLocked} />
                  <div className="u-flex u-justify-end">
                    <Button variant="primary" disabled={ingesting || writesLocked || !docText.trim()} title={lockReason} onClick={() => void ingest()}><PlusIcon /> {ingesting ? t('ingesting') : t('ingest')}</Button>
                  </div>
                  <label className="field">
                    <span className="field-label"><PaperclipIcon size={14} /> {t('uploadFileLabel')}</span>
                    <input type="file" accept={KB_UPLOAD_ACCEPT} disabled={uploading || writesLocked}
                      onChange={(e) => { void uploadFile(e.target.files?.[0]); e.target.value = ''; }} />
                    <span className="field-help">{uploading ? t('uploading') : writesLocked ? t('writesPausedShort') : t('uploadFileHint')}</span>
                  </label>
                  {/* ADR 0351 P4 — add a web page by URL (server-side fetch, untrusted-fenced). */}
                  <label className="field">
                    <span className="field-label">{t('urlLabel')}</span>
                    <div className="u-flex u-gap-2">
                      <input type="url" value={docUrl} onChange={(e) => setDocUrl(e.target.value)} placeholder={t('urlPlaceholder')} aria-label={t('urlLabel')} className="u-flex-1" disabled={writesLocked}
                        onKeyDown={(e) => { if (e.key === 'Enter') void ingestFromUrl(); }} />
                      <Button variant="primary" disabled={addingUrl || writesLocked || !docUrl.trim()} title={lockReason} onClick={() => void ingestFromUrl()}><PlusIcon /> {addingUrl ? t('common:saving') : t('addUrl')}</Button>
                    </div>
                    <span className="field-help">{t('urlHint')}</span>
                  </label>
                  {/* ADR 0398 P2 — bulk-ingest a media collection's extractable files. */}
                  {mediaFailed ? (
                    <p className="u-label-sm muted u-m-0">{t('mediaCollectionsFailed')}</p>
                  ) : null}
                  {mediaCollections && mediaCollections.length > 0 && (
                    <label className="field">
                      <span className="field-label">{t('mediaCollectionLabel')}</span>
                      <div className="u-flex u-gap-2">
                        <select value={mediaCollectionId} onChange={(e) => setMediaCollectionId(e.target.value)} aria-label={t('mediaCollectionLabel')} className="u-flex-1" disabled={importingMedia || writesLocked}>
                          <option value="">{t('mediaCollectionPlaceholder')}</option>
                          {mediaCollections.map((mc) => <option key={mc.collectionId} value={mc.collectionId}>{mc.name}</option>)}
                        </select>
                        <Button variant="primary" disabled={importingMedia || writesLocked || !mediaCollectionId} title={lockReason} onClick={() => void ingestFromMediaCollection()}><PlusIcon /> {importingMedia ? t('common:saving') : t('addMediaCollection')}</Button>
                      </div>
                      <span className="field-help">{t('mediaCollectionHint')}</span>
                    </label>
                  )}
                </div>
              )}

              {/* Documents — the §4.5 grid/list collection-view canon (rule 11) */}
              <div className="u-grid u-gap-2">
                <h2 className="u-fs-16 u-m-0" ref={docsHeadingRef} tabIndex={-1}>{t('documentsHeading')}</h2>
                {/* KB-UX-4 — failed above loading above empty. "No documents
                    yet" is a claim about the collection; a failed read has not
                    earned it. */}
                {docsFailed ? (
                  <StateCard
                    announce
                    icon={<FileTextIcon size={20} />}
                    title={t('loadDocumentsFailed')}
                    body={t('documentsFailedBody')}
                    action={<Button variant="secondary" onClick={reloadDocs}>{t('common:retry')}</Button>}
                  />
                ) : !docs ? (
                  <Skeleton />
                ) : docs.length === 0 ? (
                  <StateCard icon={<FileTextIcon size={20} />} title={t('noDocumentsTitle')} body={t('noDocuments')} />
                ) : selectedDoc ? (
                  <div className="u-grid u-gap-2">
                    {/* KBX-12 — closing the reader unmounts this very button, so
                        the close claims a focus target for the effect above. */}
                    <button type="button" className="inline-link u-fs-13 u-justify-start" onClick={() => { selectDoc(''); setPendingFocus('documents'); }}><ArrowLeftIcon size={13} aria-hidden /> {t('backToDocuments')}</button>
                    <div className="u-flex u-items-center u-gap-2 u-wrap">
                      <FileTextIcon size={18} aria-hidden />
                      <strong className="u-fs-15">{selectedDoc.title}</strong>
                      <span className="chip chip--muted">{t(`docSource_${selectedDoc.source.kind}`)}</span>
                    </div>
                    {/* Plain-text child — React auto-escapes; KB content can be fenced-untrusted (ADR 0336, no innerHTML). */}
                    {docError ? (
                      <StateCard announce title={t('loadDocumentsFailed')} action={<Button variant="primary" onClick={() => setDocReloadKey((k) => k + 1)}>{t('common:retry')}</Button>} />
                    ) : docLoading || !docContent ? <Skeleton /> : <DocReader key={selectedDocId} text={docContent.text} />}
                  </div>
                ) : (
                  <>
                    <div className="filterbar" role="group" aria-label={t('docFilterGroup')}>
                      {docs.length > 3 ? (
                        <input
                          ref={docFilterRef}
                          type="search"
                          className="ui-input filterbar-search"
                          placeholder={t('docFilterPlaceholder')}
                          aria-label={t('docFilterAria')}
                          value={docQuery}
                          onChange={(e) => setDocQuery(e.target.value)}
                        />
                      ) : null}
                      <ViewToggle value={viewMode} onChange={setViewMode} className="u-ml-auto" />
                    </div>

                    {visibleDocs.length === 0 ? (
                      <StateCard
                        icon={<FileTextIcon size={20} />}
                        title={t('docNoMatchTitle')}
                        body={t('docNoMatchBody')}
                        action={<Button variant="secondary" onClick={() => setDocQuery('')}>{t('clearDocSearch')}</Button>}
                      />
                    ) : viewMode === 'grid' ? (
                      <div className="card-grid">
                        {visibleDocs.map((d) => (
                          <DocumentCard key={d.documentId} document={d} onRemove={(id) => void removeDoc(id)} onOpen={selectDoc} canRemove={!selected.managed} removeDisabledReason={lockReason} />
                        ))}
                      </div>
                    ) : (
                      <div className="surface-card list-view">
                        {visibleDocs.map((d) => (
                          <DocumentRow key={d.documentId} document={d} onRemove={(id) => void removeDoc(id)} onOpen={selectDoc} canRemove={!selected.managed} removeDisabledReason={lockReason} />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* KBX-13 — the reindex gets its own section, BELOW the documents
                  it rebuilds, instead of being the fourth item of the
                  retrieval-mode row inside the card headed "Search “{name}”". A
                  minutes-long, collection-wide, write-blocking rebuild is not the
                  same class of control as the three cosmetic dropdowns it used to
                  sit beside, and at ≤760px it wrapped under them with no
                  separator saying otherwise. */}
              {selected.managed ? null : (
                <ReindexPanel
                  reindex={reindex}
                  orgId={orgId}
                  collectionId={selected.collectionId}
                  collectionName={selected.name}
                  currentProvider={selected.embeddingSpec?.provider ?? (selected.retrievalConfig?.embedder === 'provider' ? 'provider-default' : 'local')}
                />
              )}

              {/* ADR 0107 — Drive sync sources (self-hides when the toggle is off).
                  KBX-5 / CT-KBX-3 — the sync runner writes through the same two
                  functions the lock guards, so a "Sync now" during a reindex fails
                  with what reads as a Drive/credential problem. Say so first. */}
              {writesLocked ? (
                <Notice variant="warning">{t('syncPausedNotice')}</Notice>
              ) : null}
              <KnowledgeSyncPanel orgId={orgId} collectionId={selected.collectionId} />
            </div>
          )}
        </div>
      </OrgSelectionState>
    </div>
  );
}

/** ADR 0398 P3 — pin the collection's embedding model + drive a versioned, budgeted reindex.
 *  The old embedding space keeps serving until the new one is fully built (cutover).
 *
 *  KB-UX-2 — `runToCompletion` returns on ANY non-`running` status, and `start`
 *  then fired `toast.success('Reindex complete')` unconditionally. So `failed`,
 *  `cancelled` AND `paused` all reported success, and `reindexFailed` was
 *  unreachable from a job that reports failure (it could only ever fire on a
 *  THROWN request). The drain now returns its terminal job and the caller
 *  branches on it, so the only path to "complete" is `status === 'done'`.
 *
 *  KB-UX-10 — one `busy` flag was held across the whole drain loop, which
 *  disabled Cancel for the entire job: the control existed and could never be
 *  used on a long reindex, which is the only kind anyone wants to cancel. It is
 *  split into `starting` (the POST) and `draining` (the loop); Cancel is live
 *  throughout the drain, and the loop stops as soon as the job leaves `running`.
 *  `resume` also had no `.catch`, so a mid-resume failure was silent.
 *
 *  KBX-2 — Resume was rendered ONLY for `paused`, although `resume()` does
 *  nothing status-specific: it just re-enters the drain. A job stranded in
 *  `running` by a closed tab therefore offered exactly one control, Cancel,
 *  which discards the entire staged rebuild — so the in-product exit from "every
 *  write to this collection 409s" was "throw the work away and start over", and
 *  the non-destructive exit was implemented and unreachable. Both statuses now
 *  render it, with copy that distinguishes continuing a stalled rebuild from
 *  resuming a budget-paused one.
 *
 *  KBX-3 — nothing polled and `updatedAt` was rendered nowhere, so the screen
 *  for a healthy in-flight reindex and the screen for one abandoned three days
 *  ago were pixel-identical: a determinate bar parked at the last drain's count,
 *  a percentage, a token-spend line, none of it labelled last-known. The stamp
 *  and the not-advancing state are `DESIGN.md` §4.6's `stale` row. */
function ReindexPanel({ reindex, orgId, collectionId, collectionName, currentProvider }: {
  reindex: ReindexController;
  orgId: string;
  collectionId: string;
  collectionName: string;
  currentProvider: string;
}): JSX.Element {
  const { t } = useTranslation('kb');
  const [provider, setProvider] = useState<EmbeddingProvider>('local');
  const [starting, setStarting] = useState(false);
  const { job, setJob, draining, setDraining } = reindex;

  /** Drain until the job leaves `running`, and RETURN the terminal job so the
   *  caller can tell `done` from `failed`/`cancelled`/`paused`. Returning void
   *  is what made every outcome look like success. */
  const runToCompletion = useCallback(async (): Promise<ReindexJob | null> => {
    let last: ReindexJob | null = null;
    for (let i = 0; i < 10000; i++) {
      const next = await drainReindex(orgId, collectionId);
      setJob(next);
      last = next;
      if (next.status !== 'running') return next;
    }
    return last;
  }, [orgId, collectionId, setJob]);

  /** The ONE place a terminal reindex status becomes a message. */
  const reportTerminal = useCallback((terminal: ReindexJob | null): void => {
    if (terminal?.status === 'done') { toast.success(t('reindexDone')); return; }
    if (terminal?.status === 'cancelled') { toast.info(t('reindexCancelled')); return; }
    // KBX-6 — `paused` is still not toasted, but the reason is now true: the
    // Notice below carries `announce`, so it is actually spoken. Before, this
    // early return cited a Notice that announced nothing, and a screen-reader
    // user driving a reindex into the daily embedding budget received NOTHING:
    // no toast (suppressed here), no announcement, no focus change.
    if (terminal?.status === 'paused') return;
    // `failed`, or a drain that never terminated within the loop bound.
    toast.error(terminal?.error ? t('reindexFailedWithReason', { reason: terminal.error }) : t('reindexFailed'));
  }, [t]);

  /**
   * KBX-1 — the pre-start gate.
   *
   * `start` used to fire on the first click with no confirm, no notice and no
   * disclosure of any kind, while the field-help below promised the rebuild ran
   * "in the background". Both the cost (every write to this collection is
   * refused until it finishes) and the duration were invisible until the bar
   * appeared. The two genuinely destructive actions on this page both gate; this
   * one, whose cost is the least visible, did not.
   */
  const start = useCallback(async () => {
    if (!(await confirm({
      title: t('reindexStartConfirm', { name: collectionName }),
      body: t('reindexStartBody'),
      confirmLabel: t('reindexStartAction'),
    }))) return;
    setStarting(true);
    let started: ReindexJob;
    try {
      started = await startReindex(orgId, collectionId, { provider });
      setJob(started);
    } catch (e) {
      toast.error(kbActionError(e, 'reindexFailed'));
      setStarting(false);
      return;
    }
    setStarting(false);
    setDraining(true);
    try { reportTerminal(await runToCompletion()); }
    catch (e) { toast.error(kbActionError(e, 'reindexFailed')); }
    finally { setDraining(false); }
  }, [orgId, collectionId, collectionName, provider, runToCompletion, reportTerminal, setJob, setDraining, t]);

  const resume = useCallback(async () => {
    setDraining(true);
    try { reportTerminal(await runToCompletion()); }
    catch (e) { toast.error(kbActionError(e, 'reindexFailed')); }
    finally { setDraining(false); }
  }, [runToCompletion, reportTerminal, setDraining]);

  /** KBX-7 — confirmed, and named for what it destroys. `reindexCancel` used to
   *  read "Cancel" beside a progress bar, which does not distinguish "stop the
   *  job" from "dismiss this panel", and it fired unguarded although it discards
   *  the entire staged rebuild. */
  const cancel = useCallback(async () => {
    if (!(await confirm({
      title: t('reindexCancelConfirm'),
      body: t('reindexCancelBody'),
      danger: true,
      confirmLabel: t('reindexCancel'),
    }))) return;
    try { setJob(await cancelReindex(orgId, collectionId)); }
    catch (e) { toast.error(kbActionError(e, 'reindexCancelFailed')); }
  }, [orgId, collectionId, setJob, t]);

  const busy = starting || draining;
  const active = job && (job.status === 'running' || job.status === 'paused' || job.status === 'cutting-over');
  const pct = job && job.totalChunks > 0 ? Math.round((job.embeddedChunks / job.totalChunks) * 100) : 0;
  const progressLabel = job ? t('reindexProgress', { pct, done: formatNumber(job.embeddedChunks), total: formatNumber(job.totalChunks) }) : '';

  return (
    <div className="surface-card u-gap-2">
      <div className="u-flex u-items-center u-gap-2 u-wrap">
        <h2 className="u-fs-16 u-m-0 u-flex-1">{t('reindexHeading')}</h2>
        {active ? (
          <Button variant="quiet" size="sm" disabled={reindex.refreshing} onClick={() => reindex.refresh()}>
            <RotateCwIcon size={13} aria-hidden /> {t('reindexRefresh')}
          </Button>
        ) : null}
      </div>

      {/* KB-UX-11 — the mount read's failure used to be swallowed by
          `.catch(() => {})`, so a collection with a LIVE job rendered the idle
          Start form: the operator was invited to start a second rebuild of a
          collection that was already locked. */}
      {reindex.jobReadFailed ? (
        <Notice variant="error" announce={t('reindexJobReadFailed')}>
          {t('reindexJobReadFailed')}{' '}
          <Button variant="quiet" size="sm" onClick={() => reindex.refresh()}>{t('common:retry')}</Button>
        </Notice>
      ) : null}

      <div className="field u-flex u-flex-col u-gap-1">
        <span className="field-label u-m-0">{t('reindexLabel')}</span>
        {active ? (
          <div className="u-flex u-flex-col u-gap-1">
            <div className="u-flex u-items-center u-gap-2 u-fs-12">
              {/* KBX-14 — `.kbase-progress` gives the UA bar the app's own accent
                  instead of the platform default. (The `KB-UX-18` light/dark
                  claim was corrected: `color-scheme` already makes the UA paint
                  dark chrome, so what was missing is brand fidelity, not parity.) */}
              <progress className="u-flex-1 kbase-progress" value={job!.embeddedChunks} max={job!.totalChunks} aria-label={progressLabel} />
              <span className="muted">{progressLabel}</span>
            </div>
            {job!.costSpentTokens > 0 && <span className="muted u-fs-11">{t('reindexCost', { tokens: formatNumber(job!.costSpentTokens) })}</span>}
            {/* KBX-3 — the §4.6 `stale` row: say the data is last-known, and
                when. Rendered for every live job, not only a stalled one,
                because "when did this last move?" is the question the bar
                cannot answer. */}
            <span className="muted u-fs-11" title={formatDateTime(job!.updatedAt)}>
              {t('reindexUpdatedAt', { when: formatRelativeTime(job!.updatedAt) })}
            </span>
            {job!.status === 'paused' && (
              <Notice variant="warning" announce={t('reindexPausedAnnounce')}>{job!.error ?? t('reindexPaused')}</Notice>
            )}
            {/* KBX-3 — the state that did not exist: a job that is not
                advancing. The copy is written for ADR 0643's end state (D1b: a
                scheduler drains it without a browser; D1a: a `running` job whose
                lease goes unrenewed is cancelled and its staging vectors
                dropped), so it tells the operator what will happen if they do
                nothing as well as what they can do now. */}
            {reindex.stalled && (
              <Notice variant="warning" announce={t('reindexStalledAnnounce')}>{t('reindexStalled')}</Notice>
            )}
            <div className="u-flex u-gap-2 u-wrap">
              {/* KBX-2 — rendered for `running` as well as `paused`. `resume()`
                  is status-agnostic; only this condition was not. */}
              <Button variant="primary" className="u-fs-12" disabled={busy} onClick={() => void resume()}>
                {job!.status === 'paused' ? t('reindexResume') : t('reindexContinue')}
              </Button>
              {/* KB-UX-10 — NOT `disabled={busy}`. Cancel was dead for the whole
                  drain, i.e. exactly when a user wants it. */}
              <Button variant="secondary" className="u-fs-12" onClick={() => void cancel()}>{t('reindexCancel')}</Button>
            </div>
          </div>
        ) : (
          <div className="u-flex u-items-center u-gap-2 u-wrap">
            <select value={provider} onChange={(e) => setProvider(e.target.value as EmbeddingProvider)} className="u-w-auto" disabled={busy} aria-label={t('reindexLabel')}>
              <option value="local">{t('reindexProviderLocal')}</option>
              <option value="openai">OpenAI</option>
              <option value="google">Google</option>
              <option value="cohere">Cohere</option>
            </select>
            <Button variant="primary" className="u-fs-12" disabled={busy} onClick={() => void start()}>{t('reindexStart')}</Button>
          </div>
        )}
        <span className="field-help">{t('reindexHint', { current: currentProvider })}</span>
      </div>
    </div>
  );
}
