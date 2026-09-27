/**
 * Research Notebooks page (ADR 0084). A notebook chooser (list + create) and,
 * for the selected notebook, a three-panel workspace:
 *   - Sources : the notebook's KB documents + an "add text source" form.
 *   - Notes   : curated subject-memory notes + an add-note form.
 *   - Ask     : a grounded RAG "Ask" box over the notebook's collection
 *               (hits + citations, with "save answer to notes"), plus a launch
 *               panel that deep-links into the main /chat surface — the notebook's
 *               project group conversation, grounded server-side in its sources
 *               (ADR 0084 Phase 2). No second chat system.
 *
 * Gating mirrors every feature page: hidden in nav when off, a disabled state on
 * the page when the toggle is off, the full UI when on. Drives notebooksClient,
 * which wraps the host-extension routes 1:1.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { TextField, TextareaField } from '../../ui/Field.js';
import { toast } from '../../ui/toast.js';
import { announce } from '../../ui/announce.js';
import { formatNumber, formatRelativeTime } from '../../i18n/format.js';
import {
  PlusIcon, FileTextIcon, ClipboardIcon, SearchIcon, MessageSquareIcon, SparklesIcon, ZapIcon, ArrowRightIcon,
  MicIcon, LinkIcon, PaperclipIcon,
} from '../../ui/icons/index.js';
import { fileToBase64, inferContentType, KB_UPLOAD_ACCEPT, withinUploadCap, MAX_UPLOAD_MB } from '../../client/fileToBase64.js';
import {
  ensureNotebook,
  listSources, addSource, addFileSource, addAudioSource, addYoutubeSource, setSourceContextLevel, summarizeSource, listNotes, addNote, searchNotebook, ensureNotebookChat,
  type NoteContentOrigin,
  listTransformationTemplates, applyTransformation, listTransformations,
  type Notebook, type NotebookSource, type NotebookNote, type NotebookSearchResult, type SourceContextLevel,
  type TransformationTemplate, type Transformation,
} from './notebooksClient.js';

/** Approximate tokens for a source. Heuristic: ~250 tokens per KB chunk (the KB
 *  chunker targets ~1k chars/chunk; ~4 chars per token ⇒ ~250 tokens/chunk). This
 *  is a UI affordance (a rough "context budget" indicator), not an exact count. */
const TOKENS_PER_CHUNK = 250;
const sourceTokens = (s: NotebookSource): number => s.chunkCount * TOKENS_PER_CHUNK;
/** Locale-aware compact token count (e.g. `1.5K` en / `1,5 mil` pt-BR) via the
 *  shared formatter (ADR 0065 — no hand-rolled toFixed in UI code). */
const formatTokens = (n: number): string => formatNumber(n, { notation: 'compact', maximumFractionDigits: 1 });

/** NBU-19 — the three list panels that own a retry (see `retryLoad`). */
type LoadPanel = 'sources' | 'notes' | 'transformations';

/** ADR 0602 / NBU-6 — the three async runs whose poll can give up before a result
 *  lands. Named rather than boolean-per-poller so all three share one rule. */
type StallKind = 'ingest' | 'summarize' | 'transform';

/**
 * WHAT was being waited on, as DATA rather than as a closure.
 *
 * ── ADR 0602 § Correction log, item E (`M2`/`M3`) ────────────────────────────
 *
 * The first cut stored the poller's live `landed` closure. Two defects followed
 * from that one choice:
 *
 *   M2 — the ingest and transform predicates were `list.length > baseline`, a
 *        COUNT, which is wrong in both directions: an unrelated arrival cleared
 *        the card while the awaited item was still absent, and a concurrent
 *        DELETE + ADD left the count equal so the card outlived its own arrival.
 *        `summarize` was already correct because it NAMES its subject; the
 *        identity test is now what all three use.
 *        HONEST LIMIT, not claimed closed: the ingest/transform APIs return only
 *        `{ runId }`, never the document id they will mint, so "a source that
 *        was not here before" is the strongest subject the client can express. A
 *        source added by a PEER in the same window still satisfies it. Closing
 *        that needs a server-side correlation handle (the run id appearing on
 *        the source/transformation projection) — recorded in ADR 0602
 *        § Residuals, not papered over here.
 *
 *   M3 — a closure cannot survive the component. `ProjectDetailPage` mounts the
 *        panel CONDITIONALLY (`tab === 'sources' ? <ProjectSourcesPanel/> : …`),
 *        so ONE tab switch destroyed `stalled` — and the surface fell straight
 *        back to "No sources yet", the exact positive claim the give-up exists
 *        to suppress, via the navigation a waiting user is most likely to make.
 *        A descriptor is re-derivable, so it can live in a `notebookId`-keyed
 *        store outside the component and rebuild its predicate on remount.
 *
 * Storing a closure would also have leaked: `landed` captures the previous
 * mount's `setSources`, which a later mount must never call.
 */
type StallSubject =
  /** A source that is not one of the ids present when the upload started. */
  | { kind: 'ingest'; baselineSourceIds: readonly string[] }
  /** THIS source reporting `hasSummary`. */
  | { kind: 'summarize'; sourceId: string }
  /** A transformation that is not one of the ids present when it was applied. */
  | { kind: 'transform'; baselineTransformationIds: readonly string[] };

/** A stated give-up + how many rechecks came back empty (what makes a repeat
 *  click observable, NBU-19) + whether the LAST recheck could not be performed
 *  at all — which is not the same claim and must not be counted as one (`M1`) +
 *  the RUN the user is waiting on.
 *
 *  `H4` — `NBU-6` was filed with a two-part cure: honest give-up copy AND "bind
 *  the returned `runId` and link the run". Only the copy shipped. All four
 *  ingest/summarize/transform clients return `{ runId }` and all four call sites
 *  threw it away with a bare `await`, so the give-up card was a dead end: the
 *  one artifact that could say WHY nothing arrived was discarded at the moment
 *  it was created. The card is exactly where a `/runs/:id` link belongs. */
interface StallState { subject: StallSubject; rechecks: number; lastRecheckFailed: boolean; runId?: string }

/**
 * Give-ups outlive the component that raised them, keyed by notebook.
 *
 * Module scope, not React state: the panel is conditionally mounted inside a tab
 * (see `M3` above), so anything held in `useState` is destroyed by a tab switch.
 * Keyed by notebook id so two notebooks cannot inherit each other's give-ups.
 * Entries are removed when their subject arrives — the store never grows without
 * bound in a session, and it is deliberately NOT persisted: a give-up is about
 * one page's worth of waiting, not a durable claim.
 */
const stallStore = new Map<string, Map<StallKind, StallState>>();
/** Test-only: drop every standing give-up. The store deliberately OUTLIVES the
 *  component (that is the point of `M3`), so a test that mounts the same notebook
 *  twice would otherwise inherit the previous test's card — and its CONTROL
 *  assertions would fail for a reason that has nothing to do with the control. */
export function __clearNotebookStalls(): void { stallStore.clear(); }
const readStalls = (notebookId: string): ReadonlyMap<StallKind, StallState> => stallStore.get(notebookId) ?? new Map();
const writeStalls = (notebookId: string, next: ReadonlyMap<StallKind, StallState>): void => {
  if (next.size === 0) stallStore.delete(notebookId);
  else stallStore.set(notebookId, new Map(next));
};

/**
 * Is the thing this give-up was waiting for now present? A PURE function of the
 * lists already in hand, so it can be re-evaluated after ANY refresh — which is
 * what stops the card outliving its own arrival (`M3a`: the source rendered in
 * the list BELOW a card still saying "Still waiting for that source").
 *
 * `null` lists mean "not read yet", which is not evidence of arrival.
 */
function stallSatisfied(
  subject: StallSubject,
  sources: readonly NotebookSource[] | null,
  transformations: readonly Transformation[] | null,
): boolean {
  if (subject.kind === 'ingest') {
    if (!sources) return false;
    const seen = new Set(subject.baselineSourceIds);
    return sources.some((s) => !seen.has(s.documentId));
  }
  if (subject.kind === 'summarize') {
    if (!sources) return false;
    return sources.find((s) => s.documentId === subject.sourceId)?.hasSummary === true;
  }
  if (!transformations) return false;
  const seen = new Set(subject.baselineTransformationIds);
  return transformations.some((tr) => !seen.has(tr.documentId));
}

/** `M4` — which give-ups belong to which panel, stated ONCE. The suppression
 *  rule ("a panel showing a give-up must not also claim to be empty") was
 *  hand-written per panel and one of the two forgot a kind: the Sources panel
 *  checked only `ingest`, so a SUMMARIZE stall rendered beside "No sources yet".
 *  A rule that has to be remembered per call site is a rule that will be
 *  forgotten at one of them. */
const PANEL_STALL_KINDS: Record<'sources' | 'transformations', readonly StallKind[]> = {
  sources: ['ingest', 'summarize'],
  transformations: ['transform'],
};

function NotebookWorkspace({ notebook }: { notebook: Notebook }): JSX.Element {
  const { t } = useTranslation('notebooks');
  const navigate = useNavigate();
  const [chatBusy, setChatBusy] = useState(false);
  const [sources, setSources] = useState<NotebookSource[] | null>(null);
  const [notes, setNotes] = useState<NotebookNote[] | null>(null);
  // NBU-2 / ADR 0601 — failure state is PER PANEL, not one shared string.
  // Three independent loaders used to write ONE `error` and never touch their
  // list, so `null` (the LOADING sentinel) survived a failure and the panel
  // shimmered forever with no retry. Worse, the shared string was cleared in
  // exactly one place — `ask()` — so an unrelated successful search wiped the
  // banner while all three skeletons were still spinning, turning an honest
  // failure into a calm-looking permanent load. Each panel now owns its own
  // failure and clears it on its own successful reload.
  //
  // This is the shape `templatesFailed` (below) already got right in this file.
  const [sourcesFailed, setSourcesFailed] = useState<string | null>(null);
  const [notesFailed, setNotesFailed] = useState<string | null>(null);
  const [transformationsFailed, setTransformationsFailed] = useState<string | null>(null);
  // NBU-19 — which panel's RETRY is in flight (see `retryLoad`).
  const [retrying, setRetrying] = useState<ReadonlySet<LoadPanel>>(() => new Set());
  // NBU-5 — the Ask panel's own failure, so a failed search states itself in
  // place instead of relying on a toast that vanishes in six seconds.
  const [askFailed, setAskFailed] = useState<string | null>(null);

  // Add-source form
  const [srcTitle, setSrcTitle] = useState('');
  const [srcText, setSrcText] = useState('');
  const [srcBusy, setSrcBusy] = useState(false);

  // Audio/video + YouTube sources (ADR 0085) — both enqueue async ingest runs.
  const [ytUrl, setYtUrl] = useState('');
  const [audioBusy, setAudioBusy] = useState(false);
  const [ytBusy, setYtBusy] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);

  // Add-note form
  const [noteText, setNoteText] = useState('');
  const [noteBusy, setNoteBusy] = useState(false);

  // Ask box
  const [query, setQuery] = useState('');
  const [askBusy, setAskBusy] = useState(false);
  const [answer, setAnswer] = useState<NotebookSearchResult | null>(null);

  // Transformations (ADR 0084 T2) — the catalog (per-source Transform menu) + the
  // result Documents (read-only, owned by the notebook subject in Documents).
  const [templates, setTemplates] = useState<TransformationTemplate[]>([]);
  const [templatesFailed, setTemplatesFailed] = useState(false);
  const [transformations, setTransformations] = useState<Transformation[] | null>(null);
  // Sources mid-transform (the run is async — show pending until a new artifact
  // lands). Keyed by documentId.
  const [transforming, setTransforming] = useState<Set<string>>(new Set());

  const msgOf = useCallback((err: unknown): string => (err instanceof Error ? err.message : t('loadFailed')), [t]);
  // The loaders RETURN their promise (they used to swallow it with `void`), which
  // is what makes `retryLoad` below able to know when a retry finished — see
  // NBU-19.
  const loadSources = useCallback((): Promise<void> => listSources(notebook.id)
    .then((next) => { setSources(next); setSourcesFailed(null); })
    .catch((err) => setSourcesFailed(msgOf(err))), [notebook.id, msgOf]);
  const loadNotes = useCallback((): Promise<void> => listNotes(notebook.id)
    .then((next) => { setNotes(next); setNotesFailed(null); })
    .catch((err) => setNotesFailed(msgOf(err))), [notebook.id, msgOf]);
  const loadTransformations = useCallback((): Promise<void> => listTransformations(notebook.id)
    .then((next) => { setTransformations(next); setTransformationsFailed(null); })
    .catch((err) => setTransformationsFailed(msgOf(err))), [notebook.id, msgOf]);

  /**
   * NBU-19 (ADR 0601 § Corrections / LOW-10) — a retry that gives feedback.
   *
   * The three panel retries were `onClick={loadSources}` with no `disabled` and
   * no busy state, and `loadSources` was fire-and-forget. On a REPEAT failure
   * that is a button that does nothing observable: the StateCard never unmounts,
   * its announce effect is keyed `[announce, title]` with a CONSTANT title so the
   * live region re-announces nothing, and the screen is byte-identical before and
   * after. A user cannot tell a retry that ran and failed from a click that
   * missed. Double-clicking fired concurrent loads whose responses could land out
   * of order.
   *
   * ONE rule, not three copies (the Ask retry at the bottom of this file already
   * modelled it with `disabled={askBusy}`): `loading` on `Button` sets `aria-busy`
   * AND disables, so the state is announced to assistive tech and the second
   * click is impossible.
   */
  const retryLoad = useCallback(async (panel: LoadPanel, load: () => Promise<void>): Promise<void> => {
    setRetrying((prev) => { const next = new Set(prev); next.add(panel); return next; });
    try { await load(); }
    finally { setRetrying((prev) => { const next = new Set(prev); next.delete(panel); return next; }); }
  }, []);

  useEffect(() => {
    void loadSources();
    void loadNotes();
    void loadTransformations();
    // Best-effort, but not silent: `templates.length > 0` GATES the Transform
    // control, so a failed catalog read used to make the affordance disappear
    // with no way to tell that from "this notebook has no templates".
    void listTransformationTemplates(notebook.id)
      .then((tpl) => { setTemplates(tpl); setTemplatesFailed(false); })
      .catch(() => setTemplatesFailed(true));
  }, [loadSources, loadNotes, loadTransformations, notebook.id]);

  const submitSource = useCallback(async () => {
    if (!srcText.trim()) return;
    setSrcBusy(true);
    try {
      await addSource(notebook.id, { ...(srcTitle.trim() ? { title: srcTitle.trim() } : {}), text: srcText.trim() });
      setSrcTitle('');
      setSrcText('');
      loadSources();
      toast.success(t('sourceAdded'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('sourceAddFailed'));
    } finally {
      setSrcBusy(false);
    }
  }, [notebook.id, srcTitle, srcText, loadSources, t]);

  // Sources mid-summarize (the run is async; show pending until listSources reports
  // hasSummary). Keyed by documentId.
  const [summarizing, setSummarizing] = useState<Set<string>>(new Set());

  /**
   * The async pollers below recurse via `setTimeout`; this flips false on unmount
   * so a poll in flight when the user navigates away stops fetching and setting
   * state on an unmounted component (review fix).
   *
   * `L7` (pre-existing, ADR 0602 § Correction log item G) — the effect used to be
   * cleanup-ONLY with a `[]` dep list, so it SET the flag false and never reset
   * it. Under StrictMode (`main.tsx:80`, dev only) React mounts, unmounts and
   * remounts: the first cleanup left `liveRef.current === false` for the whole
   * second lifetime, so every poll bailed on its first tick and `summarizing` /
   * `transforming` never cleared — a permanent spinner on every dev interaction,
   * invisible in production. Setting it true on mount is the whole fix, and the
   * new shared poller is the one obvious place for it.
   */
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    return () => { liveRef.current = false; };
  }, []);

  /**
   * ADR 0602 / NBU-6 — a poll that GIVES UP has to say so.
   *
   * All three async runs in this workspace (ingest, summarize, transform) polled
   * for a result and, on hitting their attempt cap, executed a BARE `return`.
   * Nothing rendered, nothing announced, no state changed that a user could read.
   * The spinner simply stopped, which is byte-identical to the success path minus
   * the result — so a permanently failed run and a slow one looked the same, and
   * the panel then rendered "No sources yet" / "No transformations yet": a
   * POSITIVE CLAIM about the server's contents made after the client stopped
   * looking. Silent, then confidently wrong.
   *
   * The rule, written ONCE rather than hand-copied into three pollers that had
   * already drifted (10 attempts vs 8; one clearing its pending flag on the
   * unmount bail, two not):
   *
   *   - a timeout is NOT a failure claim. The run may still be working. The copy
   *     says "we stopped checking", never "there is nothing";
   *   - it is stated in the OWNING PANEL as a `StateCard announce` — the same
   *     shape the three failed-read siblings use, deliberately matched rather
   *     than replaced. `announce` is POLITE (it delegates to the app-shell
   *     `GlobalLiveRegion`, mounted long before any message, so it dodges both
   *     the "live region mounted WITH content announces nothing" trap and
   *     `DS-NB-1`, where a repeated identical error TOAST coalesces without a DOM
   *     node and is excluded from `announce()` entirely). Polite is the right
   *     register: an assertive interrupt 20-30 seconds after the click, for a
   *     thing that has not failed, is disproportionate — `Notice`'s assertive
   *     branch stays for failed ACTIONS, per `ui/StateCard.tsx`;
   *   - it SUPPRESSES the panel's empty state, because "nothing here" is exactly
   *     the claim a give-up must not make;
   *   - it clears only on EVIDENCE. "Check again" re-runs the SAME predicate the
   *     poller used; a recheck that still finds nothing keeps the card and says
   *     so with a changing count (NBU-19: a retry whose screen is byte-identical
   *     before and after is a button that did nothing observable).
   */
  // `M3` — SEEDED from the module store, so a tab switch (which unmounts this
  // whole panel) no longer destroys a standing give-up and let the surface fall
  // back to "No sources yet".
  const [stalled, setStalledState] = useState<ReadonlyMap<StallKind, StallState>>(() => readStalls(notebook.id));
  const [recheckBusy, setRecheckBusy] = useState<ReadonlySet<StallKind>>(() => new Set());

  /** Write-through: React state for rendering, the module store for surviving
   *  the unmount. One setter so the two cannot diverge. */
  const setStalled = useCallback((update: (prev: ReadonlyMap<StallKind, StallState>) => ReadonlyMap<StallKind, StallState>) => {
    setStalledState((prev) => {
      const next = update(prev);
      if (next !== prev) writeStalls(notebook.id, next);
      return next;
    });
  }, [notebook.id]);

  const clearStall = useCallback((kind: StallKind) => {
    setStalled((prev) => {
      if (!prev.has(kind)) return prev;
      const next = new Map(prev); next.delete(kind); return next;
    });
  }, [setStalled]);

  /**
   * `M3a` — a give-up clears the moment its subject ARRIVES, by any route.
   *
   * The first cut cleared only inside the poller and inside "Check again", so an
   * ordinary list refresh (another upload's poll, a retry, a remount) could
   * render the awaited source in the list with the card still above it saying
   * "Still waiting for that source". The predicate is pure, so it can simply be
   * evaluated against whatever is currently in hand — which also re-derives the
   * verdict on MOUNT, closing the other half of `M3`.
   */
  useEffect(() => {
    setStalled((prev) => {
      if (prev.size === 0) return prev;
      let next: Map<StallKind, StallState> | null = null;
      for (const [kind, entry] of prev) {
        if (!stallSatisfied(entry.subject, sources, transformations)) continue;
        next ??= new Map(prev);
        next.delete(kind);
      }
      return next ?? prev;
    });
  }, [sources, transformations, setStalled]);

  /**
   * Re-read the list this subject lives in and answer whether it has arrived —
   * rebuilt from the DESCRIPTOR, so it works on a fresh mount where the poller's
   * original closure is long gone. A throw propagates: the caller must be able to
   * tell "I looked and it isn't there" from "I could not look" (`M1`).
   */
  const recheckSubject = useCallback(async (subject: StallSubject): Promise<boolean> => {
    if (subject.kind === 'transform') {
      const fresh = await listTransformations(notebook.id);
      setTransformations(fresh);
      return stallSatisfied(subject, sources, fresh);
    }
    const fresh = await listSources(notebook.id);
    setSources(fresh);
    return stallSatisfied(subject, fresh, transformations);
  }, [notebook.id, sources, transformations]);

  /** The ONE poller. `landed` resolving true settles it; the cap STATES itself. */
  const pollUntilLanded = useCallback((opts: {
    subject: StallSubject;
    /** The run this poll is waiting on (`H4`) — surfaced as a link on the
     *  give-up card, so a dead end becomes a diagnosable one. */
    runId?: string;
    maxAttempts: number;
    firstDelayMs: number;
    intervalMs: number;
    /** Refreshes the list this subject lives in and answers "has it landed?".
     *  A throw is transient, not a stall. */
    landed: () => Promise<boolean>;
    /** Runs on BOTH outcomes — the row's pending flag must clear either way. */
    onSettled?: () => void;
  }) => {
    clearStall(opts.subject.kind); // a fresh attempt supersedes an earlier give-up
    let attempts = 0;
    const poll = async (): Promise<void> => {
      attempts += 1;
      if (!liveRef.current) return; // the workspace unmounted mid-poll
      try {
        if (await opts.landed()) { opts.onSettled?.(); return; }
      } catch { /* transient — keep polling until the cap */ }
      if (attempts >= opts.maxAttempts) {
        opts.onSettled?.();
        setStalled((prev) => new Map(prev).set(opts.subject.kind, { subject: opts.subject, rechecks: 0, lastRecheckFailed: false, ...(opts.runId ? { runId: opts.runId } : {}) }));
        return;
      }
      window.setTimeout(() => { void poll(); }, opts.intervalMs);
    };
    window.setTimeout(() => { void poll(); }, opts.firstDelayMs);
  }, [clearStall, setStalled]);

  /**
   * "Check again" — the SAME subject, re-read on demand.
   *
   * ── `M1`: an errored recheck is not evidence of absence ──────────────────────
   *
   * The first cut ran one `catch` into the same branch as "found nothing", so a
   * network failure incremented the counter and the card said "Checked 1 more
   * time — still nothing new". That is a claim about the SERVER made from a
   * request that never reached it: a failure to observe presented as an
   * observation of absence, in the one card whose entire purpose is not to make
   * that claim. The three outcomes are now three branches.
   *
   * ── `M9`: the recheck RESULT is announced ────────────────────────────────────
   *
   * `StateCard`'s announce effect is keyed `[announce, title]` (deliberately —
   * its body carries raw error text that changes on every retry). A recheck
   * changes only the BODY, so repeat "Check again" was sighted-only. The outcome
   * is therefore announced HERE, directly, rather than by widening a shared
   * component's key and re-announcing error strings across every other surface
   * that uses it. The initial give-up still announces via `StateCard`, unchanged.
   */
  const recheckStall = useCallback(async (kind: StallKind): Promise<void> => {
    const entry = stalled.get(kind);
    if (!entry) return;
    setRecheckBusy((prev) => new Set(prev).add(kind));
    try {
      const landed = await recheckSubject(entry.subject);
      if (landed) {
        clearStall(kind);
        announce(t('stalledRecheckLanded'));
        return;
      }
      // Still nothing. Keep the card — but CHANGE it, so the click is observable.
      const nextCount = entry.rechecks + 1;
      setStalled((prev) => {
        const cur = prev.get(kind);
        if (!cur) return prev;
        return new Map(prev).set(kind, { ...cur, rechecks: nextCount, lastRecheckFailed: false });
      });
      announce(t('stalledRecheckedNothing', { count: nextCount }));
    } catch {
      // We could not look. The count does NOT advance — it counts observations,
      // and this was not one.
      setStalled((prev) => {
        const cur = prev.get(kind);
        if (!cur) return prev;
        return new Map(prev).set(kind, { ...cur, lastRecheckFailed: true });
      });
      announce(t('stalledRecheckFailed'));
    } finally {
      setRecheckBusy((prev) => { const next = new Set(prev); next.delete(kind); return next; });
    }
  }, [stalled, clearStall, setStalled, recheckSubject, t]);

  /**
   * The stall card for one kind, or null. Matches the failed-read siblings.
   *
   * It takes RESOLVED strings, not key names. The first cut took `titleKey` /
   * `bodyKey` and called `t(titleKey)` — which makes the key DYNAMIC, so
   * `check-i18n`'s reference miner cannot see it: its FATAL key-parity check
   * would not catch a typo (the raw key would render at runtime with nothing
   * red) and its orphan pass would report all six new keys as dead. Caught by
   * this PR's own locale sweep, on this PR's own new keys — the fix had
   * committed the family it was closing. Callers pass `t('stalledIngestTitle')`
   * so the literal sits at the call site where the miner reads it.
   */
  const stallCard = useCallback((kind: StallKind, icon: React.ReactNode, title: string, body: string) => {
    const entry = stalled.get(kind);
    if (!entry) return null;
    return (
      <StateCard
        announce
        icon={icon}
        title={title}
        body={(
          <>
            {body}
            {/* `M1` — two different things a recheck can report, said differently.
                "still nothing new" is a claim about the server; "we couldn't
                check" is a claim about the request. The count belongs only to
                the first, because it counts OBSERVATIONS. */}
            {entry.rechecks > 0 ? <> {t('stalledRecheckedNothing', { count: entry.rechecks })}</> : null}
            {entry.lastRecheckFailed ? <> {t('stalledRecheckFailed')}</> : null}
          </>
        )}
        action={(
          <>
            <Button variant="quiet" loading={recheckBusy.has(kind)} onClick={() => void recheckStall(kind)}>
              {t('checkAgain')}
            </Button>
            {/* `H4` — the run id was previously discarded at the call site, so the
                one artifact that can say WHY nothing arrived was unreachable. */}
            {entry.runId ? <Link to={`/runs/${encodeURIComponent(entry.runId)}`} className="u-fs-12">{t('stalledViewRun')}</Link> : null}
          </>
        )}
      />
    );
  }, [stalled, recheckBusy, recheckStall, t]);

  /** `M4` — the ONE suppression rule: a panel that is showing ANY give-up must
   *  not also claim to be empty. Stated once here instead of hand-written per
   *  panel, where one of the two had already forgotten a kind. */
  const panelStalled = useCallback(
    (panel: keyof typeof PANEL_STALL_KINDS): boolean => PANEL_STALL_KINDS[panel].some((k) => stalled.has(k)),
    [stalled],
  );

  // Poll listSources until a source that was NOT already there appears, or the
  // ~30s cap — an ingest run is an LLM transcription / network fetch, so it can
  // take seconds. NBU-6: the cap now STATES itself.
  //
  // `M2` — the baseline is an ID SET, not a count. `fresh.length > baseline` was
  // satisfied by ANY arrival, so an unrelated source landing cleared a card that
  // was waiting for a different one, and the user was told their upload had
  // arrived when it had not.
  const pollForNewSource = useCallback((baselineSourceIds: readonly string[], runId: string | undefined) => {
    const subject: StallSubject = { kind: 'ingest', baselineSourceIds };
    pollUntilLanded({
      subject,
      ...(runId ? { runId } : {}),
      maxAttempts: 10, firstDelayMs: 2500, intervalMs: 3000, // ~30s
      landed: async () => {
        const fresh = await listSources(notebook.id);
        setSources(fresh);
        return stallSatisfied(subject, fresh, null);
      },
    });
  }, [notebook.id, pollUntilLanded]);

  const submitAudio = useCallback(async (file: File | undefined) => {
    if (!file) return;
    if (!withinUploadCap(file)) { toast.error(t('fileTooLarge', { max: MAX_UPLOAD_MB })); return; }
    setAudioBusy(true);
    try {
      const contentBase64 = await fileToBase64(file);
      const contentType = file.type || 'audio/mpeg';
      const baseline = (sources ?? []).map((s) => s.documentId);
      const { runId } = await addAudioSource(notebook.id, { title: file.name, contentBase64, contentType });
      toast.success(t('audioEnqueued'));
      pollForNewSource(baseline, runId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('audioFailed'));
    } finally {
      setAudioBusy(false);
    }
  }, [notebook.id, sources, pollForNewSource, t]);

  // Document file upload (text/PDF/DOCX) — extracted to text + ingested synchronously.
  const submitDocument = useCallback(async (file: File | undefined) => {
    if (!file) return;
    if (!withinUploadCap(file)) { toast.error(t('fileTooLarge', { max: MAX_UPLOAD_MB })); return; }
    setFileBusy(true);
    try {
      const contentBase64 = await fileToBase64(file);
      await addFileSource(notebook.id, { title: file.name, contentBase64, contentType: inferContentType(file) });
      loadSources();
      toast.success(t('sourceAdded'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('sourceAddFailed'));
    } finally {
      setFileBusy(false);
    }
  }, [notebook.id, loadSources, t]);

  const submitYoutube = useCallback(async () => {
    if (!ytUrl.trim()) return;
    setYtBusy(true);
    try {
      const baseline = (sources ?? []).map((s) => s.documentId);
      const { runId } = await addYoutubeSource(notebook.id, { url: ytUrl.trim() });
      setYtUrl('');
      toast.success(t('youtubeEnqueued'));
      pollForNewSource(baseline, runId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('youtubeFailed'));
    } finally {
      setYtBusy(false);
    }
  }, [notebook.id, ytUrl, sources, pollForNewSource, t]);

  const changeLevel = useCallback(async (sourceId: string, level: SourceContextLevel) => {
    // Optimistic: flip the level locally, then reconcile with the server's projection.
    setSources((prev) => prev?.map((s) => (s.documentId === sourceId ? { ...s, contextLevel: level } : s)) ?? prev);
    try {
      const updated = await setSourceContextLevel(notebook.id, sourceId, level);
      setSources((prev) => prev?.map((s) => (s.documentId === sourceId ? updated : s)) ?? prev);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('contextLevelFailed'));
      loadSources(); // roll back to the server truth
    }
  }, [notebook.id, loadSources, t]);

  const summarize = useCallback(async (sourceId: string) => {
    setSummarizing((prev) => new Set(prev).add(sourceId));
    try {
      const { runId } = await summarizeSource(notebook.id, sourceId);
      toast.success(t('summarizeStarted'));
      // The run is async (an LLM call — can take several seconds). Poll listSources
      // until the source reports hasSummary rather than guessing a fixed delay; stop
      // on success, on max attempts, or if the page navigated away. Refresh the panel
      // on every poll so the user sees it land the moment it does.
      const subject: StallSubject = { kind: 'summarize', sourceId };
      pollUntilLanded({
        subject,
        ...(runId ? { runId } : {}),
        maxAttempts: 8, firstDelayMs: 2000, intervalMs: 2500, // ~20s
        landed: async () => {
          const fresh = await listSources(notebook.id);
          setSources(fresh);
          return stallSatisfied(subject, fresh, null);
        },
        onSettled: () =>
          setSummarizing((prev) => { const next = new Set(prev); next.delete(sourceId); return next; }),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('summarizeFailed'));
      setSummarizing((prev) => { const next = new Set(prev); next.delete(sourceId); return next; });
    }
  }, [notebook.id, pollUntilLanded, t]);

  const transform = useCallback(async (sourceId: string, templateId: string) => {
    if (!templateId) return;
    setTransforming((prev) => new Set(prev).add(sourceId));
    try {
      const { runId } = await applyTransformation(notebook.id, sourceId, templateId);
      toast.success(t('transformStarted'));
      // The run is async (an LLM call). Poll listTransformations until a new artifact
      // lands (count grows) rather than guessing a fixed delay; stop on success, on
      // max attempts, or when the page navigates away (~20s cap). Refresh the panel on
      // every poll so the user sees it the moment it lands.
      // `M2` — identity, not count: another template's artifact landing must not
      // clear the card waiting for THIS one.
      const subject: StallSubject = { kind: 'transform', baselineTransformationIds: (transformations ?? []).map((tr) => tr.documentId) };
      pollUntilLanded({
        subject,
        ...(runId ? { runId } : {}),
        maxAttempts: 8, firstDelayMs: 2000, intervalMs: 2500, // ~20s
        landed: async () => {
          const fresh = await listTransformations(notebook.id);
          setTransformations(fresh);
          return stallSatisfied(subject, null, fresh);
        },
        onSettled: () =>
          setTransforming((prev) => { const next = new Set(prev); next.delete(sourceId); return next; }),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('transformFailed'));
      setTransforming((prev) => { const next = new Set(prev); next.delete(sourceId); return next; });
    }
  }, [notebook.id, transformations, pollUntilLanded, t]);

  // ADR 0601 — `origin` is a REQUIRED argument, not an option with a default: the
  // two lanes that reach this handler have genuinely different content provenance
  // (the composer's words are the user's; a search hit's words are the source's),
  // and the defect this closes was a lane that declared nothing.
  // NBU-4 — the shared core. It CLEARS NOTHING. "Save to notes" beside a search
  // hit used to call the COMPOSER's handler, whose unconditional `setNoteText('')`
  // wiped a note the user was midway through writing — unsaved work destroyed by
  // a control whose label promises only an addition, on a surface where notes have
  // no edit and no delete. Returns whether the write succeeded so the composer
  // lane can decide, instead of clearing optimistically.
  const saveNote = useCallback(async (text: string, origin: NoteContentOrigin): Promise<boolean> => {
    if (!text.trim()) return false;
    setNoteBusy(true);
    try {
      const next = await addNote(notebook.id, text.trim(), origin);
      setNotes(next);
      setNotesFailed(null);
      toast.success(t('noteAdded'));
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('noteAddFailed'));
      return false;
    } finally {
      setNoteBusy(false);
    }
  }, [notebook.id, t]);

  /** The COMPOSER lane — the ONLY lane that may clear the composer, and only on
   *  success. The user's own words, so `'authored'` (ADR 0601). */
  const submitComposedNote = useCallback(async () => {
    if (await saveNote(noteText, 'authored')) setNoteText('');
  }, [saveNote, noteText]);

  const openChat = useCallback(async () => {
    setChatBusy(true);
    try {
      const { conversationId } = await ensureNotebookChat(notebook.id);
      navigate(`/chat?conversation=${encodeURIComponent(conversationId)}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('chatOpenFailed'));
      setChatBusy(false);
    }
  }, [notebook.id, navigate, t]);

  // NBU-5 — the sharpest defect on a grounded-retrieval surface. `answer` was set
  // ONLY on success and cleared NOWHERE, so a failed Ask left question 1's hits
  // and citation chips rendered beneath question 2's query — evidence visually
  // re-attributed to a question it never answered, with no marker that it was
  // stale. The user could then click "save to notes" and durably persist that
  // passage as the answer to the wrong question.
  //
  // Cleared BEFORE the await, so a stale answer cannot outlive its query even for
  // the duration of the request. The panel is briefly blank, which makes NO claim;
  // on failure it makes an explicit one, rendered IN PLACE rather than in a toast
  // that vanishes in six seconds.
  const ask = useCallback(async () => {
    if (!query.trim()) return;
    setAskBusy(true);
    setAnswer(null);
    setAskFailed(null);
    try {
      setAnswer(await searchNotebook(notebook.id, query.trim()));
    } catch (err) {
      // NBU-20 (ADR 0601 § Corrections / LOW-9) — the StateCard is the ONLY
      // channel here. It used to do both: a `StateCard announce` (polite, the
      // TITLE) plus `toast.error` (role="alert", assertive, the MESSAGE), so a
      // failed Ask announced twice, in two politeness levels, with two different
      // strings. `StateCard`'s docblock says the card picks exactly one
      // mechanism, and the comment above already claimed this failure is
      // "rendered IN PLACE rather than in a toast" — the code did both.
      //
      // The toast STAYS on `saveNote` and the other write lanes: StateCard draws
      // the line at a failed ACTION (transient, owning no surface) versus a
      // failed panel READ (which owns the region it just emptied), and Ask is the
      // second kind.
      setAskFailed(err instanceof Error ? err.message : t('askFailed'));
    } finally {
      setAskBusy(false);
    }
  }, [notebook.id, query, t]);

  return (
    <section className="u-grid u-gap-4">
      {/* Embedded in a project tab — the project page owns the header (ADR 0084
          correction; the standalone route + its back/delete chrome were removed in
          the 2026-07-22 cleanup, the panel is the only mount). */}

      <div className="nb-workspace">
        {/* Sources */}
        <div className="surface-card u-p-4 nb-panel">
          <div className="nb-panel__head">
            <h2 className="nb-panel__title"><FileTextIcon size={16} /> {t('sourcesTitle')}</h2>
            {sources && sources.length > 0 ? (
              <span className="chip chip--muted" title={t('contextBudgetHint')}>
                {t('contextBudget', {
                  tokens: formatTokens(sources.filter((s) => s.contextLevel !== 'excluded').reduce((sum, s) => sum + sourceTokens(s), 0)),
                })}
              </span>
            ) : null}
          </div>
          <form className="u-grid u-gap-2" onSubmit={(e) => { e.preventDefault(); void submitSource(); }}>
            <TextField label={t('sourceTitleLabel')} value={srcTitle} onChange={(e) => setSrcTitle(e.target.value)} placeholder={t('sourceTitlePlaceholder')} />
            <TextareaField label={t('sourceTextLabel')} value={srcText} onChange={(e) => setSrcText(e.target.value)} rows={4} placeholder={t('sourceTextPlaceholder')} />
            <Button variant="primary" type="submit" disabled={srcBusy || !srcText.trim()}><PlusIcon size={14} /> {t('addSource')}</Button>
          </form>
          {/* Document file upload (text/PDF/DOCX) — extracted to text synchronously. */}
          <div className="field u-mt-2">
            <span className="field-label"><PaperclipIcon size={14} /> {t('addFileLabel')}</span>
            <input
              type="file"
              accept={KB_UPLOAD_ACCEPT}
              disabled={fileBusy}
              aria-label={t('addFileLabel')}
              aria-describedby="nb-file-help"
              onChange={(e) => { void submitDocument(e.target.files?.[0]); e.target.value = ''; }}
            />
            <div className="field-help" id="nb-file-help">{fileBusy ? t('uploading') : t('addFileHint')}</div>
          </div>
          {/* Audio/video upload + YouTube URL (ADR 0085) — both transcribe to a KB source asynchronously. */}
          <div className="u-grid u-gap-2 u-mt-2">
            <div className="field">
              <span className="field-label"><MicIcon size={14} /> {t('addAudioLabel')}</span>
              <input
                type="file"
                accept="audio/*,video/*"
                disabled={audioBusy}
                aria-label={t('addAudioLabel')}
                aria-describedby="nb-audio-help"
                onChange={(e) => { void submitAudio(e.target.files?.[0]); e.target.value = ''; }}
              />
              <div className="field-help" id="nb-audio-help">{audioBusy ? t('uploading') : t('addAudioHint')}</div>
            </div>
            <form className="u-grid u-gap-2" onSubmit={(e) => { e.preventDefault(); void submitYoutube(); }}>
              <TextField label={t('addYoutubeLabel')} type="url" value={ytUrl} onChange={(e) => setYtUrl(e.target.value)} placeholder={t('addYoutubePlaceholder')} />
              <Button type="submit" variant="quiet" disabled={ytBusy || !ytUrl.trim()}><LinkIcon size={14} /> {t('addYoutubeBtn')}</Button>
            </form>
          </div>
          {sourcesFailed ? (
            <StateCard
              announce
              icon={<FileTextIcon size={20} />}
              title={t('sourcesFailedTitle')}
              body={sourcesFailed}
              action={<Button variant="quiet" loading={retrying.has('sources')} onClick={() => void retryLoad('sources', loadSources)}>{t('retry')}</Button>}
            />
          ) : sources === null ? (
            <Skeleton height={60} />
          ) : (
            <>
              {/* NBU-6 — a give-up STATES itself, above the list, and suppresses the
                  empty state below: "No sources yet" is a positive claim about the
                  server, and the client has just stopped looking. */}
              {stallCard('ingest', <FileTextIcon size={20} />, t('stalledIngestTitle'), t('stalledIngestBody'))}
              {stallCard('summarize', <FileTextIcon size={20} />, t('stalledSummarizeTitle'), t('stalledSummarizeBody'))}
              {sources.length === 0 && !panelStalled('sources') ? (
                <StateCard icon={<FileTextIcon size={20} />} title={t('noSourcesTitle')} body={t('noSourcesBody')} />
              ) : sources.length === 0 ? null : (
            <ul className="nb-list">
              {sources.map((s) => {
                const excluded = s.contextLevel === 'excluded';
                const isSummarizing = summarizing.has(s.documentId);
                const isPending = isSummarizing || transforming.has(s.documentId);
                const itemClass = [
                  'nb-list__item',
                  excluded ? 'nb-list__item--excluded' : '',
                  isPending ? 'nb-list__item--pending' : '',
                ].filter(Boolean).join(' ');
                return (
                  <li key={s.documentId} className={itemClass} aria-busy={isPending ? 'true' : undefined}>
                    <div className="nb-list__item-title">{s.title}</div>
                    <div className="nb-list__item-meta">
                      {t('chunkCount', { count: s.chunkCount })} · {t('approxTokens', { tokens: formatTokens(sourceTokens(s)) })}
                    </div>
                    <div className="nb-level" role="group" aria-label={t('contextLevelLabel', { title: s.title })}>
                      <button
                        type="button"
                        className="nb-level__btn"
                        aria-pressed={s.contextLevel === 'full'}
                        onClick={() => { if (s.contextLevel !== 'full') void changeLevel(s.documentId, 'full'); }}
                      >
                        {t('levelFull')}
                      </button>
                      <button
                        type="button"
                        className="nb-level__btn"
                        aria-pressed={s.contextLevel === 'summary'}
                        disabled={!s.hasSummary}
                        title={s.hasSummary ? t('levelSummaryReadyHint') : t('levelSummaryHint')}
                        onClick={() => { if (s.hasSummary && s.contextLevel !== 'summary') void changeLevel(s.documentId, 'summary'); }}
                      >
                        {t('levelSummary')}
                      </button>
                      <button
                        type="button"
                        className="nb-level__btn"
                        aria-pressed={excluded}
                        onClick={() => { if (!excluded) void changeLevel(s.documentId, 'excluded'); }}
                      >
                        {t('levelExcluded')}
                      </button>
                    </div>
                    <div className="action-bar">
                      <Button
                        variant="quiet"
                        disabled={isSummarizing}
                        onClick={() => void summarize(s.documentId)}
                        title={s.hasSummary ? t('resummarizeHint') : t('summarizeHint')}
                      >
                        <SparklesIcon size={14} /> {isSummarizing ? t('summarizing') : s.hasSummary ? t('resummarize') : t('summarize')}
                      </Button>
                      {templatesFailed ? (
                        <span className="u-label-sm muted" title={t('transformUnavailableHint')}>{t('transformUnavailable')}</span>
                      ) : templates.length > 0 ? (
                        <label className="nb-transform" title={t('transformHint')}>
                          <span className="nb-transform__icon"><ZapIcon size={14} /></span>
                          <span className="sr-only">{t('transformLabel', { title: s.title })}</span>
                          <select
                            className="nb-transform__select"
                            value=""
                            disabled={transforming.has(s.documentId)}
                            onChange={(e) => { const v = e.target.value; e.target.value = ''; void transform(s.documentId, v); }}
                          >
                            <option value="" disabled>
                              {transforming.has(s.documentId) ? t('transforming') : t('transform')}
                            </option>
                            {templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.label}</option>)}
                          </select>
                        </label>
                      ) : null}
                    </div>
                  </li>
                );
              })}
              </ul>
              )}
            </>
          )}
        </div>

        {/* Notes */}
        <div className="surface-card u-p-4 nb-panel">
          <h2 className="nb-panel__title"><ClipboardIcon size={16} /> {t('notesTitle')}</h2>
          <form className="u-grid u-gap-2" onSubmit={(e) => { e.preventDefault(); void submitComposedNote(); }}>
            <TextareaField label={t('noteLabel')} value={noteText} onChange={(e) => setNoteText(e.target.value)} rows={3} placeholder={t('notePlaceholder')} />
            <Button variant="primary" type="submit" disabled={noteBusy || !noteText.trim()}><PlusIcon size={14} /> {t('addNote')}</Button>
          </form>
          {notesFailed ? (
            <StateCard
              announce
              icon={<ClipboardIcon size={20} />}
              title={t('notesFailedTitle')}
              body={notesFailed}
              action={<Button variant="quiet" loading={retrying.has('notes')} onClick={() => void retryLoad('notes', loadNotes)}>{t('retry')}</Button>}
            />
          ) : notes === null ? (
            <Skeleton height={60} />
          ) : notes.length === 0 ? (
            <StateCard icon={<ClipboardIcon size={20} />} title={t('noNotesTitle')} body={t('noNotesBody')} />
          ) : (
            <ul className="nb-list">
              {notes.map((n) => (
                <li key={n.id} className="nb-list__item">
                  <div className="nb-note__body">{n.content}</div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Transformations (ADR 0084 T2) — the result Documents, read-only. The
            output lives in Documents (single source of truth); this panel only lists
            it and deep-links the Documents surface. */}
        <div className="surface-card u-p-4 nb-panel">
          <h2 className="nb-panel__title"><FileTextIcon size={16} /> {t('transformationsTitle')}</h2>
          <p className="muted u-m-0 u-fs-12">{t('transformationsNote')}</p>
          {transformationsFailed ? (
            <StateCard
              announce
              icon={<ZapIcon size={20} />}
              title={t('transformationsFailedTitle')}
              body={transformationsFailed}
              action={<Button variant="quiet" loading={retrying.has('transformations')} onClick={() => void retryLoad('transformations', loadTransformations)}>{t('retry')}</Button>}
            />
          ) : transformations === null ? (
            <Skeleton height={60} />
          ) : (
            <>
              {/* NBU-6 — same rule as Sources: the give-up states itself and the
                  "No transformations yet" claim is suppressed while it stands.
                  That empty card was rendered AFTER a transform had been started
                  and the client had stopped waiting for it. */}
              {stallCard('transform', <ZapIcon size={20} />, t('stalledTransformTitle'), t('stalledTransformBody'))}
              {transformations.length === 0 && !panelStalled('transformations') ? (
                <StateCard icon={<ZapIcon size={20} />} title={t('noTransformationsTitle')} body={t('noTransformationsBody')} />
              ) : transformations.length === 0 ? null : (
            <ul className="nb-list">
              {transformations.map((tr) => (
                <li key={tr.documentId} className="nb-list__item">
                  <div className="nb-list__item-title">{tr.title}</div>
                  <div className="nb-list__item-meta">
                    <span className="chip chip--accent">{tr.kind}</span>{' '}
                    {formatRelativeTime(tr.createdAt)}
                  </div>
                  <div className="action-bar">
                    <Button variant="quiet" onClick={() => navigate('/documents')}>
                      <ArrowRightIcon size={14} /> {t('openInDocuments')}
                    </Button>
                  </div>
                </li>
              ))}
              </ul>
              )}
            </>
          )}
        </div>

        {/* Ask + chat */}
        <div className="surface-card u-p-4 nb-panel">
          <h2 className="nb-panel__title"><SearchIcon size={16} /> {t('askTitle')}</h2>
          <form className="u-grid u-gap-2" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
            <TextField label={t('askLabel')} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('askPlaceholder')} />
            <Button variant="primary" type="submit" disabled={askBusy || !query.trim()}><SearchIcon size={14} /> {t('ask')}</Button>
          </form>

          {askFailed ? (
            <StateCard
              announce
              icon={<SearchIcon size={20} />}
              title={t('askFailedTitle')}
              body={askFailed}
              action={<Button variant="quiet" onClick={() => void ask()} disabled={askBusy}>{t('retry')}</Button>}
            />
          ) : answer ? (
            answer.hits.length === 0 ? (
              <StateCard icon={<SearchIcon size={20} />} title={t('noHitsTitle')} body={t('noHitsBody')} />
            ) : (
              <div className="u-grid u-gap-2">
                <div className="nb-citations">
                  {answer.citations.map((c) => <span key={c.documentId} className="chip chip--accent">{c.title}</span>)}
                </div>
                {answer.hits.map((h) => (
                  <div key={h.chunkId} className="nb-hit">
                    <div className="nb-hit__head">
                      <span className="nb-list__item-title">{h.title}</span>
                      <span className="chip chip--muted">{t('score', { score: Math.round(h.score * 100) })}</span>
                    </div>
                    <div className="nb-hit__text">{h.text}</div>
                    <span className="action-bar">
                      <Button variant="quiet" onClick={() => void saveNote(h.text, 'third-party')} disabled={noteBusy}>
                        <ClipboardIcon size={14} /> {t('saveToNotes')}
                      </Button>
                    </span>
                  </div>
                ))}
              </div>
            )
          ) : null}

          <h2 className="nb-panel__title"><MessageSquareIcon size={16} /> {t('chatTitle')}</h2>
          <p className="muted u-m-0 u-fs-12">{t('chatGroundedNote')}</p>
          <StateCard
            icon={<MessageSquareIcon size={20} />}
            title={t('chatLaunchTitle')}
            body={t('chatLaunchBody')}
            action={(
              <Button variant="primary" disabled={chatBusy} onClick={() => void openChat()}>
                <MessageSquareIcon size={14} /> {chatBusy ? t('chatOpening') : t('openChat')}
              </Button>
            )}
          />
        </div>
      </div>
    </section>
  );
}

/** Sources tab embedded in a project (ADR 0084 correction) — provisions the
 *  project's KB collection on open (idempotent `ensureNotebook`), then renders the
 *  full notebook workspace (sources w/ context levels, audio/YouTube ingest,
 *  transformations, grounded Ask) scoped to this project. No back chrome — the
 *  project page owns the header. Toggle-gating is done by the host tab. */
export function ProjectSourcesPanel({ projectId }: { projectId: string }): JSX.Element {
  const { t } = useTranslation('notebooks');
  const [notebook, setNotebook] = useState<Notebook | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void ensureNotebook(projectId)
      .then((nb) => { if (live) setNotebook(nb); })
      .catch((err) => { if (live) setError(err instanceof Error ? err.message : String(err)); });
    return () => { live = false; };
  }, [projectId]);
  if (error) return <StateCard announce title={t('loadFailed')} body={error} />;
  if (!notebook) return <Skeleton height={120} />;
  return <NotebookWorkspace notebook={notebook} />;
}
