/**
 * Chat sidebar — the full chat surface. Three zones (header / feed /
 * input) inside a vertical flex container.
 */

import { Button } from '../ui/Button.js';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChatHeader } from './ChatHeader.js';
import { listOrgs } from '../client/promptLibraryClient.js';
import { registerPromptCommands } from './promptCommands.js';
import { ConversationView } from './ConversationView.js';
import { LeftRail, type LeftRailTab } from './leftRail/LeftRail.js';
// ADR budget reclaim — the artifact workbench is a modal (renders only when an
// artifact is opened); lazy-split it + its diff/revision/provenance panels out of the
// eager chat entry chunk (the PR #804/#808 pattern).
const ArtifactWorkbench = lazy(() => import('./artifacts/ArtifactWorkbench.js').then((m) => ({ default: m.ArtifactWorkbench })));
// ADR 0117 Phase 3 — the read-only side-by-side compare view; lazy (zero entry-budget).
const CompareView = lazy(() => import('./CompareView.js').then((m) => ({ default: m.CompareView })));
// ADR 0154 — channel-only chrome; lazy so it (and channelsClient's SSE code)
// stays out of the eager chat entry chunk (only loads when a channel is open).
const ChannelPresenceBar = lazy(() => import('./conversations/ChannelPresenceBar.js').then((m) => ({ default: m.ChannelPresenceBar })));
// ADR 0140 follow-on — the right-docked members pane (shared with the deck), lazy.
const MembersPane = lazy(() => import('./conversations/MembersPane.js').then((m) => ({ default: m.MembersPane })));
// ADR 0154 Phase 2 — channel management chrome, lazy (only mounts on demand).
const ChannelCreateDialog = lazy(() => import('./conversations/ChannelCreateDialog.js').then((m) => ({ default: m.ChannelCreateDialog })));
const ChannelBrowseDialog = lazy(() => import('./conversations/ChannelBrowseDialog.js').then((m) => ({ default: m.ChannelBrowseDialog })));
const ChannelManageDialog = lazy(() => import('./conversations/ChannelManageDialog.js').then((m) => ({ default: m.ChannelManageDialog })));
// ADR 0192 — channel-only empty state, lazy (entry-budget posture).
const ChannelEmptyState = lazy(() => import('./conversations/ChannelEmptyState.js').then((m) => ({ default: m.ChannelEmptyState })));
import { useReviewStatusStore, useReviewCount } from './reviews/reviewStatusStore.js';
import { DEFAULT_ASSISTANT_ID } from './activeAgents/constants.js';
import { useScopeToAgent } from './activeAgents/useScopeToAgent.js';
import { SparklesIcon } from '../ui/icons/index.js';
import { toast } from '../ui/toast.js';
import { useChatSession } from './hooks/useChatSession.js';
import { useCommentsContext } from './hooks/useCommentsContext.js';
import { useChatSessions } from './hooks/useChatSessions.js';
import { useComposerModifiers } from './hooks/useComposerModifiers.js';
import { useConversationActions } from './hooks/useConversationActions.js';
import { registerDefaultCommands } from './registry/defaultCommands.js';
import { resolveActiveModel } from '../byok/lib/providers.js';
import type { BYOKActiveConfig } from '../byok/lib/useBYOKConfig.js';
import type { ContentPart } from './hooks/useChatSession.js';
import { runCoreSubmit } from './lib/chatSubmit.js';
// Entry-weight: the reviews strip pulls the whole review-card tree (~16 kB min
// after the ADR 0478 HITL additions) — lazy so the chat entry stays light; the
// cheap count store above stays eager for the badge.
const ConversationReviewsStrip = lazy(() =>
  import('./reviews/ConversationReviewsStrip.js').then((m) => ({ default: m.ConversationReviewsStrip })));
import { useAgentMentions } from './lib/agentMentions.js';
import { buildBoardInterceptor, buildProjectConveneInterceptor, runProjectConvene, type ConveneDeps } from './conversations/convene.js';
import { useBoardroomCadence } from './conversations/useBoardroomCadence.js';
import { participantsToLineup } from './conversations/participantLineup.js';
import { useChannelMessageStream } from './conversations/useChannelMessageStream.js';
import { useChannelRoster } from './conversations/useChannelRoster.js';
import { useChannelMessageActions } from './conversations/useChannelMessageActions.js';
import { submitChannelPost } from './conversations/channelSubmit.js';
import { useNotificationStore } from '../notifications/notificationStore.js';
import { confirm } from '../ui/confirm.js';

// localStorage keys for rail persistence — keeps the user's "which
// tab" / "which run is focused" choice across page reloads.
// Tenant-suffixed so two tenants signed in on the same browser
// (anon → signed-in transition, or a shared-machine demo) don't see
// each other's state leak into their UI.
const LS_RAIL_TAB_PREFIX = 'openwop-app.chat.leftRail.activeTab';
const LS_PROGRESS_FOCUSED_PREFIX = 'openwop-app.chat.progressPanel.focusedRunMsgId';
const MOBILE_BREAKPOINT_PX = 720;

function railTabKey(tenantId: string): string {
  return `${LS_RAIL_TAB_PREFIX}:${tenantId}`;
}
function progressFocusedKey(tenantId: string): string {
  return `${LS_PROGRESS_FOCUSED_PREFIX}:${tenantId}`;
}

function readRailTabFromStorage(tenantId: string): LeftRailTab | null {
  try {
    // Grade-ux fix (CS-FE-6 follow-up) — one-time migration: prefs written
    // under the old shared 'demo' scope move to the caller's scope on first
    // read, instead of silently resetting every returning user's rail tab.
    if (tenantId !== 'demo' && localStorage.getItem(railTabKey(tenantId)) === null) {
      const legacy = localStorage.getItem(railTabKey('demo'));
      if (legacy !== null) {
        localStorage.setItem(railTabKey(tenantId), legacy);
        localStorage.removeItem(railTabKey('demo'));
      }
    }
    const v = localStorage.getItem(railTabKey(tenantId));
    if (v === 'progress') return 'progress';
    if (v === 'reviews') return 'reviews';
    // Any prior tab id (the retired 'history'/'agents', or 'conversations')
    // maps to the single Conversations rail that replaced them (ADR 0043
    // legacy-drawer retirement).
    if (v === 'conversations' || v === 'history' || v === 'agents') return 'conversations';
    return null;
  } catch { return null; }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* quota / disabled — ignore */ }
}

/** Drop tenant-suffixed rail keys that don't match the current
 *  tenant. Switching identity in the same browser would otherwise
 *  leave the old tenant's entries behind forever. Called once on
 *  mount per ChatSidebar instance. */
function pruneStalePanelKeys(currentTenantId: string): void {
  try {
    const keep = new Set([
      railTabKey(currentTenantId),
      progressFocusedKey(currentTenantId),
    ]);
    const prefixes = [
      `${LS_RAIL_TAB_PREFIX}:`,
      `${LS_PROGRESS_FOCUSED_PREFIX}:`,
    ];
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (prefixes.some((p) => key.startsWith(p)) && !keep.has(key)) {
        toRemove.push(key);
      }
    }
    for (const key of toRemove) localStorage.removeItem(key);
  } catch { /* quota / disabled — ignore */ }
}

// Ensure built-in commands are registered before first render.
registerDefaultCommands();

interface Props {
  config: BYOKActiveConfig;
  /** ADR 0711 OQ1 — false when `config` is the effective managed default. */
  byokStored?: boolean;
  onOpenSettings: () => void;
  onRemoveKey: () => void | Promise<void>;
  tenantId?: string;
}

// CS-FE-6 (conversation-stack audit) — `tenantId` scopes ONLY the local UI
// preference keys (rail tab, progress focus); it feeds no API call. ChatTab
// now passes the signed-in user's uid so preferences stop sharing one 'demo'
// bucket across every user of a browser profile; 'anon' is the signed-out
// fallback (matching TabChatDeck's keying).
export function ChatSidebar({ config, byokStored, onOpenSettings, onRemoveKey, tenantId = 'anon' }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  const { session, isSending, thinkingAgentId, error, send, cancel, emitSystem, upsertTranscriptTurn, refreshNewestMessages, reset, resolveInterrupt, runWorkflowMention, cancelWorkflowRun, regenerate, setFeedback, loadSessionFromBackend, hasOlderMessages, isLoadingEarlier, loadEarlierMessages, activeAgents } = useChatSession();
  // ADR 0116 Phase 3c — when the prompt library is enabled, register the org's
  // prompts as `/p-<slug>` slash commands (best-effort; scoped to the primary org).
  // They surface in the existing SlashAutocomplete — no bespoke composer affordance.
  const promptsAccess = { enabled: true }; // always-on
  const exportAccess = { enabled: true }; // always-on
  const commentsContext = useCommentsContext(); // ADR 0021 ext — inline per-message comments (null when off/no org)
  useEffect(() => {
    if (!promptsAccess.enabled) return;
    void (async () => {
      try {
        const orgId = (await listOrgs())[0]?.orgId;
        if (orgId) await registerPromptCommands(orgId);
      } catch { /* prompts are an optional surface — ignore a fetch failure */ }
    })();
  }, [promptsAccess.enabled]);
  // Stable regenerate handler (GAP-ANALYSIS E14): an inline arrow here made a
  // new function each render, defeating MessageBubble's memo. useCallback keeps
  // it referentially stable across streaming tokens (config is unchanged
  // mid-stream) so settled bubbles skip re-render.
  const onRegenerate = useCallback((id: string) => { void regenerate(id, config); }, [regenerate, config]);
  // Agent catalog — read once at mount, used by the submit-path's
  // `@`-mention detection (phase D3). The `AgentMentionAutocomplete`
  // popover refetches independently; both consumers pay the same
  // /v1/agents round-trip but cached results bake themselves out in
  // the SDK fetch layer.
  const { entries: agentEntries } = useAgentMentions();
  // Deep-link: a "Chat with <persona>" affordance elsewhere (e.g. the agent
  // dashboard / roster cards) navigates to `/?agent=<agentId|slug>`. When that
  // param is present AND the agent catalog has loaded, pre-activate the matching
  // agent so the chat opens already routed to it, then strip the param so a
  // refresh doesn't re-activate and the URL stays clean. Entry-gated: an
  // unknown/legacy id simply no-ops (the catalog re-runs this effect as it
  // loads, so an early mount before `agentEntries` arrives still resolves).
  // Read the `?agent=` deep-link ONCE per value into local state and strip the
  // param immediately; useScopeToAgent (ADR 0073 Phase 2) owns the entry-gated,
  // once-only activation so a refresh doesn't re-activate and the URL stays clean.
  // The id lives in component state, not the URL, so stripping it can't race the
  // catalog still loading.
  const [searchParams, setSearchParams] = useSearchParams();
  const [scopeAgentId, setScopeAgentId] = useState<string | null>(null);
  useScopeToAgent(activeAgents, agentEntries, scopeAgentId);
  const agentParamHandled = useRef<string | null>(null);
  useEffect(() => {
    const wanted = searchParams.get('agent');
    if (!wanted || agentParamHandled.current === wanted) return;
    agentParamHandled.current = wanted;
    setScopeAgentId(wanted);
    const next = new URLSearchParams(searchParams);
    next.delete('agent');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  const sessionsCollection = useChatSessions();
  // ADR 0043 Phase 5A: the sequential boardroom cadence. Only ever started from
  // a `@@<board>` summon, so a normal chat is untouched. Drives one advisor turn
  // at a time off the completion of the prior turn.
  const personaOf = useCallback(
    (agentId: string) => activeAgents.lineup.find((a) => a.agentId === agentId)?.persona ?? t('advisorFallbackPersona'),
    [activeAgents.lineup, t],
  );
  const cadence = useBoardroomCadence({ isSending, errored: error !== null, send, personaOf, emitSystem });
  const [activeRailTab, setActiveRailTab] = useState<LeftRailTab | null>(
    () => readRailTabFromStorage(tenantId),
  );
  // Track the last non-null tab so the chat-header toggle can reopen
  // the rail to whichever panel the user was last looking at, rather
  // than forcing them through a default tab every time.
  const [lastRailTab, setLastRailTab] = useState<LeftRailTab>(
    () => readRailTabFromStorage(tenantId) ?? 'conversations',
  );
  const [focusedWorkflowMessageId, setFocusedWorkflowMessageId] = useState<string | null>(() => {
    try { return localStorage.getItem(progressFocusedKey(tenantId)); } catch { return null; }
  });
  // Track viewport width so the panel switches between right-side
  // drawer and full-screen overlay below the mobile breakpoint.
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT_PX,
  );
  useEffect(() => {
    // Resize listener — skip the state-set when the boolean wouldn't
    // change so a window drag doesn't cause a top-level re-render per
    // resize event (~60Hz). Cheap guard, frees up the render pipeline
    // for the chat thread while the panel is open.
    const onResize = () => {
      const next = window.innerWidth < MOBILE_BREAKPOINT_PX;
      setIsMobile((prev) => (prev === next ? prev : next));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // One-time prune of panel-state keys belonging to other tenants on
  // this browser. Keeps localStorage bounded across identity switches
  // (anon → signed-in transition, shared-machine demos).
  useEffect(() => {
    pruneStalePanelKeys(tenantId);
  }, [tenantId]);

  // One-shot remedial cleanup: HARD-DELETE the empty (messageCount:0)
  // conversations that the old reset()-eagerly-creates behavior left behind, so
  // the history rail stops showing a wall of abandoned "New chat" rows. Guarded
  // by a per-tenant localStorage flag so it runs exactly once per browser — it
  // is NOT an ongoing sweep (the reset() fix already stops new empties; the
  // rail's display filter masks any stragglers). The active session is always
  // spared (it may be a fresh chat the user is about to type into). Deletes are
  // idempotent server-side (a `not_found` is treated as already-gone), so a
  // reload mid-purge just finishes the remainder.
  const purgedEmptyRef = useRef(false);
  useEffect(() => {
    if (purgedEmptyRef.current || sessionsCollection.isLoading) return;
    const flagKey = `openwop-app.chat.purgedEmpty:${tenantId}`;
    try { if (localStorage.getItem(flagKey)) { purgedEmptyRef.current = true; return; } } catch { /* disabled — skip */ }
    purgedEmptyRef.current = true;
    const empties = sessionsCollection.sessions.filter(
      (s) => s.messageCount === 0 && s.sessionId !== session.id,
    );
    void (async () => {
      for (const e of empties) {
        try { await sessionsCollection.remove(e.sessionId); } catch { /* best-effort; the rail filter still hides it */ }
      }
      try { localStorage.setItem(flagKey, '1'); } catch { /* disabled — a later mount retries */ }
    })();
  }, [tenantId, sessionsCollection, session.id]);

  // ADR 0068/0070 — the unified review inbox (rail tab) + its pending-count badge,
  // and ADR 0069 — the artifact workbench opened from a review pinned to an
  // artifact. ADR 0074 — the badge reads the shared reviewStatusStore (the single
  // source of truth), kept live by the broadcast signal. The rail connects here
  // (ref-counted) so the badge stays current even when the Reviews tab is closed;
  // re-connect on tenant change re-hydrates for the new scope.
  const reviewCount = useReviewCount();
  const connectReviews = useReviewStatusStore((s) => s.connect);
  const disconnectReviews = useReviewStatusStore((s) => s.disconnect);
  const refreshReviews = useReviewStatusStore((s) => s.refresh);
  const [openArtifact, setOpenArtifact] = useState<{ artifactId: string; revisionId?: string } | null>(null);
  useEffect(() => {
    void connectReviews();
    return () => disconnectReviews();
  }, [connectReviews, disconnectReviews]);
  // Re-hydrate for the new scope on a tenant switch (connect()'s ref-count would
  // otherwise skip the refresh if the Reviews tab is also mounted). Skips the
  // initial mount, where connect() already hydrated.
  const tenantHydrated = useRef(false);
  useEffect(() => {
    if (!tenantHydrated.current) { tenantHydrated.current = true; return; }
    void refreshReviews();
  }, [tenantId, refreshReviews]);

  // Workflow_run messages in this session — feed into the panel +
  // run-switcher. Most-recent first so the run-switcher row order
  // mirrors how the user thinks about their dispatch history.
  const workflowRunMessages = useMemo(
    () => session.messages
      .filter((m) => m.role === 'workflow_run')
      .slice()
      .reverse(),
    [session.messages],
  );

  // Reconcile the focused id against the active session's
  // workflow_run set. Two cases:
  //   - Nothing focused → auto-focus the most recently dispatched run.
  //   - Focused id doesn't exist in this session (loaded a different
  //     session via the history drawer, persisted id is stale) → drop
  //     it and re-focus on the visible most-recent run.
  // The panel's RunSwitcher highlights `focusedMessageId` directly, so
  // a stale id would leave the highlight pointing at no row.
  useEffect(() => {
    const stillExists = focusedWorkflowMessageId !== null
      && workflowRunMessages.some((m) => m.id === focusedWorkflowMessageId);
    if (!stillExists) {
      setFocusedWorkflowMessageId(workflowRunMessages[0]?.id ?? null);
    }
  }, [workflowRunMessages, focusedWorkflowMessageId]);

  // Auto-open the progress panel when a brand-new workflow_run is
  // dispatched in this session. Watch a ref of "ids we've already
  // seen" — when an id appears that wasn't there before, it's a
  // fresh dispatch (via `@-mention` or workflow-tool-use) and the
  // user benefits from the panel popping open to track it. Loading
  // a different session via the history drawer also changes the id
  // set but those ids exist in the saved messages; the ref seeds
  // from `workflowRunMessages` on mount so pre-existing runs don't
  // trigger the open. Session switches reset the ref to the new
  // session's id set, so switching back to a session with old runs
  // doesn't re-pop the panel.
  const seenWorkflowRunIdsRef = useRef<Set<string>>(new Set(workflowRunMessages.map((m) => m.id)));
  const prevSessionIdRef = useRef<string>(session.id);
  useEffect(() => {
    // Session switch — reseed the seen-set with whatever's in the new
    // session and skip the auto-open this tick.
    if (prevSessionIdRef.current !== session.id) {
      prevSessionIdRef.current = session.id;
      seenWorkflowRunIdsRef.current = new Set(workflowRunMessages.map((m) => m.id));
      return;
    }
    const seen = seenWorkflowRunIdsRef.current;
    const newRun = workflowRunMessages.find((m) => !seen.has(m.id));
    if (newRun) {
      // Mark all current ids as seen (covers the case where multiple
      // arrived in a single tick, e.g., hydration race).
      for (const m of workflowRunMessages) seen.add(m.id);
      setFocusedWorkflowMessageId(newRun.id);
      setActiveRailTab('progress');
      setLastRailTab('progress');
    }
  }, [workflowRunMessages, session.id]);

  // Persist rail state on every change so reload restores the user's
  // last view.
  useEffect(() => { writeStorage(railTabKey(tenantId), activeRailTab); }, [tenantId, activeRailTab]);
  useEffect(() => { writeStorage(progressFocusedKey(tenantId), focusedWorkflowMessageId); }, [tenantId, focusedWorkflowMessageId]);

  const selectRailTab = useCallback((tab: LeftRailTab | null) => {
    setActiveRailTab(tab);
    if (tab !== null) setLastRailTab(tab);
  }, []);

  // ADR 0458 residue — the `?rail=` deep-link, a sibling of `?agent=` above:
  // read ONCE per value, apply only if it names a real rail tab, strip
  // immediately so refresh/share keeps a clean URL. Lets feature CTAs land on
  // a specific rail (e.g. the Studio publication link → the reviews inbox)
  // instead of whatever tab localStorage last held.
  const railParamHandled = useRef<string | null>(null);
  useEffect(() => {
    const wanted = searchParams.get('rail');
    if (!wanted || railParamHandled.current === wanted) return;
    railParamHandled.current = wanted;
    if (wanted === 'conversations' || wanted === 'progress' || wanted === 'reviews') {
      selectRailTab(wanted);
    }
    const next = new URLSearchParams(searchParams);
    next.delete('rail');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, selectRailTab]);

  const openProgressForRun = useCallback((messageId: string) => {
    setFocusedWorkflowMessageId(messageId);
    setActiveRailTab('progress');
    setLastRailTab('progress');
  }, []);

  // Open a persisted conversation: load its messages, then DERIVE the active-
  // agents lineup from its server-side participants (ADR 0043 — so the lineup
  // survives a cross-device reload instead of starting empty), mark it read, and
  // collapse the rail. Shared by the Conversations rail + the legacy history
  // drawer so both behave identically.
  const selectConversation = useCallback(async (id: string) => {
    await loadSessionFromBackend(id);
    const conv = sessionsCollection.sessions.find((s) => s.sessionId === id);
    if (conv?.participants && conv.participants.length > 0) {
      activeAgents.setLineup(participantsToLineup(conv.participants, (agentId) => {
        const e = agentEntries.find((x) => x.agentId === agentId);
        return e ? { persona: e.displayName, slug: e.slug, modelClass: e.modelClass } : null;
      }));
    }
    void sessionsCollection.markRead(id);
    selectRailTab(null);
    // activeAgents.setLineup is stable; the lineup churns each render so depend on
    // the stable member, not the whole object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadSessionFromBackend, sessionsCollection, agentEntries, activeAgents.setLineup, selectRailTab]);

  // ADR 0140 parity — the SHARED per-conversation actions (branch · branch-from ·
  // import · export · share + compare state), factored into a hook so the standalone
  // sidebar and each multi-tab TabSession run identical handlers. The standalone opens
  // a result in-place (selectConversation) and refreshes its own list.
  const { onBranch, onBranchFrom, onImport, onExport, onShare, compareOpen, openCompare, closeCompare } = useConversationActions({
    sessionId: session.id,
    refreshList: sessionsCollection.refresh,
    onOpenConversation: selectConversation,
  });

  // ADR 0054 D3 — deep-link a specific conversation (e.g. "Open project chat"):
  // `/chat?conversation=<sessionId>` opens it once it has loaded into the sidebar
  // list, then strips the param. Mirrors the `?agent=` deep-link above.
  const deepLinkConvHandled = useRef<string | null>(null);
  useEffect(() => {
    const wanted = searchParams.get('conversation');
    if (!wanted || deepLinkConvHandled.current === wanted) return;
    if (!sessionsCollection.sessions.some((s) => s.sessionId === wanted)) return; // list may still be loading
    deepLinkConvHandled.current = wanted;
    void selectConversation(wanted);
    const next = new URLSearchParams(searchParams);
    next.delete('conversation');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, sessionsCollection.sessions, selectConversation]);


  // Per-turn capability hints sourced from providers.json for the active model.
  // Falls back to the provider default when `config.model` is stale (renamed/removed by a
  // catalog refresh) so the capability-gated composer controls don't vanish — see resolveActiveModel.
  const activeModel = resolveActiveModel(config.provider, config.model);
  const supportsAudioInput = activeModel?.audioInput === true;
  // Image (vision) input is the model's `vision` capability. PDFs ride the
  // same native document channel only on Anthropic + Gemini in our dispatcher
  // (OpenAI Chat Completions + MiniMax don't accept PDF parts) — gate on both
  // vision + provider so the chip warns honestly. Text files (.txt/.md/.json/
  // .csv) inline as text on every provider, so they're never gated.
  const supportsImageInput = activeModel?.capabilities?.includes('vision') === true;
  const supportsPdfInput = supportsImageInput && (config.provider === 'anthropic' || config.provider === 'google');
  const supportsWebSearch = activeModel?.webSearch === true;
  // Tool calling is gated to Anthropic in the backend dispatcher
  // (OpenAI / Google have their own wire shapes — see
  // backend/.../bootstrap/nodes.ts useTools).
  // Tools support is per-model. Anthropic Claude 4 models, MiniMax-M2.7,
  // and any future provider whose adapter we wire all declare `tools`
  // in providers.json. The provider-level check we had before was a
  // proxy for "Anthropic-only" — replaced with a real capability lookup
  // so MiniMax (the managed Try-it-free path) unlocks tool-use too.
  const supportsTools = activeModel?.capabilities?.includes('tools') === true;

  // ADR 0140 — the SHARED next-turn composer controls (web search · tools ·
  // capability scope) + the per-exchange model switcher, factored into a hook so the
  // standalone sidebar and each multi-tab TabSession render identical modifiers and
  // thread identical send options. `getSubmitExtras` is the `baseSendOptions` below.
  const { composerModifiers, modelSwitcher, getSubmitExtras } = useComposerModifiers({
    sessionId: session.id, supportsWebSearch, supportsTools, activeProvider: config.provider,
  });

  // ADR 0054 D6 — the active conversation's owning project (a `project:<id>`
  // Subject), when this is a project group chat; drives the "Convene the team"
  // affordance below.
  const activeConversation = sessionsCollection.sessions.find((s) => s.sessionId === session.id);
  const conveneProjectId = activeConversation?.ownerSubject?.kind === 'project' ? activeConversation.ownerSubject.id : null;
  const conveneAgentCount = (activeConversation?.participants ?? []).filter((p) => p.subjectRef.startsWith('agent:')).length;

  // ADR 0154 Phase 2 — channel management chrome. Owner-gating is server-side
  // (the manage dialog reads `viewerIsOwner` from GET /:id); nothing here needs
  // to know the caller identity.
  const isChannelActive = activeConversation?.type === 'channel';
  // ADR 0195 D3b — multi-party surfaces carry public reactions; the PRIVATE
  // feedback thumbs are suppressed there (they stay the 1:1 affordance).
  const isMultiPartyActive = isChannelActive || activeConversation?.type === 'group';
  // ADR 0154 FU-6 — live channel message delivery (debounced reload on each frame).
  useChannelMessageStream(session.id, isChannelActive, refreshNewestMessages); // ADR 0327 P2 slice — incremental merge, not a full session reset per frame
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showBrowseChannels, setShowBrowseChannels] = useState(false);
  const [showChannelDetails, setShowChannelDetails] = useState(false);
  const onChannelCreated = useCallback((channelId: string) => {
    void (async () => {
      await sessionsCollection.refresh();
      void selectConversation(channelId);
    })();
  }, [sessionsCollection, selectConversation]);
  // ADR 0192 D2/D8 — the ONE resolved-roster fetch for the open channel: Zone 1,
  // the header facepile, the channel-scoped @ entries, feed attribution, and
  // the empty state all read from it.
  const channelRoster = useChannelRoster(session.id, isChannelActive);
  // ADR 0192 D7 — conversation mute rides the notifications prefs store.
  const notifPreferences = useNotificationStore((s) => s.preferences);
  const toggleConversationMute = useNotificationStore((s) => s.toggleConversationMute);
  const mutedIds = useMemo(() => new Set(notifPreferences.mutedConversations ?? []), [notifPreferences.mutedConversations]);
  // ADR 0192 D3 — leaving (or archiving) the open channel drops the surface
  // back to a fresh chat + refreshed rail.
  const onLeftChannel = useCallback(() => {
    void sessionsCollection.refresh();
    reset();
  }, [sessionsCollection, reset]);
  // ADR 0195 D5 — multi-party message affordances via the ONE shared owner
  // (ADR 0327 P3: previously copy-pasted verbatim here and in TabSession).
  const channelMessageActions = useChannelMessageActions(session.id, loadSessionFromBackend);

  // ADR 0202 D5 — the caller's first-unread index (from their own participant
  // row's readMessageCount, ADR 0192 D6) drives the "New messages" divider.
  // Only when the FULL thread is loaded (`!hasOlderMessages`) — otherwise the
  // absolute readMessageCount doesn't map to the loaded window index
  // (code-review finding 2).
  const unreadFromIndex = useMemo(() => {
    if (!isChannelActive || hasOlderMessages) return undefined;
    const self = (activeConversation?.participants ?? []).find((p) => p.isSelf);
    const read = self?.readMessageCount;
    if (read === undefined || read <= 0 || read >= session.messages.length) return undefined;
    return read;
  }, [isChannelActive, hasOlderMessages, activeConversation?.participants, session.messages.length]);
  const hasChannelAgent = channelRoster.mentionEntries.length > 0;
  const [summarizing, setSummarizing] = useState(false);
  // ADR 0202 D2/D5 — request the AI catch-up, poll the run to completion, and
  // surface the summary as a transient system message (NOT a channel message —
  // the run posts nothing in-channel by construction). The in-flight state is a
  // toast (auto-dismisses, no stale banner) + a button guard (no double-fire).
  const requestCatchup = useCallback(() => {
    if (summarizing) return;
    setSummarizing(true);
    toast.info(t('summarizingRecap'));
    void (async () => {
      try {
        const { requestChannelCatchup } = await import('../client/channelsClient.js');
        const { pollEvents } = await import('../client/runsClient.js');
        const { runId } = await requestChannelCatchup(session.id);
        for (let i = 0; i < 30; i++) {
          const { events } = await pollEvents(runId, 0);
          const done = events.find((e) => e.type === 'run.completed' || e.type === 'run.failed');
          if (done) {
            const text = (done.payload as { outputs?: { text?: unknown } } | undefined)?.outputs?.text;
            emitSystem(typeof text === 'string' && text.trim() ? t('recapPrefix', { summary: text }) : t('recapFailed'));
            return;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        toast.error(t('recapTimedOut'));
      } catch {
        toast.error(t('recapFailed'));
      } finally {
        setSummarizing(false);
      }
    })();
  }, [session.id, summarizing, emitSystem, t]);

  const requestLeaveChannel = useCallback(() => {
    void (async () => {
      const ok = await confirm({
        title: t('leaveChannelConfirmTitle'),
        body: t('leaveChannelConfirmBody'),
        confirmLabel: t('leaveChannelCta'),
      });
      if (!ok) return;
      try {
        const { leaveChannel } = await import('../client/channelsClient.js');
        await leaveChannel(session.id);
        toast.success(t('leftChannelToast', { name: activeConversation?.title ?? '' }));
        onLeftChannel();
      } catch {
        toast.error(t('leaveChannelError'));
      }
    })();
  }, [session.id, activeConversation?.title, onLeftChannel, t]);

  // Convene/board deps (ADR 0140 G3) — the SHARED interceptors (chat/conversations/
  // convene.ts) run on THIS surface's activeAgents/cadence/send/session, so convened
  // turns land here. `session.id` is read live (getSessionId) so a board attach targets
  // the CURRENT chat after a reset/switch.
  const sessionId = session.id;
  // Ref-backed emptiness so the memoized deps don't churn per message.
  const sessionMessagesLenRef = useRef(0);
  sessionMessagesLenRef.current = session.messages.length;
  const conveneDeps: ConveneDeps = useMemo(() => ({
    agentEntries,
    activeAgents: { activateAgent: activeAgents.activateAgent, switchTo: activeAgents.switchTo },
    cadenceStart: cadence.start,
    send, config, emitSystem, t,
    attachBoard: sessionsCollection.attachBoard,
    getSessionId: () => sessionId,
    conveneProjectId,
    // ADR 0278 summon routing — a pure @@summon in an EMPTY chat opens the
    // board's canonical conversation instead of stamping this one.
    isSessionEmpty: () => sessionMessagesLenRef.current === 0,
    openBoardConversation: (id: string) => { void selectConversation(id); },
  }), [agentEntries, activeAgents.activateAgent, activeAgents.switchTo, cadence.start, send, config, emitSystem, t, sessionsCollection.attachBoard, sessionId, conveneProjectId, selectConversation]);

  // The "Convene the team" button (ADR 0054 D6) calls this directly.
  const conveneProject = useCallback((topic: string) => runProjectConvene(topic, conveneDeps), [conveneDeps]);
  const conveneInterceptor = useMemo(() => buildProjectConveneInterceptor(conveneDeps), [conveneDeps]);
  const boardInterceptor = useMemo(() => buildBoardInterceptor(conveneDeps), [conveneDeps]);

  /** Submit path (ADR 0140 G1): the shared CORE (command → /workflow → @agent → send)
   *  with the full surface's convene/board interceptors + per-turn send options
   *  (web-search / model / tools). Depends on the stable `activeAgents` MEMBERS, not the
   *  churning object. */
  // Hide empty (messageCount:0) conversations from the history rail — an
  // abandoned "New chat" never earns a slot. The currently-active session is
  // always kept (it may be a fresh chat the user is about to type into). This is
  // a DISPLAY guard that also masks any pre-existing empty rows created before
  // the reset()-no-longer-eagerly-creates fix; it deletes nothing server-side.
  const visibleConversations = useMemo(
    () => sessionsCollection.sessions.filter((s) => s.messageCount > 0 || s.sessionId === session.id),
    [sessionsCollection.sessions, session.id],
  );

  const onUserSubmit = useCallback(async (text: string, attachments?: readonly ContentPart[]) => {
    // ADR 0154 — a channel (`type:'channel'`) posts to the channels host-ext
    // route, NOT a chat.turn run. The submit diverges HERE in the surface so
    // ConversationView stays generic (ADR 0073). v1 is text-only (attachments
    // are dropped); there is no message-delivery SSE, so we reload after posting
    // (parity with the retired standalone view). @agent → server-side turn is
    // Phase 4.
    if (activeConversation?.type === 'channel') {
      // ADR 0192 D5 — the shared channel submit (attachments ride the
      // ChatMessage envelope; shared with TabSession so the copies can't drift).
      await submitChannelPost(session.id, text, attachments, {
        loadSessionFromBackend,
        markRead: (id) => { void sessionsCollection.markRead(id); },
        refreshConversations: () => { void sessionsCollection.refresh(); },
        draftKey: `openwop-app.chat.draft:${tenantId}:${session.id}`,
      });
      return;
    }
    await runCoreSubmit(text, attachments, {
      config, send, reset, cancel, emitSystem, runWorkflowMention, activeAgents, agentEntries,
      baseSendOptions: getSubmitExtras,
      onAgentActivated: (agentId) => { void sessionsCollection.addParticipant(session.id, `agent:${agentId}`); },
    }, [conveneInterceptor, boardInterceptor]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [send, cancel, reset, emitSystem, config, getSubmitExtras, runWorkflowMention, activeAgents.currentAgentId, activeAgents.activateAgent, agentEntries, session.id, sessionsCollection.addParticipant, conveneInterceptor, boardInterceptor, activeConversation?.type, loadSessionFromBackend, sessionsCollection.markRead, sessionsCollection.refresh, t]);

  // ADR 0140 follow-on — the right-docked members pane (parity with the deck; the
  // active conversation's roster lives in a RIGHT pane, not the left rail). Default
  // closed; the header toggle only shows when there's a roster to reveal.
  const [membersOpen, setMembersOpen] = useState(false);
  // ADR 0304 P2 residue — the live-boardroom floor, mirrored up from the view so
  // the members pane can pulse the agent being voiced right now.
  const [voiceSpeakingAgentId, setVoiceSpeakingAgentId] = useState<string | null>(null);
  const memberCount = isChannelActive ? channelRoster.roster.length : activeAgents.lineup.length;
  const showRoster = isChannelActive ? channelRoster.roster.length > 0 : (session.messages.length > 0 || activeAgents.lineup.length > 1);

  return (
    <div className="u-flex u-flex-1 u-minh-0 u-border u-radius u-bg-surface u-overflow-hidden u-relative">
      <LeftRail
        activeTab={activeRailTab}
        onSelectTab={selectRailTab}
        isMobile={isMobile}
        conversationsProps={{
          conversations: visibleConversations,
          isLoading: sessionsCollection.isLoading,
          error: sessionsCollection.error,
          activeSessionId: session.id,
          onRefresh: sessionsCollection.refresh,
          onSelect: (id) => { void selectConversation(id); },
          onRename: sessionsCollection.rename,
          onDelete: async (id) => {
            await sessionsCollection.remove(id);
            // If the deleted session is the active one, fall back to
            // a fresh local chat so the message feed isn't orphaned.
            if (id === session.id) reset();
          },
          // The open conversation's participants moved OUT of the rail into the
          // right-docked MembersPane (ADR 0140 follow-on) — the rail is a pure list.
          onNewChat: () => { cadence.cancel(); reset(); selectRailTab(null); },
          onOpenWorkspace: () => {
            void (async () => {
              const conv = await sessionsCollection.openWorkspace();
              if (conv) void selectConversation(conv.sessionId);
              else emitSystem(t('noWorkspaceAssistant'));
            })();
          },
          onCreateChannel: () => setShowCreateChannel(true),
          onBrowseChannels: () => setShowBrowseChannels(true),
          // ADR 0192 D7 — mute (notifications prefs owner).
          mutedIds,
          onToggleMute: toggleConversationMute,
        }}
        progressProps={{
          workflowRunMessages,
          focusedMessageId: focusedWorkflowMessageId,
          onFocus: (id) => setFocusedWorkflowMessageId(id),
          onCancel: cancelWorkflowRun,
        }}
        reviewsProps={{
          onOpenRun: openProgressForRun,
          onOpenArtifact: (artifactId, revisionId) => setOpenArtifact({ artifactId, ...(revisionId ? { revisionId } : {}) }),
        }}
        progressBadgeCount={workflowRunMessages.length}
        reviewsBadgeCount={reviewCount}
      />
      {openArtifact ? (
        <Suspense fallback={null}>
          <ArtifactWorkbench
            artifactId={openArtifact.artifactId}
            {...(openArtifact.revisionId ? { revisionId: openArtifact.revisionId } : {})}
            onClose={() => setOpenArtifact(null)}
          />
        </Suspense>
      ) : null}
      {compareOpen ? (
        <Suspense fallback={null}>
          <CompareView currentSessionId={session.id} onClose={closeCompare} />
        </Suspense>
      ) : null}
      {showCreateChannel ? (
        <Suspense fallback={null}>
          <ChannelCreateDialog onClose={() => setShowCreateChannel(false)} onCreated={onChannelCreated} />
        </Suspense>
      ) : null}
      {showBrowseChannels ? (
        <Suspense fallback={null}>
          <ChannelBrowseDialog
            onClose={() => setShowBrowseChannels(false)}
            onOpen={(id) => { void selectConversation(id); }}
            onJoined={onChannelCreated}
          />
        </Suspense>
      ) : null}
      {showChannelDetails && isChannelActive ? (
        <Suspense fallback={null}>
          <ChannelManageDialog
            channelId={session.id}
            onClose={() => setShowChannelDetails(false)}
            onChanged={async () => { await sessionsCollection.refresh(); await channelRoster.refresh(); }}
            onArchived={() => { reset(); }}
            onLeft={onLeftChannel}
          />
        </Suspense>
      ) : null}
      <div className="u-flex-1 u-flex u-flex-col u-minw-0">
        <ChatHeader
          config={config}
          byokStored={byokStored ?? true}
          onOpenSettings={onOpenSettings}
          onRemoveKey={onRemoveKey}
          onNewChat={() => { cadence.cancel(); reset(); }}
          onBranch={() => { void onBranch(); }}
          onCompare={openCompare}
          {...(exportAccess.enabled ? { onExport: (format: 'md' | 'json') => { void onExport(format); }, onImport: (f: File) => { void onImport(f); } } : {})}
          onShare={() => { void onShare(); }}
          session={session}
          modelSwitcher={modelSwitcher}
          railOpen={activeRailTab !== null}
          onToggleRail={() => selectRailTab(activeRailTab === null ? lastRailTab : null)}
          railBadgeCount={workflowRunMessages.length + Math.max(0, activeAgents.lineup.length - 1)}
          membersOpen={membersOpen}
          memberCount={memberCount}
          {...(showRoster ? { onToggleMembers: () => setMembersOpen((o) => !o) } : {})}
          {...(isChannelActive ? { onOpenChannelDetails: () => setShowChannelDetails(true) } : {})}
          {...(isChannelActive && activeConversation && channelRoster.detail ? {
            channelContext: {
              name: channelRoster.detail.channel?.name ?? activeConversation.title,
              description: channelRoster.detail.channel?.description,
              members: channelRoster.roster,
              onOpenDetails: () => setShowChannelDetails(true),
            },
          } : {})}
        />

        {activeConversation?.type === 'channel' ? (
          <Suspense fallback={null}><ChannelPresenceBar channelId={session.id} /></Suspense>
        ) : null}

        <ConversationView
          messages={session.messages}
          tenantId={tenantId}
          draftKey={`openwop-app.chat.draft:${tenantId}:${session.id}`}
          {...(commentsContext ? { commentsContext: { orgId: commentsContext.orgId, sessionId: session.id } } : {})}
          onLiveTranscript={upsertTranscriptTurn}
          // GRADE-D1 — the LIGHT merge-refresh: a voice-transcript frame must not
          // tear down live subscriptions or sever an in-flight typed turn.
          onReloadConversation={refreshNewestMessages}
          voiceConversationId={session.id}
          {...(scopeAgentId ? { voiceAgentId: scopeAgentId } : {})}
          // ADR 0304 D3 auto-voice — a live boardroom here (board attached to the
          // conversation, or a cadence mid-flight) makes voice sessions speak
          // every advisor turn in its own voice.
          voiceBoardActive={cadence.active || Boolean(activeConversation?.boardId)}
          // ADV-UX-1 — the simulated-persona disclaimer, on the surface where the
          // advice is actually read. Server-authored text; absent on non-board chats.
          {...(activeConversation?.boardId ? { boardId: activeConversation.boardId } : {})}
          onVoiceSpeakingAgent={setVoiceSpeakingAgentId}
          {...(isChannelActive && activeConversation ? {
            // ADR 0192 D8 — the channel-aware surface: beginning-of-channel
            // empty state, `Message #name` composer, roster-scoped @ entries,
            // resolved attribution + own-message alignment.
            renderEmptyState: () => (
              <Suspense fallback={null}>
                <ChannelEmptyState
                  name={channelRoster.detail?.channel?.name ?? activeConversation.title}
                  description={channelRoster.detail?.channel?.description}
                  viewerIsOwner={channelRoster.viewerIsOwner}
                  hasAgents={channelRoster.mentionEntries.length > 0}
                  onOpenDetails={() => setShowChannelDetails(true)}
                />
              </Suspense>
            ),
            composerPlaceholder: t('channelComposerPlaceholder', { name: channelRoster.detail?.channel?.name ?? activeConversation.title }),
            mentionEntries: channelRoster.mentionEntries,
            // Alignment/attribution only once the roster RESOLVED (review
            // finding 3): with an empty directory + no viewerSubjectRef the
            // feed would mis-align the viewer's own posts during load/failure;
            // ungated, every channel open flashed all-left. Until resolved the
            // feed keeps the pre-0192 role-based rendering.
            ...(channelRoster.detail ? {
              authorDirectory: channelRoster.authorDirectory,
              ...(channelRoster.viewerSubjectRef ? { viewerSubjectRef: channelRoster.viewerSubjectRef } : {}),
            } : {}),
            // ADR 0202 D5 — New-messages divider + Summarize (only with an agent).
            ...(unreadFromIndex !== undefined ? { unreadFromIndex } : {}),
            ...(hasChannelAgent ? { onSummarize: requestCatchup, summarizeBusy: summarizing } : {}),
          } : {})}
          error={error}
          isSending={isSending}
          onPickSuggestion={(text) => onUserSubmit(text)}
          onSend={onUserSubmit}
          onCancel={cancel}
          supportsAudioInput={supportsAudioInput}
          supportsImageInput={supportsImageInput}
          supportsPdfInput={supportsPdfInput}
          composerModifiers={composerModifiers}
          onResolveInterrupt={resolveInterrupt}
          progress={{ focusedMessageId: activeRailTab === 'progress' ? focusedWorkflowMessageId : null, onOpen: openProgressForRun }}
          onRegenerate={onRegenerate}
          onBranchFrom={(fromSeq) => { void onBranchFrom(fromSeq); }}
          {...(isMultiPartyActive ? { messageActions: channelMessageActions } : { onFeedback: setFeedback })}
          onReconfigureBYOK={onOpenSettings}
          hasOlderMessages={hasOlderMessages}
          isLoadingEarlier={isLoadingEarlier}
          onLoadEarlier={loadEarlierMessages}
          footerSlot={(
            <>
              {/* ADR 0311 P2 — approvals that trace back to THIS conversation
                  (a todo filed here -> heartbeat proposal) render where the
                  promise was made; the projection's authz means non-approvers
                  see nothing. */}
              <Suspense fallback={null}>
                <ConversationReviewsStrip conversationId={session.id} isSending={isSending} />
              </Suspense>
              {conveneProjectId && conveneAgentCount > 0 ? (
                <div className="u-flex u-items-center u-wrap u-gap-2 u-pad-2-4 u-fs-12 muted">
                  <Button variant="secondary" size="sm" disabled={isSending} onClick={() => void conveneProject('')}>
                    <SparklesIcon size={13} /> {t('conveneTheTeam')}
                  </Button>
                  <span>{t('conveneHelpPrefix')}<code>@@</code>{t('conveneHelpSuffix')}</span>
                </div>
              ) : null}
            </>
          )}
        />
      </div>
      {membersOpen && showRoster ? (
        <Suspense fallback={null}>
          <MembersPane
            isChannel={isChannelActive}
            channelId={session.id}
            lineup={activeAgents.lineup}
            currentAgentId={activeAgents.currentAgentId ?? DEFAULT_ASSISTANT_ID}
            thinkingAgentId={thinkingAgentId}
            speakingAgentId={voiceSpeakingAgentId}
            onSwitchAgent={activeAgents.switchTo}
            onRemoveAgent={(agentId) => { activeAgents.remove(agentId); void sessionsCollection.removeParticipant(session.id, `agent:${agentId}`); }}
            {...(isChannelActive && channelRoster.detail ? { channelRoster: {
              roster: channelRoster.roster,
              viewerIsOwner: channelRoster.viewerIsOwner,
              viewerSubjectRef: channelRoster.viewerSubjectRef,
              onManage: () => setShowChannelDetails(true),
              onLeave: requestLeaveChannel,
            } } : {})}
            onClose={() => setMembersOpen(false)}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
