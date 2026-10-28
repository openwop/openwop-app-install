/**
 * TabChatDeck — the keep-alive multi-tab chat container (ADR 0140 P3).
 *
 * Renders a bounded working set (useTabDeck, P2) of live conversations: EVERY open
 * tab stays MOUNTED, and inactive tabs are hidden with `display:none` (NOT React
 * <Activity>, which would tear down effects and close the live SSE subscription).
 * A `display:none` subtree is also removed from the tab order and the accessibility
 * tree by the browser, so background tabs are neither focusable nor announced — no
 * `inert` needed. This is what lets a background conversation keep streaming while
 * the user reads another.
 *
 * The strip here is intentionally MINIMAL — the full APG `role="tablist"` strip
 * (roving tabindex, manual activation, drag-reorder, pin, overflow) lands in P4, and
 * opening EXISTING conversations from the sidebar library is P7. P3 proves the
 * keep-alive core: new tabs (fresh ids), switch, close, and re-key on `/clear`.
 *
 * Streaming state is held in a ref (not React state) so it can protect streaming
 * tabs from eviction WITHOUT re-rendering all N keep-alive subtrees on every turn
 * boundary (the reactive unread/blocked badges are P5).
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { useTabDeck } from './useTabDeck.js';
import { useTabBadges } from './useTabBadges.js';
import { useDeckShortcuts } from './useDeckShortcuts.js';
import { useChatSessions } from '../hooks/useChatSessions.js';
import { useAuth } from '../../auth/useAuth.js';
import { ensureWireTenant } from '../../client/v2Wire.js';
import { listMyWorkspaces } from '../../client/workspaceClient.js';
import { forgetLegacyTabDeck, workspaceDeckSubject } from './tabDeckPersistence.js';
import { toast } from '../../ui/toast.js';
import { announce } from '../../ui/announce.js';
import { TabSession } from './TabSession.js';
import { StateCard } from '../../ui/StateCard.js';
import { Button } from '../../ui/Button.js';
import { PlusIcon } from '../../ui/icons/index.js';
import { TabStrip, tabButtonId, tabPanelId } from './TabStrip.js';
import { getDeckTabKind, listDeckTabKinds } from './tabKindRegistry.js';
import { useFeatureVisible } from '../../featureToggles/FeatureAccessContext.js';
import { listChatSessionMessagesPage, type ChatSessionHeader } from '../../client/chatSessionsClient.js';
import { isAbandonedEmptyChat } from '../lib/abandonedChat.js';
import { LeftRail, type LeftRailTab } from '../leftRail/LeftRail.js';
import { Workbench } from '../workbench/Workbench.js';
import { useMobilePaneArbitration, useWorkbench } from '../workbench/useWorkbench.js';
import { useReviewStatusStore, useReviewCount, useReviewCountsByConversation } from '../reviews/reviewStatusStore.js';
import { useRunningConversations } from '../conversations/useRunningConversations.js';
import { EMPTY_SOURCES, type ConversationSources } from '../workbench/sources.js';
import { WorkbenchActionsContext } from '../workbench/workbenchActions.js';
import type { BYOKActiveConfig } from '../../byok/lib/useBYOKConfig.js';
import type { ChatMessage } from '../types.js';

// ADR 0154 FU-1 — deck parity: create a channel from the library.
const ChannelCreateDialog = lazy(() => import('../conversations/ChannelCreateDialog.js').then((m) => ({ default: m.ChannelCreateDialog })));
const ChannelBrowseDialog = lazy(() => import('../conversations/ChannelBrowseDialog.js').then((m) => ({ default: m.ChannelBrowseDialog })));

const MOBILE_BREAKPOINT_PX = 720;
const EMPTY_RUNS: readonly ChatMessage[] = [];
const EMPTY_IDS: readonly string[] = [];

/**
 * Reap an abandoned deck-minted conversation. A backend-keyed tab EAGERLY
 * creates its BE session row (useSessionPersistence reset()/not_found recovery
 * — required to break the remount→404 loop), so a "New chat" closed without
 * ever being used would otherwise leave a permanent `0 messages` row in the
 * rail. On close/re-key of a deck-minted id: verify it is still empty
 * server-side, then best-effort delete. `isFresh` scopes the reap to ids this
 * deck minted (rail/library conversations are NEVER reaped); `isStreaming`
 * guards the send→persist race (a mid-turn close must never delete). All
 * failures no-op — a lingering empty row is just the pre-existing state.
 * Exported for tests.
 */
export async function reapEmptySession(opts: {
  sessionId: string;
  isFresh: boolean;
  isStreaming: boolean;
  countMessages: (sessionId: string) => Promise<number>;
  remove: (sessionId: string) => Promise<void>;
}): Promise<boolean> {
  const { sessionId, isFresh, isStreaming, countMessages, remove } = opts;
  if (!isFresh || isStreaming) return false;
  try {
    if ((await countMessages(sessionId)) > 0) return false;
    await remove(sessionId);
    return true;
  } catch {
    return false;
  }
}

/**
 * How long an empty plain chat may sit untouched before the mount-time sweep
 * deletes it. The close-time reap above is the primary cleanup; the sweep only
 * catches rows the reap missed (hard browser close, crash, cleared deck
 * persistence). The age guard exists because a `messageCount:0` row may be a
 * FRESH chat another window/device has open right now — deleting it would
 * retire that window's tab out from under the user.
 */
export const STALE_EMPTY_SESSION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * The stale-empty sweep's selection (pure, exported for tests): abandoned empty
 * chats the CALLER owns (`isAbandonedEmptyChat`, ADR 0978 D3) that nothing living
 * explains — not open as a tab here, not minted by this deck instance (the
 * close-time reap owns those), and untouched past the age guard. Channels, groups,
 * DMs, container-bound chats and meta-less legacy rows are never swept: the last
 * are tenant-visible, so sweeping them deleted other members' rows (MT2WF-2).
 */
export function selectStaleEmptySessions(opts: {
  conversations: readonly ChatSessionHeader[];
  openIds: ReadonlySet<string>;
  freshIds: ReadonlySet<string>;
  now: number;
  maxAgeMs: number;
}): ChatSessionHeader[] {
  const { conversations, openIds, freshIds, now, maxAgeMs } = opts;
  return conversations.filter((c) =>
    isAbandonedEmptyChat(c)
    && !openIds.has(c.sessionId)
    && !freshIds.has(c.sessionId)
    && now - Date.parse(c.updatedAt) >= maxAgeMs);
}

/** Move `from`'s entry to `to` (no-op when `from` has none). */
function moveKey<V>(map: Record<string, V>, from: string, to: string): Record<string, V> {
  if (!(from in map)) return map;
  const { [from]: value, ...rest } = map;
  return { ...rest, [to]: value as V };
}

interface TabChatDeckProps {
  config: BYOKActiveConfig;
  /** ADR 0711 OQ1 — threaded through to the compact provider card in every tab. */
  byokStored: boolean;
  /** Re-open the BYOK wizard (threaded from ChatTab — the deck doesn't own BYOK). */
  onReconfigureBYOK: () => void;
}

/**
 * ADR 0978 D4 — resolve the ACTIVE workspace before the deck restores, so the working
 * set is read and written per workspace (`${uid}@${workspace}`). Uses the single-flight
 * `ensureWireTenant` (usually warm from the v2 wire binding, so no extra request).
 * While unresolved the deck renders a busy placeholder — never the bootstrap, which
 * would mint a conversation into the wrong working set. Unresolvable (offline, signed
 * out) falls back to the legacy uid-only subject rather than refusing to render.
 */
export function TabChatDeck(props: TabChatDeckProps): JSX.Element {
  const { t } = useTranslation('chat');
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const [workspace, setWorkspace] = useState<string | null | undefined>(uid ? undefined : null);
  useEffect(() => {
    if (!uid) { setWorkspace(null); return; }
    let live = true;
    void ensureWireTenant(listMyWorkspaces).then((w) => { if (live) setWorkspace(w); });
    return () => { live = false; };
  }, [uid]);
  if (workspace === undefined) {
    return <div className="u-flex u-flex-1 u-minh-0" role="status" aria-busy="true" aria-label={t('multiTabLoadingDeck')} />;
  }
  const subject = uid ? workspaceDeckSubject(uid, workspace) : null;
  return <TabChatDeckInner key={subject ?? 'anon'} {...props} persistSubject={subject} legacySubject={uid} draftScope={uid ?? 'anon'} />;
}

function TabChatDeckInner({ config, byokStored, onReconfigureBYOK, persistSubject, legacySubject, draftScope }: TabChatDeckProps & {
  persistSubject: string | null;
  legacySubject: string | null;
  /** ADR 0978 D5 — the draft-key scope (the uid), as ChatSidebar's CS-FE-6. */
  draftScope: string;
}): JSX.Element {
  const { t } = useTranslation('chat');
  // Eviction toast (ADR 0140 P5 / TAB-5): the hook reads onEvict via a ref, so this thin
  // forwarder can reference the title resolver assigned later in render without a cycle.
  const evictHandlerRef = useRef<(sessionId: string) => void>(() => {});
  const busyCloseRef = useRef<(sessionId: string) => void>(() => {});
  const { tabs, activeSessionId, openTab: openTabRaw, canOpen: canOpenRaw, closeTab, focusTab, reorderTab, setPinned, rekeyTab, setTitle, restoredSessionIds, adoptedLegacy } =
    useTabDeck({
      persistSubject,
      legacySubject,
      onEvict: (sid) => evictHandlerRef.current(sid),
      // ADR 0978 D2 — the ceiling is absolute; say why nothing opened and the way out.
      onRefuse: () => toast.info(t('multiTabDeckFull')),
    });
  // ONE sessions collection for the whole deck (titles + participants), not one per
  // tab — avoids N backend list fetches. A conversation deleted in ANOTHER
  // window retires its tab here too (grade-pass RESIL-5) — same retirement the
  // local rail delete does; closeTab no-ops when the session isn't open.
  const sessions = useChatSessions({
    onSessionDeleted: (id) => {
      streamingRef.current.delete(id);
      busyRef.current.delete(id);
      freshSessionIdsRef.current.delete(id);
      closeTab(id);
    },
  });
  // Background-activity badges (ADR 0140 P5). Lives outside useTabDeck (it's a
  // projection over activity, not working-set membership). `reportActivity` is stable
  // so it doesn't defeat TabSession's memo; a badge change re-renders the deck + strip
  // but NOT the keep-alive TabSessions.
  const openIds = useMemo(() => tabs.map((tb) => tb.sessionId), [tabs]);
  // MTCU-201: a background tab gaining an unread reply / a blocked HITL interrupt is
  // ANNOUNCED to SR via the imperative `announce()` (the badge dot alone was silent — a
  // conditionally-mounted `role="status"` never speaks). The impl is set below (it needs
  // `titleFor`, defined later); a stable wrapper forwards through the ref so `useTabBadges`
  // stays memo-safe.
  const onBadgeRaiseRef = useRef<(sid: string, kind: 'unread' | 'blocked') => void>(() => {});
  const badges = useTabBadges(
    activeSessionId,
    openIds,
    useCallback((sid: string, kind: 'unread' | 'blocked') => onBadgeRaiseRef.current(sid, kind), []),
  );

  // ── Shared Conversations + Workflow + Reviews rail (ADR 0140 amend) ────────────────
  // The deck now mounts the PERSISTENT Conversations list too (reusing ConversationsRail,
  // Zone-1 lineup omitted — each tab owns its own). It opens on Conversations by default
  // (except mobile, where the rail overlays the chat) so the channel/chat list is visible
  // like Slack, instead of hidden behind a launcher button.
  const [activeRailTab, setActiveRailTab] = useState<LeftRailTab | null>(
    () => (typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT_PX ? null : 'conversations'),
  );
  const lastRailTabRef = useRef<LeftRailTab>('conversations');
  const selectRailTab = useCallback((tab: LeftRailTab | null) => {
    setActiveRailTab(tab);
    if (tab !== null) lastRailTabRef.current = tab;
  }, []);
  // Mobile (< 720) → the rail overlays the deck full-width (mirrors ChatSidebar).
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT_PX);
  useEffect(() => {
    const onResize = (): void => setIsMobile((prev) => {
      const next = window.innerWidth < MOBILE_BREAKPOINT_PX;
      return prev === next ? prev : next;
    });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Workflow runs lifted from each TabSession (P2). Runs of the ACTIVE tab drive the
  // Runs panel; cancel handlers are held in a ref (not render state) keyed by session.
  const [runsByTab, setRunsByTab] = useState<Record<string, readonly ChatMessage[]>>({});
  const cancelByTabRef = useRef<Record<string, (messageId: string) => Promise<void>>>({});
  const handleWorkflowRuns = useCallback((sid: string, runs: readonly ChatMessage[], cancel: (messageId: string) => Promise<void>) => {
    cancelByTabRef.current[sid] = cancel;
    setRunsByTab((prev) => (prev[sid] === runs ? prev : { ...prev, [sid]: runs }));
  }, []);
  const activeRuns = activeSessionId ? (runsByTab[activeSessionId] ?? EMPTY_RUNS) : EMPTY_RUNS;
  // ADR 0768 B4 — each tab reports its sources; the Workbench shows the active tab's.
  const [sourcesByTab, setSourcesByTab] = useState<Record<string, ConversationSources>>({});
  const handleSources = useCallback((sid: string, src: ConversationSources) => {
    setSourcesByTab((prev) => (prev[sid]?.key === src.key ? prev : { ...prev, [sid]: src }));
  }, []);
  const activeSources = activeSessionId ? (sourcesByTab[activeSessionId] ?? EMPTY_SOURCES) : EMPTY_SOURCES;

  // Focus + auto-open the Runs panel on a new dispatch in the ACTIVE tab. Focus resets on
  // tab switch (so the new tab's runs auto-focus), mirroring ChatSidebar's reconcile.
  const [focusedRunId, setFocusedRunId] = useState<string | null>(null);
  // ADR 0768 P2 — runs + artifacts open in the right-hand Workbench, not the rail.
  const workbench = useWorkbench(null);
  // ADR 0768 B4 — lets a turn's receipt open this shell's Sources tab.
  const selectWorkbenchTab = workbench.select; // stable (useCallback in useWorkbench)
  const workbenchActions = useMemo(() => ({ openSources: () => selectWorkbenchTab('sources') }), [selectWorkbenchTab]);
  const openWorkbenchRun = workbench.openRun;
  const closeRail = useCallback(() => setActiveRailTab(null), []);
  useMobilePaneArbitration(isMobile, activeRailTab !== null, workbench.tab !== null, closeRail, workbench.close);
  const seenRunIdsRef = useRef<Set<string>>(new Set());
  const prevActiveRef = useRef<string | null>(activeSessionId);
  useEffect(() => {
    // Tab switch — reset focus + reseed the seen-set with the new tab's existing runs so
    // pre-existing runs don't re-pop the panel.
    if (prevActiveRef.current !== activeSessionId) {
      prevActiveRef.current = activeSessionId;
      setFocusedRunId(null);
      seenRunIdsRef.current = new Set(activeRuns.map((m) => m.id));
      return;
    }
    const seen = seenRunIdsRef.current;
    const fresh = activeRuns.find((m) => !seen.has(m.id));
    if (fresh) {
      for (const m of activeRuns) seen.add(m.id);
      setFocusedRunId(fresh.id);
      openWorkbenchRun();
    }
  }, [activeRuns, activeSessionId, openWorkbenchRun]);
  // Reconcile: keep focus on an existing run (auto-focus the most-recent when stale).
  useEffect(() => {
    const stillExists = focusedRunId !== null && activeRuns.some((m) => m.id === focusedRunId);
    if (!stillExists) setFocusedRunId(activeRuns[0]?.id ?? null);
  }, [activeRuns, focusedRunId]);

  // ── Reviews (ADR 0068/0070) — the global review store, mirrors ChatSidebar ─────────
  const reviewCount = useReviewCount();
  const reviewCountsByConversation = useReviewCountsByConversation();
  // ADR 0776 P2 — closed conversations with a run in flight.
  const runningConversations = useRunningConversations();
  const connectReviews = useReviewStatusStore((s) => s.connect);
  const disconnectReviews = useReviewStatusStore((s) => s.disconnect);
  useEffect(() => {
    void connectReviews();
    return () => disconnectReviews();
  }, [connectReviews, disconnectReviews]);

  // Streaming set in a ref: the reap's send→persist race guard (an empty chat mid-
  // first-turn must never be deleted). Never drives a render.
  const streamingRef = useRef<Set<string>>(new Set());
  const handleStreamingChange = useCallback((sid: string, isSending: boolean) => {
    if (isSending) streamingRef.current.add(sid);
    else streamingRef.current.delete(sid);
  }, []);

  // ADR 0978 D1 — the eviction-protected set: a tab that is RUNNING (a turn streaming
  // or a workflow run in flight) or BLOCKED (waiting on the user) is never auto-evicted.
  // ONE source per tab: the same activity report the badges use (`running` already
  // includes isSending). Tabs with no live report (restored, never visited) fall back
  // to the server's signals the deck already loads — the review inbox (ADR 0776) and
  // the in-flight runs (ADR 0776 P2). Refs, read at open time: never a render driver.
  const busyRef = useRef<Set<string>>(new Set());
  const reportActivity = badges.reportActivity;
  const handleActivity = useCallback((sid: string, lastInboundId: string | null, blocked: boolean, running = false) => {
    if (blocked || running) busyRef.current.add(sid);
    else busyRef.current.delete(sid);
    reportActivity(sid, lastInboundId, blocked, running);
  }, [reportActivity]);
  const serverBusyRef = useRef<{ reviews: ReadonlyMap<string, number>; running: ReadonlySet<string> }>({ reviews: reviewCountsByConversation, running: runningConversations });
  serverBusyRef.current = { reviews: reviewCountsByConversation, running: runningConversations };
  const protectedIds = useCallback((): ReadonlySet<string> => {
    const out = new Set<string>(busyRef.current);
    for (const sid of streamingRef.current) out.add(sid);
    for (const [sid, n] of serverBusyRef.current.reviews) if (n > 0) out.add(sid);
    for (const sid of serverBusyRef.current.running) out.add(sid);
    return out;
  }, []);
  const openTab = useCallback((sid: string, kind?: string) => openTabRaw(sid, protectedIds(), kind), [openTabRaw, protectedIds]);
  const canOpen = useCallback((sid: string) => canOpenRaw(sid, protectedIds()), [canOpenRaw, protectedIds]);

  // Session ids MINTED by this deck (newTab + every re-key) — the only ids
  // eligible for the abandoned-empty reap below. Conversations opened from the
  // rail/library are never in this set, so they are never reaped.
  const freshSessionIdsRef = useRef<Set<string>>(new Set());

  const newTab = useCallback((): boolean => {
    const sid = crypto.randomUUID();
    if (!openTab(sid)) return false; // refused at the ceiling (ADR 0978 D2) — nothing minted
    freshSessionIdsRef.current.add(sid);
    return true;
  }, [openTab]);

  const featureVisible = useFeatureVisible();
  const newTabKinds = listDeckTabKinds()
    .filter((k) => featureVisible(k.featureId))
    .map((k) => ({ kind: k.kind, label: k.label() }));

  // ADR 0785 D5 — a registered non-conversation tab kind. Its id names no
  // conversation, so it is never in the deck-minted reap set.
  // ADR 0785 D5 follow-on — a kind may contribute a rail section (e.g. the user's
  // running Claude Code sessions), so its tabs stay findable after leaving the chat.
  // Same visibility rule as the New-tab menu: a hidden feature contributes nothing.
  // `seed` runs BEFORE the tab joins the deck, so the kind's Component reads the
  // pre-seeded state at mount (e.g. reattach to a running terminal).
  const openKindTab = useCallback((kind: string, opts?: { seed?: (tabId: string) => void; title?: string }) => {
    const id = `${kind}-${crypto.randomUUID()}`;
    // ADR 0978 /architect H1 — check BEFORE the seed: a refused open must not leave a
    // seeded kind state (e.g. a Claude Code reattach) for a tab that never exists.
    if (!canOpen(id)) { openTab(id, kind); return; } // the refusal path toasts
    opts?.seed?.(id);
    openTab(id, kind);
    if (opts?.title) setTitle(id, opts.title);
  }, [openTab, canOpen, setTitle]);
  const newTabOfKind = useCallback((kind: string) => openKindTab(kind), [openKindTab]);
  const kindTabIds = useMemo(() => {
    const byKind: Record<string, string[]> = {};
    for (const tb of tabs) if (tb.kind) (byKind[tb.kind] ??= []).push(tb.sessionId);
    return byKind;
  }, [tabs]);
  const railSectionKinds = listDeckTabKinds().filter((k) => k.RailSection && featureVisible(k.featureId));

  // Fire the reap for an id this deck is abandoning (tab close / re-key).
  // `.delete()` doubles as the one-shot claim; streaming is read BEFORE the
  // caller clears it. Fire-and-forget — the UI never waits on it.
  const reapIfAbandoned = useCallback((sid: string) => {
    void reapEmptySession({
      sessionId: sid,
      isFresh: freshSessionIdsRef.current.delete(sid),
      isStreaming: streamingRef.current.has(sid),
      countMessages: async (id) => (await listChatSessionMessagesPage(id, { limit: 1 })).messages.length,
      remove: sessions.remove,
    });
  }, [sessions]);

  const handleClose = useCallback((sid: string) => {
    const kindTab = tabs.find((tb) => tb.sessionId === sid)?.kind;
    if (kindTab) getDeckTabKind(kindTab)?.onClose?.(sid); // e.g. stop the terminal it shows
    // ADR 0978 D6 (round-1 MTCU-401) — closing a busy conversation does not stop it: the
    // run survives server-side and the rail shows it (ADR 0776 P2). Say where it went
    // instead of asking to confirm every close.
    else if (protectedIds().has(sid)) busyCloseRef.current(sid);
    reapIfAbandoned(sid); // reads the streaming set before it's cleared below
    streamingRef.current.delete(sid);
    busyRef.current.delete(sid);
    closeTab(sid);
    // Keyboard-close focus handoff to the neighbour tab is owned by TabStrip (it knows
    // the close was keyboard-initiated and refocuses the now-active tab).
  }, [closeTab, reapIfAbandoned, tabs, protectedIds]);

  // Rename a chat from its tab. Persists via the SAME path as the conversations rail
  // (`sessions.rename` → PATCH → `titleSource:'user'`), so a manual tab rename also stops
  // the ADR 0151 auto-titler from clobbering it; `setTitle` keeps the local restore cache
  // in sync so the new label paints first on reload (G4).
  const handleRename = useCallback(async (sid: string, title: string) => {
    // A kind tab (ADR 0785) names no conversation: its label is local only.
    if (!tabs.find((tb) => tb.sessionId === sid)?.kind) await sessions.rename(sid, title);
    setTitle(sid, title);
  }, [sessions, setTitle, tabs]);

  // `/clear` in a tab (or the mount-404 recovery of a brand-new tab) mints a new
  // session id; re-key the working set in place so the tab isn't stranded. The
  // NEW id gets an eagerly-created BE row, so it joins the deck-minted set; the
  // OLD id is being abandoned — reap it if it was deck-minted and never used
  // (previously it lingered in the sidebar as a `0 messages` row forever).
  //
  // Per-tab state keyed by session id moves with the tab. A `?agent=` tab is
  // minted client-side with no BE row, so its first history read 404s and the
  // recovery re-keys it; without the move the agent scope (and a launch
  // context) stayed on the abandoned id and the turn ran unscoped.
  const [agentScopes, setAgentScopes] = useState<Record<string, string>>({});
  const [launchContexts, setLaunchContexts] = useState<Record<string, string>>({});
  const handleSessionIdChange = useCallback((oldId: string, newId: string) => {
    freshSessionIdsRef.current.add(newId);
    reapIfAbandoned(oldId);
    streamingRef.current.delete(oldId);
    busyRef.current.delete(oldId);
    setAgentScopes((prev) => moveKey(prev, oldId, newId));
    setLaunchContexts((prev) => moveKey(prev, oldId, newId));
    rekeyTab(oldId, newId);
  }, [rekeyTab, reapIfAbandoned]);

  // The chat surface always has an active conversation (mirrors ChatSidebar): open
  // one tab on first mount when the working set is empty.
  const didBootstrapRef = useRef(false);
  useEffect(() => {
    if (didBootstrapRef.current || tabs.length > 0) return;
    didBootstrapRef.current = true;
    openTab(crypto.randomUUID());
  }, [tabs.length, openTab]);

  // Lazy-mount-then-keep-alive (ADR 0140 P6): a TabSession mounts only once its tab has
  // been activated, then STAYS mounted (keep-alive). On a restore that caps the cold
  // mount-load fan-out to the active tab (vs up to HARD_MAX_TABS parallel backend reads),
  // matching browser tab-restore; a never-streaming background tab needs no live stream.
  // A RESTORED tab must not mount (and fire its one-shot backend hydrate) until the
  // conversation list confirms it still exists. A stale persisted id (deleted,
  // rotated-anon, or reset demo backend) otherwise fires a doomed `messages` fetch
  // that 404s — in bulk across the restored deck (the dead-tab prune below runs only
  // AFTER those loads). Runtime-created tabs (not in restoredSessionIds) and
  // rail-clicked conversations are never gated; dead restored tabs are closed by the
  // prune before they ever become mountable. If the list FAILED to load (offline),
  // fall back to best-effort mount so a reload still shows the cached thread.
  const restoredSet = useMemo(() => new Set(restoredSessionIds), [restoredSessionIds]);
  const liveSessionIds = useMemo(
    () => (sessions.isLoading || sessions.error ? null : new Set(sessions.sessions.map((s) => s.sessionId))),
    [sessions.isLoading, sessions.error, sessions.sessions],
  );
  const isMountable = useCallback(
    (id: string): boolean => !restoredSet.has(id) || !!sessions.error || (liveSessionIds?.has(id) ?? false),
    [restoredSet, liveSessionIds, sessions.error],
  );
  const [mountedIds, setMountedIds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!activeSessionId || mountedIds.has(activeSessionId)) return;
    if (!isMountable(activeSessionId)) return; // restored tab awaiting list confirmation
    setMountedIds((prev) => new Set(prev).add(activeSessionId));
  }, [activeSessionId, mountedIds, isMountable]);
  // Alt+N (ADR 0978 D6): the new tab mounts one render later; focus its composer once
  // its panel is in the DOM (ConversationView always renders the composer).
  useEffect(() => {
    const sid = focusComposerForRef.current;
    if (!sid || sid === '__next__' || !mountedIds.has(sid)) return;
    focusComposerForRef.current = null;
    document.getElementById(tabPanelId(sid))?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
  }, [mountedIds]);
  // Prune ids that left the working set (close / rekey) so the set doesn't accumulate
  // stale entries over the deck's lifetime.
  useEffect(() => {
    setMountedIds((prev) => {
      const open = new Set(openIds);
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) { if (open.has(id)) next.add(id); else changed = true; }
      return changed ? next : prev;
    });
    // Drop lifted run state for closed tabs so the maps don't accumulate (P2).
    setRunsByTab((prev) => {
      const open = new Set(openIds);
      let changed = false;
      const next: Record<string, readonly ChatMessage[]> = {};
      for (const [id, runs] of Object.entries(prev)) { if (open.has(id)) next[id] = runs; else changed = true; }
      return changed ? next : prev;
    });
    for (const id of Object.keys(cancelByTabRef.current)) {
      if (!openIds.includes(id)) delete cancelByTabRef.current[id];
    }
  }, [openIds]);

  // Clear the SERVER-side unread marker when a conversation becomes the active tab
  // (mirrors ChatSidebar.selectConversation → markRead). Once per active-tab change, and
  // only for a conversation that exists server-side (a fresh new-tab id isn't persisted
  // yet). Best-effort.
  const lastMarkedReadRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeSessionId || lastMarkedReadRef.current === activeSessionId) return;
    if (!sessions.sessions.some((s) => s.sessionId === activeSessionId)) return;
    lastMarkedReadRef.current = activeSessionId;
    void sessions.markRead(activeSessionId);
  }, [activeSessionId, sessions]);

  // Dead-tab prune (ADR 0140 P6): once the conversation list has loaded SUCCESSFULLY,
  // drop any RESTORED tab whose conversation no longer exists (deleted server-side, or an
  // empty never-persisted tab). Guarded on a clean load so an offline/errored reload does
  // NOT nuke the deck; scoped to restored ids so runtime-created new tabs (not yet in the
  // list) are never pruned. One-shot.
  const didPruneRef = useRef(false);
  useEffect(() => {
    if (didPruneRef.current || restoredSessionIds.length === 0) return;
    if (sessions.isLoading || sessions.error) return;
    didPruneRef.current = true;
    const live = new Set(sessions.sessions.map((s) => s.sessionId));
    const dead = restoredSessionIds.filter((id) => !live.has(id));
    for (const id of dead) closeTab(id);
    // ADR 0978 D4 — the legacy uid-only descriptor was adopted into this workspace.
    // Forget it only when some of its tabs belong here; if none did, this was the
    // wrong workspace to adopt it into, so keep it for the one it belongs to.
    if (adoptedLegacy && legacySubject && dead.length < restoredSessionIds.length) forgetLegacyTabDeck(legacySubject);
    // Surface the removal (ux-review) — a restored tab disappearing post-paint with no
    // notice is jarring. Count > 0 only (an all-empty restore prunes silently-enough).
    // An adopted legacy set whose tabs ALL belong to another workspace is kept for that
    // workspace (ADR 0978 D4), so nothing was lost: no "removed" notice.
    const keptForAnotherWorkspace = adoptedLegacy && dead.length === restoredSessionIds.length;
    if (dead.length > 0 && !keptForAnotherWorkspace) toast.info(t('multiTabPrunedNotice', { count: dead.length }));
  }, [sessions.isLoading, sessions.error, sessions.sessions, restoredSessionIds, closeTab, t, adoptedLegacy, legacySubject]);

  // Stale-empty sweep: the close-time reap above only fires on a clean tab
  // close/re-key — a hard browser close (or crash) skips it, so the eagerly
  // created BE row survives as a permanent "New chat — 0 messages" conversation.
  // Once per mount, after a CLEAN list load: (a) ADOPT every open tab whose
  // conversation is an empty plain chat into the deck-minted set, so closing a
  // RESTORED empty tab reaps it too (the reap re-verifies emptiness server-side
  // at close time, so a chat used in the meantime is spared); (b) hard-delete
  // the stale leftovers nothing explains (selectStaleEmptySessions — age-guarded
  // so a fresh chat another window has open is never pulled out from under it).
  // Best-effort: a failed delete just leaves a row the rail filter hides.
  const didSweepRef = useRef(false);
  useEffect(() => {
    if (didSweepRef.current || sessions.isLoading || sessions.error) return;
    didSweepRef.current = true;
    const openIds = new Set(tabs.map((tb) => tb.sessionId));
    for (const c of sessions.sessions) {
      if (openIds.has(c.sessionId) && isAbandonedEmptyChat(c)) {
        freshSessionIdsRef.current.add(c.sessionId);
      }
    }
    const stale = selectStaleEmptySessions({
      conversations: sessions.sessions,
      openIds,
      freshIds: freshSessionIdsRef.current,
      now: Date.now(),
      maxAgeMs: STALE_EMPTY_SESSION_MAX_AGE_MS,
    });
    for (const c of stale) void sessions.remove(c.sessionId).catch(() => { /* best-effort */ });
  }, [sessions.isLoading, sessions.error, sessions.sessions, sessions, tabs]);

  // Deck-level keyboard shortcuts (ADR 0140 P7) — Alt-based (browser-safe). Read the
  // latest tabs/active via a ref so the handlers stay stable.
  const navRef = useRef({ tabs, activeSessionId });
  navRef.current = { tabs, activeSessionId };
  // ADR 0978 D6 (round-1 MTCU-101/102) — a deck KEYBOARD action moves DOM focus with
  // it: Alt+1..9 / Alt+W land on the newly active tab button (the APG tablist contract
  // the strip already honours for Delete), Alt+N on the new tab's composer. Requests
  // are flags consumed by the effects below, after the tab is active / mounted. A mouse
  // action sets none, so it never steals focus.
  const focusTabButtonRef = useRef(false);
  const focusComposerForRef = useRef<string | null>(null);
  const focusTabButton = useCallback((sid: string): void => {
    document.getElementById(tabButtonId(sid))?.focus();
  }, []);
  const jumpTo = useCallback((i: number) => {
    const tab = navRef.current.tabs[i];
    if (!tab) return;
    if (tab.sessionId === navRef.current.activeSessionId) { focusTabButton(tab.sessionId); return; }
    focusTabButtonRef.current = true;
    focusTab(tab.sessionId);
  }, [focusTab, focusTabButton]);
  const closeActive = useCallback(() => {
    if (!navRef.current.activeSessionId) return;
    focusTabButtonRef.current = true;
    handleClose(navRef.current.activeSessionId);
  }, [handleClose]);
  const newTabFromKeyboard = useCallback(() => {
    if (newTab()) focusComposerForRef.current = '__next__';
  }, [newTab]);
  // Alt+Shift+Arrow → move the active tab one slot. reorderTab's toIndex is the final
  // index in the post-removal order, so active index ± 1 is exactly one slot (it no-ops
  // at either edge — see reorderTab's clamp).
  const moveActive = useCallback((delta: -1 | 1) => {
    const { tabs: navTabs, activeSessionId: active } = navRef.current;
    if (!active) return;
    const i = navTabs.findIndex((tb) => tb.sessionId === active);
    if (i < 0) return;
    reorderTab(active, i + delta);
  }, [reorderTab]);
  const togglePinActive = useCallback(() => {
    const { tabs: navTabs, activeSessionId: active } = navRef.current;
    const tab = navTabs.find((tb) => tb.sessionId === active);
    if (tab) setPinned(tab.sessionId, !tab.pinned);
  }, [setPinned]);
  useDeckShortcuts({ onNewTab: newTabFromKeyboard, onCloseActive: closeActive, onJumpTo: jumpTo, onMoveActive: moveActive, onTogglePinActive: togglePinActive });
  useEffect(() => {
    if (!activeSessionId) { focusTabButtonRef.current = false; return; }
    if (focusComposerForRef.current === '__next__') focusComposerForRef.current = activeSessionId;
    if (focusTabButtonRef.current) {
      focusTabButtonRef.current = false;
      focusTabButton(activeSessionId);
    }
  }, [activeSessionId, focusTabButton]);

  // Library → tab (ADR 0140 P7): open EXISTING conversations as tabs.
  const [showCreateChannel, setShowCreateChannel] = useState(false); // ADR 0154 FU-1
  const [showBrowseChannels, setShowBrowseChannels] = useState(false); // ADR 0154 FU-4
  const openConversation = useCallback((sid: string) => { openTab(sid); }, [openTab]);

  // Pop out a conversation into a new browser window (ADR 0140 G6 — the light deep-link;
  // full single-conversation pop-out is deferred). The new window loads the deck and
  // focuses this conversation via ?conversation=. Only persisted conversations have a
  // stable id to deep-link to (canPopOut gates the control for brand-new tabs).
  const popOutTab = useCallback((sid: string) => {
    const url = `${window.location.pathname}?conversation=${encodeURIComponent(sid)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  // Deep-link `?conversation=<id>` → open-or-focus a tab (mirrors ChatSidebar; openTab
  // dedupes so a deep-link onto a restored deck focuses, never duplicates). One-shot +
  // clears the param so reload/back doesn't re-trigger.
  const [searchParams, setSearchParams] = useSearchParams();
  const didDeepLinkRef = useRef(false);
  useEffect(() => {
    if (didDeepLinkRef.current) return;
    const wanted = searchParams.get('conversation');
    if (!wanted || sessions.isLoading) return;
    if (!sessions.sessions.some((s) => s.sessionId === wanted)) return; // not a known conversation (yet)
    didDeepLinkRef.current = true;
    openTab(wanted);
    const next = new URLSearchParams(searchParams);
    next.delete('conversation');
    setSearchParams(next, { replace: true });
  }, [searchParams, sessions.isLoading, sessions.sessions, openTab, setSearchParams]);

  // Deep-link `?agent=<id>` → open a NEW tab scoped to that agent (ADR 0140 G3). There's
  // no "the tab for agent X" (multiple tabs can mention one agent), so always open fresh.
  // ADR 0896 IL2UX-2 — EXCEPT when the link also names `?conversation=`: then the agent
  // scopes THAT conversation's tab (the `?conversation=` effect above opens/focuses it).
  // A fresh tab would be a different conversation, so whatever the agent does for "this
  // conversation" (e.g. drafting its mission contract) would land on the wrong one.
  // One-shot + clears the param.
  const didAgentLinkRef = useRef(false);
  useEffect(() => {
    if (didAgentLinkRef.current) return;
    const wantedAgent = searchParams.get('agent');
    if (!wantedAgent) return;
    didAgentLinkRef.current = true;
    const wantedConversation = searchParams.get('conversation');
    const id = wantedConversation ?? crypto.randomUUID();
    // A refused fresh tab (ADR 0978 D2) records no scope for an id that never opens.
    if (wantedConversation || openTab(id)) setAgentScopes((prev) => ({ ...prev, [id]: wantedAgent }));
    const next = new URLSearchParams(searchParams);
    next.delete('agent');
    setSearchParams(next, { replace: true });
  }, [searchParams, openTab, setSearchParams]);

  // ADR 0785 D5 — deep-link `?newTab=<kind>&tabContext=<text>` → open a NEW tab of a
  // registered kind, handing it the context once (e.g. the ⌘K "Open in Claude Code"
  // on a workflow page). An unknown or unavailable kind is ignored, never forced.
  // One-shot + strips both params, like the siblings above.
  const newTabParamHandled = useRef<string | null>(null);
  useEffect(() => {
    const kind = searchParams.get('newTab');
    if (!kind || newTabParamHandled.current === kind) return;
    newTabParamHandled.current = kind;
    const next = new URLSearchParams(searchParams);
    const context = next.get('tabContext');
    next.delete('newTab');
    next.delete('tabContext');
    setSearchParams(next, { replace: true });
    const k = getDeckTabKind(kind);
    if (!k || !featureVisible(k.featureId)) return;
    const id = `${kind}-${crypto.randomUUID()}`;
    if (!openTab(id, kind)) return; // refused (ADR 0978 D2) — no launch context left behind
    if (context) setLaunchContexts((prev) => ({ ...prev, [id]: context.slice(0, 4000) }));
  }, [searchParams, setSearchParams, openTab, featureVisible]);

  // Deep-link `?rail=<tab>` → select a rail (ENG-14). The last member of the
  // ChatSidebar deep-link family the deck did not consume; `?agent=` and
  // `?conversation=` above already had parity. Without this, a feature CTA that
  // lands on a specific rail (the Studio publication link → the reviews inbox)
  // silently drops its intent when the multi-tab deck is the active chrome, and
  // the user arrives on whatever tab localStorage last held.
  //
  // Validated against the DECK's own rail state, not the sidebar's: the allowed
  // values are exactly this component's `LeftRailTab` union, so an unknown or
  // stale value is ignored rather than forced into a tab that does not exist.
  // Read-once + strip, matching the two effects above, so reload/back/share does
  // not re-trigger and the URL stays clean.
  const railParamHandled = useRef<string | null>(null);
  useEffect(() => {
    const wanted = searchParams.get('rail');
    if (!wanted || railParamHandled.current === wanted) return;
    railParamHandled.current = wanted;
    // `progress` is a deep-link alias for the Workbench Run tab (ADR 0768 P2).
    if (wanted === 'progress') openWorkbenchRun();
    else if (wanted === 'conversations' || wanted === 'reviews') selectRailTab(wanted);
    const next = new URLSearchParams(searchParams);
    next.delete('rail');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, selectRailTab, openWorkbenchRun]);

  // Cache each tab's real title once the conversation list loads, so a reload restores
  // the real label at first paint (ADR 0140 G4) instead of flashing "New chat". setTitle
  // is identity-preserving (no churn when unchanged).
  useEffect(() => {
    for (const tab of tabs) {
      const realTitle = sessions.sessions.find((s) => s.sessionId === tab.sessionId)?.title;
      if (realTitle && realTitle !== tab.lastTitle) setTitle(tab.sessionId, realTitle);
    }
  }, [tabs, sessions.sessions, setTitle]);

  const titleFor = (sid: string): string =>
    sessions.sessions.find((s) => s.sessionId === sid)?.title
    || tabs.find((tb) => tb.sessionId === sid)?.lastTitle
    || t('multiTabNewTab');

  // MTCU-201: name the tab in the SR announcement (also closes MTCU-202). Blocked (a HITL
  // interrupt awaiting the user) is assertive; a new reply is polite.
  onBadgeRaiseRef.current = (sid, kind): void => {
    announce(
      kind === 'blocked'
        ? t('multiTabBlockedAnnounce', { title: titleFor(sid) })
        : t('multiTabUnreadAnnounce', { title: titleFor(sid) }),
      { assertive: kind === 'blocked' },
    );
  };

  // Resolve the evicted tab's title at eviction time (the victim still exists in the
  // working set when openTab fires onEvict, so titleFor finds it) and surface it.
  evictHandlerRef.current = (sid: string): void => {
    toast.info(t('tabEvicted', { title: titleFor(sid) }));
  };
  busyCloseRef.current = (sid: string): void => {
    toast.info(t('multiTabClosedBusy', { title: titleFor(sid) }));
  };

  // The per-tab badge slot (fixed width so it never shifts the tab layout): a clay dot
  // for unread, a higher-urgency amber dot for a blocked HITL interrupt.
  const renderStatus = useCallback((sid: string) => {
    const b = badges.statusFor(sid);
    const kind = b.blocked ? 'blocked' : b.running ? 'running' : b.unread ? 'unread' : null;
    const label = kind === 'blocked' ? t('multiTabBlockedAria') : kind === 'running' ? t('multiTabRunningAria') : kind === 'unread' ? t('multiTabUnreadAria') : undefined;
    // A labeled GRAPHIC (role="img"), NOT a live region: a conditionally-mounted
    // `role="status"` never announced (MTCU-201) — the live notification now rides the
    // imperative `announce()` on the rising edge (see onBadgeRaiseRef). This label is
    // read when a user navigates ONTO the tab.
    return (
      <span
        className="tabdeck-tab__badge"
        {...(kind ? { 'data-kind': kind } : {})}
        {...(label ? { 'aria-label': label, role: 'img', title: label } : { 'aria-hidden': true })}
      />
    );
  }, [badges, t]);

  // Blocked (HITL-waiting) tabs — for the off-screen edge cue (ADR 0140 G5): when one is
  // scrolled out of the overflowing strip, the user can't see its badge.
  const blockedSids = useMemo(
    () => new Set(tabs.filter((tb) => badges.statusFor(tb.sessionId).blocked).map((tb) => tb.sessionId)),
    [tabs, badges],
  );

  // Hide empty (messageCount:0) conversations from the rail unless they are open
  // as a tab — an abandoned "New chat" never earns a slot (parity with
  // ChatSidebar's visibleConversations; the deck previously passed the list
  // through unfiltered, so un-reaped empties showed forever). Display guard
  // only; the sweep above owns the actual deletion.
  const visibleConversations = useMemo(() => {
    const openIds = new Set(tabs.map((tb) => tb.sessionId));
    return sessions.sessions.filter((s) => s.messageCount > 0 || openIds.has(s.sessionId));
  }, [sessions.sessions, tabs]);

  return (
    <WorkbenchActionsContext.Provider value={workbenchActions}>
    <div className="u-flex u-flex-1 u-minh-0 u-overflow-hidden u-relative">
      {/* Shared rail (ADR 0140 amend) — the persistent Conversations list is now
          mounted here (reusing ConversationsRail, Zone-1 lineup omitted). Selecting a
          row opens/focuses a tab; selection is an ECHO of the tab strip (which owns
          "what's open"). Channel create/browse reuse the deck's existing dialogs. */}
      <LeftRail
        activeTab={activeRailTab}
        onSelectTab={selectRailTab}
        isMobile={isMobile}
        conversationsProps={{
          conversations: visibleConversations,
          isLoading: sessions.isLoading,
          error: sessions.error,
          activeSessionId,
          selectionEcho: true,
          // ADR 0768 P3 — open tabs' live state echoes onto their rows.
          liveStatusFor: (sid: string) => {
            // Open tabs: their live client state. Every conversation (closed ones
            // too): the review inbox (ADR 0776) and the server's in-flight runs
            // (ADR 0776 P2). Waiting-on-you wins over running.
            const b = badges.statusFor(sid);
            if (b.blocked || reviewCountsByConversation.get(sid)) return 'blocked';
            return b.running || runningConversations.has(sid) ? 'running' : null;
          },
          onRefresh: sessions.refresh,
          onSelect: openConversation,
          onRename: sessions.rename,
          // Deleting a conversation must also retire its OPEN tab — the dead-tab
          // prune above is one-shot at boot (restored ids only) and never covers a
          // runtime delete, which previously left a tab pointing at a dead session.
          onDelete: async (id: string) => {
            await sessions.remove(id);
            streamingRef.current.delete(id);
            busyRef.current.delete(id);
            freshSessionIdsRef.current.delete(id);
            closeTab(id); // no-op when the conversation isn't open as a tab
          },
          onNewChat: () => { newTab(); selectRailTab(isMobile ? null : activeRailTab); },
          onOpenWorkspace: () => {
            void (async () => {
              const conv = await sessions.openWorkspace();
              if (conv) openConversation(conv.sessionId);
            })();
          },
          onCreateChannel: () => setShowCreateChannel(true),
          onBrowseChannels: () => setShowBrowseChannels(true),
          ...(railSectionKinds.length > 0 ? {
            extraSections: railSectionKinds.map((k) => {
              const Section = k.RailSection!;
              return (
                <Section
                  key={k.kind}
                  openTabIds={kindTabIds[k.kind] ?? EMPTY_IDS}
                  activeTabId={activeSessionId}
                  focusTab={(id) => { focusTab(id); if (isMobile) selectRailTab(null); }}
                  openNewTab={(opts) => { openKindTab(k.kind, opts); if (isMobile) selectRailTab(null); }}
                />
              );
            }),
          } : {}),
        }}
        reviewsProps={{
          onOpenArtifact: (artifactId, revisionId) => workbench.openArtifact({ artifactId, ...(revisionId ? { revisionId } : {}) }),
        }}
        reviewsBadgeCount={reviewCount}
      />
      <div className="u-flex-1 u-flex u-flex-col u-minw-0">
      {/* The APG tablist strip (P4). Tab order = insertion/manual-reorder order, never
          recency-sorted. */}
      {tabs.length > 0 ? (
        <TabStrip
          tabs={tabs}
          activeSessionId={activeSessionId}
          titleFor={titleFor}
          onFocus={focusTab}
          onClose={handleClose}
          onRename={handleRename}
          onReorder={reorderTab}
          onSetPinned={setPinned}
          onNewTab={newTab}
          newTabKinds={newTabKinds}
          onNewTabOfKind={newTabOfKind}
          onToggleRail={() => selectRailTab(activeRailTab === null ? lastRailTabRef.current : null)}
          railOpen={activeRailTab !== null}
          railBadgeCount={reviewCount}
          {...(activeRuns.length > 0 || workbench.artifact ? {
            onToggleWorkbench: () => (workbench.tab ? workbench.close() : workbench.select(workbench.artifact ? 'artifact' : 'run')),
            workbenchOpen: workbench.tab !== null,
            workbenchBadgeCount: activeRuns.length,
          } : {})}
          renderStatus={renderStatus}
          blockedSids={blockedSids}
          onPopOut={popOutTab}
          canPopOut={(sid) => sessions.sessions.some((s) => s.sessionId === sid)}
        />
      ) : null}

      {showCreateChannel ? (
        <Suspense fallback={null}>
          <ChannelCreateDialog
            onClose={() => setShowCreateChannel(false)}
            onCreated={(channelId) => { void (async () => { await sessions.refresh(); openConversation(channelId); })(); }}
          />
        </Suspense>
      ) : null}
      {showBrowseChannels ? (
        <Suspense fallback={null}>
          <ChannelBrowseDialog
            onClose={() => setShowBrowseChannels(false)}
            onOpen={openConversation}
            onJoined={(channelId) => { void (async () => { await sessions.refresh(); openConversation(channelId); })(); }}
          />
        </Suspense>
      ) : null}

      {/* Keep-alive stack — every tab stays mounted; inactive ones hidden (display:none).
          Each is a `role="tabpanel"` wired back to its tab (Decision 5). */}
      <div className="u-flex u-flex-col u-flex-1 u-minh-0">
        {tabs.length === 0 ? (
          <StateCard
            icon={<PlusIcon />}
            title={t('multiTabEmptyTitle')}
            body={t('multiTabEmptyBody')}
            action={
              <Button variant="primary" size="sm" onClick={() => { newTab(); }}>
                {t('multiTabNewTab')}
              </Button>
            }
          />
        ) : (
          tabs.map((tab) => {
            const isActive = tab.sessionId === activeSessionId;
            const header = sessions.sessions.find((s) => s.sessionId === tab.sessionId);
            const participants = header?.participants;
            const ownerSubject = header?.ownerSubject;
            const client = header?.client;
            const scopeAgentId = agentScopes[tab.sessionId];
            return (
              <div
                key={tab.sessionId}
                id={tabPanelId(tab.sessionId)}
                role="tabpanel"
                aria-labelledby={tabButtonId(tab.sessionId)}
                className="u-flex u-flex-col u-flex-1 u-minh-0"
                style={{ display: isActive ? undefined : 'none' }}
              >
                {/* Mount only once visited (lazy-mount), then keep alive. */}
                {mountedIds.has(tab.sessionId) && tab.kind ? (
                  (() => {
                    const k = getDeckTabKind(tab.kind);
                    if (!k || !featureVisible(k.featureId)) {
                      // A persisted tab whose kind this build does not ship (excluded by
                      // the distribution), or whose feature is now turned off: say so,
                      // and never mount its Component (ADR 0978 D5 — before this only the
                      // first case was caught, so a turned-off feature kept running).
                      return (
                        <StateCard
                          announce
                          icon={<PlusIcon />}
                          title={t('multiTabKindUnavailable')}
                          action={<Button variant="secondary" size="sm" onClick={() => handleClose(tab.sessionId)}>{t('multiTabCloseTabNamed', { title: titleFor(tab.sessionId) })}</Button>}
                        />
                      );
                    }
                    const Kind = k.Component;
                    return (
                      <Kind
                        tabId={tab.sessionId}
                        active={isActive}
                        setTitle={(title) => setTitle(tab.sessionId, title)}
                        close={() => handleClose(tab.sessionId)}
                        {...(launchContexts[tab.sessionId] ? { launchContext: launchContexts[tab.sessionId] } : {})}
                      />
                    );
                  })()
                ) : mountedIds.has(tab.sessionId) ? (
                  <TabSession
                    byokStored={byokStored}
                    tenantId={draftScope}
                    sessionId={tab.sessionId}
                    config={config}
                    {...(participants ? { participants } : {})}
                    {...(header?.type ? { conversationType: header.type } : {})}
                    // ADV-UX-1 — the deck is the second primary surface; the
                    // disclaimer must reach it too, not only ChatSidebar.
                    {...(header?.boardId ? { boardId: header.boardId } : {})}
                    onSessionIdChange={handleSessionIdChange}
                    onStreamingChange={handleStreamingChange}
                    onActivity={handleActivity}
                    onAddParticipant={sessions.addParticipant}
                    onRemoveParticipant={sessions.removeParticipant}
                    onAttachBoard={sessions.attachBoard}
                    {...(ownerSubject ? { ownerSubject } : {})}
                    {...(client ? { client } : {})}
                    {...(scopeAgentId ? { scopeAgentId } : {})}
                    onReconfigureBYOK={onReconfigureBYOK}
                    onWorkflowRuns={handleWorkflowRuns}
                    onSources={handleSources}
                    onOpenConversation={openConversation}
                    refreshConversations={sessions.refresh}
                    onRequestClose={() => handleClose(tab.sessionId)}
                    onOpenArtifact={workbench.openArtifact}
                  />
                ) : null}
              </div>
            );
          })
        )}
      </div>
      </div>
      <Workbench
        tab={workbench.tab}
        onSelectTab={workbench.select}
        onClose={workbench.close}
        isMobile={isMobile}
        sources={activeSources}
        runProps={{
          workflowRunMessages: activeRuns,
          focusedMessageId: focusedRunId,
          onFocus: setFocusedRunId,
          onCancel: (id) => (activeSessionId ? (cancelByTabRef.current[activeSessionId]?.(id) ?? Promise.resolve()) : Promise.resolve()),
        }}
        artifact={workbench.artifact}
        onCloseArtifact={() => workbench.closeArtifact(activeRuns.length > 0)}
      />
    </div>
    </WorkbenchActionsContext.Provider>
  );
}
