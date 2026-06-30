/**
 * TabSession — ONE keep-alive conversation in the multi-tab chat deck (ADR 0140 P3).
 *
 * A full instance of the one AI chat (NOT a second chat): it drives the existing
 * `useChatSession` in the P1 backend-keyed mode (`{ sessionId }`) so N tabs each own
 * an isolated thread that hydrates from the backend and never clobbers the singleton
 * localStorage cache. The submit path is a near-verbatim mirror of
 * `EmbeddedConversation.onUserSubmit` (the shared CORE subset: command → /workflow →
 * @agent → send) — the two are deliberately kept identical so they don't drift; the
 * shared submit pipeline (`runCoreSubmit` + the shared convene interceptors).
 *
 * Convene/board (`@@`) works per-tab (ADR 0140 G3): `@@<board-handle>` summons a board
 * into THIS tab (advisors join the lineup, the boardroom cadence runs), and a bare `@@`
 * convenes the owning project's team when the tab is a project conversation. Each tab
 * has its OWN `useBoardroomCadence` + interceptors over its own session.
 *
 * Keep-alive: the DECK renders this mounted at all times and hides inactive tabs with
 * `display:none` on the wrapper (NOT React <Activity>, which tears down effects and
 * would close the live SSE subscription). A `display:none` subtree is removed from the
 * tab order AND the a11y tree by the browser, so a hidden tab can't steal focus and
 * isn't announced — the deck owns that hiding, so this component needs no `active` flag.
 */

import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatSession, type ContentPart } from '../hooks/useChatSession.js';
import { useAgentMentions } from '../lib/agentMentions.js';
import { useComposerModifiers } from '../hooks/useComposerModifiers.js';
import { useConversationActions } from '../hooks/useConversationActions.js';
import { ConversationView } from '../ConversationView.js';
import { ConversationLineup } from '../conversations/ConversationLineup.js';
import { useScopeToAgent } from '../activeAgents/useScopeToAgent.js';
import { runCoreSubmit } from '../lib/chatSubmit.js';
import { toast } from '../../ui/toast.js';
import { buildBoardInterceptor, buildProjectConveneInterceptor, runProjectConvene, type ConveneDeps } from '../conversations/convene.js';
import { useBoardroomCadence } from '../conversations/useBoardroomCadence.js';
import { registerDefaultCommands } from '../registry/defaultCommands.js';
import { DEFAULT_ASSISTANT_ID } from '../activeAgents/constants.js';
import { participantsToLineup } from '../conversations/participantLineup.js';
import { useChannelMessageStream } from '../conversations/useChannelMessageStream.js';
import { deriveActivity } from './useTabBadges.js';
import { resolveActiveModel } from '../../byok/lib/providers.js';
import { ConfiguredProviderCard } from '../../byok/ConfiguredProviderCard.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { Menu, type MenuEntry } from '../../ui/Menu.js';
import { MoreHorizontalIcon, SparklesIcon } from '../../ui/icons/index.js';
import type { BYOKActiveConfig } from '../../byok/lib/useBYOKConfig.js';
import type { ConversationParticipant, ConversationType } from '../../client/chatSessionsClient.js';
import type { ChatMessage } from '../types.js';

// ADR 0117 Phase 3 — the read-only side-by-side compare view; lazy (zero entry-budget),
// mirrors ChatSidebar.
const CompareView = lazy(() => import('../CompareView.js').then((m) => ({ default: m.CompareView })));
// ADR 0154 — channel-only chrome, lazy (deck parity with ChatSidebar): keeps
// channelsClient's SSE code out of the eager chat entry chunk.
const ChannelPresenceBar = lazy(() => import('../conversations/ChannelPresenceBar.js').then((m) => ({ default: m.ChannelPresenceBar })));
// ADR 0154 FU-1 — deck parity: channel settings reachable from the tab's ⋯ menu.
const ChannelManageDialog = lazy(() => import('../conversations/ChannelManageDialog.js').then((m) => ({ default: m.ChannelManageDialog })));

registerDefaultCommands();

export interface TabSessionProps {
  /** The conversation id this tab is bound to (P1 backend-keyed mode). */
  sessionId: string;
  config: BYOKActiveConfig;
  tenantId?: string;
  /** The conversation's server-side participants (from the deck's single
   *  `useChatSessions()`), used to restore the agent lineup. Undefined for a
   *  brand-new tab with no participants yet. */
  participants?: readonly ConversationParticipant[];
  /** The conversation type (ADR 0154) — `channel` routes the composer to the
   *  channels host-ext post route instead of a chat.turn run (deck parity with
   *  the standalone ChatSidebar). */
  conversationType?: ConversationType;
  /** Fired when the hook's session id changes (e.g. `/clear` mints a new chat) so
   *  the deck can re-key the working set. */
  onSessionIdChange: (oldId: string, newId: string) => void;
  /** Fired on each isSending transition so the deck can protect streaming tabs from
   *  eviction. */
  onStreamingChange: (sessionId: string, isSending: boolean) => void;
  /** Fired when this tab's last FINALIZED inbound message or blocked state changes, so
   *  the deck can badge a background tab (ADR 0140 P5). */
  onActivity: (sessionId: string, lastInboundId: string | null, blocked: boolean) => void;
  /** Persist/forget an agent as a conversation participant (ADR 0140 G2) — threaded from
   *  the deck's single `useChatSessions()` so the per-tab lineup is reconstructible
   *  server-side. Best-effort (a fresh tab not yet in the backend 404s harmlessly). */
  onAddParticipant?: (sessionId: string, subjectRef: string) => void;
  onRemoveParticipant?: (sessionId: string, subjectRef: string) => void;
  /** Attach a board to this conversation (ADR 0140 G3 `@@<handle>` summon) — threaded
   *  from the deck's single useChatSessions. Best-effort. */
  onAttachBoard?: (sessionId: string, boardId: string, participants: string[]) => Promise<void>;
  /** The conversation's owning subject (ADR 0140 G3) — when it's a `project:<id>`, a bare
   *  `@@` convenes that project's team in this tab. Undefined for a plain tab. */
  ownerSubject?: { kind: string; id: string };
  /** Scope this tab to an agent on mount (the `?agent=` deep-link, ADR 0140 G3). */
  scopeAgentId?: string;
  onReconfigureBYOK: () => void;
  /** Report this tab's `workflow_run` messages (most-recent first) + a cancel handler up
   *  to the deck, so the deck's shared Runs rail can bind to the ACTIVE tab (ADR 0140 P2).
   *  Mirrors `onActivity` — fired on change only; the deck no-ops on an unchanged array. */
  onWorkflowRuns?: (sessionId: string, runs: readonly ChatMessage[], cancel: (messageId: string) => Promise<void>) => void;
  /** Open a conversation on the deck (open-or-focus a tab) — used by the per-conversation
   *  actions (branch / branch-from / import open their result). Supplied by TabChatDeck. */
  onOpenConversation: (sessionId: string) => void;
  /** Refresh the deck's single conversation list after a branch/import. Supplied by
   *  TabChatDeck (`sessions.refresh`). */
  refreshConversations: () => Promise<void> | void;
  /** Close THIS tab (ADR 0154 FU-1) — used when a channel is archived so the tab
   *  doesn't linger on a now-dead channel. Supplied by TabChatDeck (`handleClose`). */
  onRequestClose?: () => void;
}

function TabSessionImpl({
  sessionId, config, tenantId = 'demo', participants, conversationType, onSessionIdChange, onStreamingChange, onActivity, onAddParticipant, onRemoveParticipant, onAttachBoard, ownerSubject, scopeAgentId, onReconfigureBYOK, onWorkflowRuns, onOpenConversation, refreshConversations, onRequestClose,
}: TabSessionProps): JSX.Element {
  const { t } = useTranslation('chat');
  const handleSessionIdChange = useCallback((newId: string) => onSessionIdChange(sessionId, newId), [onSessionIdChange, sessionId]);
  const {
    session, isSending, isHydrating, thinkingAgentId, error, send, cancel, reset, resolveInterrupt, runWorkflowMention,
    regenerate, setFeedback, hasOlderMessages, isLoadingEarlier, loadEarlierMessages, activeAgents, emitSystem, cancelWorkflowRun, loadSessionFromBackend,
  } = useChatSession({ sessionId, onSessionIdChange: handleSessionIdChange });
  const { entries: agentEntries } = useAgentMentions();
  // ADR 0154 FU-6 — live channel message delivery (deck parity with ChatSidebar).
  useChannelMessageStream(sessionId, conversationType === 'channel', loadSessionFromBackend);

  // ?agent= deep-link (ADR 0140 G3): activate the agent in THIS tab's lineup once.
  useScopeToAgent(activeAgents, agentEntries, scopeAgentId ?? null);

  // Per-tab convene (ADR 0140 G3): board summon (`@@<handle>`) works in ANY tab; a bare
  // `@@` convenes the owning project's team only when this is a project chat. Cadence +
  // the shared interceptors run on THIS tab's own activeAgents/send/session, so convened
  // turns land here.
  const personaOf = useCallback(
    (agentId: string) => activeAgents.lineup.find((a) => a.agentId === agentId)?.persona ?? t('advisorFallbackPersona'),
    [activeAgents.lineup, t],
  );
  const cadence = useBoardroomCadence({ isSending, errored: error !== null, send, personaOf });
  const conveneProjectId = ownerSubject?.kind === 'project' ? ownerSubject.id : null;
  const conveneDeps: ConveneDeps = useMemo(() => ({
    agentEntries,
    activeAgents: { activateAgent: activeAgents.activateAgent, switchTo: activeAgents.switchTo },
    cadenceStart: cadence.start,
    send, config, emitSystem, t,
    attachBoard: (sid, boardId, parts) => (onAttachBoard ? onAttachBoard(sid, boardId, parts) : Promise.resolve()),
    getSessionId: () => sessionId,
    conveneProjectId,
    // Stable members only (not activeAgents.lineup, which is a fresh array each render and
    // would churn the memoized onUserSubmit) — matches ChatSidebar.
  }), [agentEntries, activeAgents.activateAgent, activeAgents.switchTo, cadence.start, send, config, emitSystem, t, onAttachBoard, sessionId, conveneProjectId]);
  const conveneInterceptor = useMemo(() => buildProjectConveneInterceptor(conveneDeps), [conveneDeps]);
  const boardInterceptor = useMemo(() => buildBoardInterceptor(conveneDeps), [conveneDeps]);
  // The "Convene the team" button (ADR 0054 D6) calls this directly — mirrors ChatSidebar.
  const conveneProject = useCallback((topic: string) => runProjectConvene(topic, conveneDeps), [conveneDeps]);
  // Count of agent participants — gates the convene footer (mirrors ChatSidebar).
  const conveneAgentCount = (participants ?? []).filter((p) => p.subjectRef.startsWith('agent:')).length;

  // Restore the agent lineup from the conversation's participants once they're
  // available (mirrors ChatSidebar.selectConversation → activeAgents.setLineup). The
  // ref guard makes it one-shot per (sessionId, participants) so it doesn't fight the
  // user re-ordering the lineup mid-session.
  const lineupDerivedRef = useRef<string | null>(null);
  const setLineup = activeAgents.setLineup;
  useEffect(() => {
    if (!participants || participants.length === 0) return;
    if (lineupDerivedRef.current === sessionId) return;
    lineupDerivedRef.current = sessionId;
    setLineup(participantsToLineup(participants, (agentId) => {
      const e = agentEntries.find((x) => x.agentId === agentId);
      return e ? { persona: e.displayName, slug: e.slug, modelClass: e.modelClass } : null;
    }));
  }, [participants, sessionId, agentEntries, setLineup]);

  // Surface streaming transitions to the deck (eviction protection). Fires only on
  // change (effect dep), and the deck's handler no-ops on an unchanged value.
  useEffect(() => { onStreamingChange(sessionId, isSending); }, [isSending, sessionId, onStreamingChange]);

  // Background-badge signal (ADR 0140 P5) — the pure `deriveActivity` keeps the
  // O(messages) scan off the per-token path (memoized on the two inputs).
  const activity = useMemo(() => deriveActivity(session.messages, isSending), [session.messages, isSending]);
  useEffect(() => { onActivity(sessionId, activity.lastInboundId, activity.blocked); }, [activity.lastInboundId, activity.blocked, sessionId, onActivity]);

  const onRegenerate = useCallback((id: string) => { void regenerate(id, config); }, [regenerate, config]);

  // Per-model capability hints (mirror ChatSidebar/EmbeddedConversation) so the
  // composer flags unsupported attachments honestly. Falls back to the provider default
  // when `config.model` is stale (renamed by a catalog refresh) so the controls don't vanish.
  const activeModel = resolveActiveModel(config.provider, config.model);
  const supportsAudioInput = activeModel?.audioInput === true;
  const supportsImageInput = activeModel?.capabilities?.includes('vision') === true;
  const supportsPdfInput = supportsImageInput && (config.provider === 'anthropic' || config.provider === 'google');
  const supportsWebSearch = activeModel?.webSearch === true;
  const supportsTools = activeModel?.capabilities?.includes('tools') === true;

  // ADR 0140 — the SHARED next-turn composer modifiers (web search · tools · capability
  // scope) + the per-exchange model switcher, scoped to THIS tab's session. Identical to
  // the standalone ChatSidebar's controls (same hook). The deck tab has no ChatHeader, so
  // the model switcher folds into the same modifier group below.
  const { composerModifiers, modelSwitcher, getSubmitExtras } = useComposerModifiers({
    sessionId, supportsWebSearch, supportsTools, activeProvider: config.provider,
  });

  // ADR 0140 parity — the SHARED per-conversation actions (branch · branch-from · import ·
  // export · share + compare state), identical to ChatSidebar (same hook). The deck opens a
  // result as a tab (onOpenConversation → open-or-focus) and refreshes the deck's one list.
  const { onBranch, onBranchFrom, onImport, onExport, onShare, compareOpen, openCompare, closeCompare } = useConversationActions({
    sessionId, refreshList: refreshConversations, onOpenConversation,
  });
  // Feature gates mirror ChatSidebar: export/import are always-on; share gates on `sharing`.
  const exportAccess = { enabled: true };
  const sharingAccess = useFeatureAccess('sharing');
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const hasTurns = session.messages.length > 0;
  const [showChannelDetails, setShowChannelDetails] = useState(false); // ADR 0154 FU-1 (deck parity)
  // The per-tab ⋯ actions menu — the standalone's ChatHeader ⋯ More. It now lives in the
  // COMPOSER toolbar (next to web · tools · model), NOT a separate top header row — the deck
  // has no ChatHeader and that second row was dead chrome. Same ui/Menu primitive + i18n +
  // gates. Memoized so a streamed token (new session.messages identity) doesn't rebuild it.
  const actionMenuItems: MenuEntry[] = useMemo(() => [
    ...(conversationType === 'channel' ? [{ id: 'channel-settings', label: t('channelSettingsAria'), onSelect: () => setShowChannelDetails(true) }] : []),
    ...(hasTurns ? [{ id: 'branch', label: t('branch'), title: t('branchConversationTitle'), onSelect: () => { void onBranch(); } }] : []),
    ...(hasTurns ? [{ id: 'compare', label: t('compare'), title: t('compareTitle'), onSelect: openCompare }] : []),
    ...(hasTurns && exportAccess.enabled ? [
      { id: 'export', label: t('export'), title: t('exportConversationTitle'), onSelect: () => { void onExport('md'); } },
      { id: 'export-json', label: t('exportAsJson'), onSelect: () => { void onExport('json'); } },
    ] : []),
    ...(exportAccess.enabled ? [{ id: 'import', label: t('import'), title: t('importConversationTitle'), onSelect: () => importInputRef.current?.click() }] : []),
    ...(hasTurns && sharingAccess.enabled ? [{ id: 'share', label: t('share', { defaultValue: 'Share link' }), title: t('shareConversationTitle', { defaultValue: 'Create a public read-only link to this conversation' }), onSelect: () => { void onShare(); } }] : []),
  ], [hasTurns, conversationType, exportAccess.enabled, sharingAccess.enabled, onBranch, openCompare, onExport, onShare, t]);

  // ADR 0140 — the next-turn composer modifiers (web · tools · capability scope) + the
  // per-exchange model switcher + the ⋯ actions menu, assembled into the ONE composer
  // toolbar. Memoized so streamed tokens don't re-identify the composer chrome.
  // ADR 0164 — the BYOK provider card (active `provider · model` + "Change" → the BYOK
  // wizard) leads the model zone, exactly as the standalone header (ChatHeader.tsx
  // `chathdr-model`). Restores BYOK/Try-for-free/key-entry parity to each tab — the
  // bare `modelSwitcher` is only the SECONDARY per-exchange override. `onRemoved` routes
  // to the wizard: compact mode surfaces no remove button (disconnect lives in the
  // wizard), so this is never invoked here but satisfies the required prop honestly.
  const tabComposerModifiers = useMemo(
    () => (
      <>
        {composerModifiers}
        <span className="chathdr-model">
          <ConfiguredProviderCard config={config} onChange={onReconfigureBYOK} onRemoved={onReconfigureBYOK} compact />
          {modelSwitcher}
        </span>
        {actionMenuItems.length > 0 ? (
          <Menu
            label={t('moreActions')}
            triggerClassName="secondary chathdr-more-btn"
            triggerContent={<MoreHorizontalIcon size={15} />}
            items={actionMenuItems}
            dropUp
          />
        ) : null}
      </>
    ),
    [composerModifiers, modelSwitcher, actionMenuItems, config, onReconfigureBYOK, t],
  );

  // Lift this tab's workflow runs (most-recent first) + cancel handler to the deck so the
  // shared Runs rail binds to the ACTIVE tab (ADR 0140 P2). Mirrors `onActivity`.
  // STREAMING ISOLATION (ADR 0140 P3/P5): `session.messages` gets a new identity every
  // streamed token, but the `workflow_run` SUBSET is unchanged while plain text streams
  // (those are assistant messages). Keep `workflowRunMessages` REFERENTIALLY STABLE
  // (return the prior array when the run-message objects are identical) so the lift
  // effect — and the deck re-render it triggers — fires only on a real run change, not
  // per token. `cancelWorkflowRun` is read via a ref so it stays out of the effect deps.
  const stableRunsRef = useRef<readonly ChatMessage[]>([]);
  const workflowRunMessages = useMemo(() => {
    const next = session.messages.filter((m) => m.role === 'workflow_run').reverse();
    const prev = stableRunsRef.current;
    if (prev.length === next.length && prev.every((m, i) => m === next[i])) return prev;
    stableRunsRef.current = next;
    return next;
  }, [session.messages]);
  const cancelRunRef = useRef(cancelWorkflowRun);
  cancelRunRef.current = cancelWorkflowRun;
  useEffect(() => {
    onWorkflowRuns?.(sessionId, workflowRunMessages, cancelRunRef.current);
  }, [workflowRunMessages, sessionId, onWorkflowRuns]);

  // Shared CORE submit (ADR 0140 G1) + per-tab convene/board interceptors (G3):
  // command → /workflow → [project-convene, board-summon] → @agent → send. The shared
  // per-turn modifier options (web search · model · tools) ride in via baseSendOptions —
  // identical to ChatSidebar.
  const onUserSubmit = useCallback(async (text: string, attachments?: readonly ContentPart[]) => {
    // ADR 0154 — channel parity with ChatSidebar: post to the channels host-ext
    // route (not a chat.turn run), then reload (no message-delivery SSE). v1 is
    // text-only.
    if (conversationType === 'channel') {
      const body = text.trim();
      if (attachments?.length) toast.error(t('channelTextOnly')); // v1 text-only
      if (!body) return;
      try {
        const { postChannelMessage } = await import('../../client/channelsClient.js');
        await postChannelMessage(sessionId, body);
        await loadSessionFromBackend(sessionId);
        void refreshConversations();
      } catch {
        toast.error(t('channelPostError'));
      }
      return;
    }
    await runCoreSubmit(text, attachments, {
      config, send, reset, cancel, runWorkflowMention, activeAgents, agentEntries, emitSystem,
      baseSendOptions: getSubmitExtras,
      // Persist an @-mentioned agent as a participant so the per-tab lineup is
      // reconstructible server-side (ADR 0140 G2), mirroring ChatSidebar.
      onAgentActivated: (agentId) => onAddParticipant?.(sessionId, `agent:${agentId}`),
    }, [conveneInterceptor, boardInterceptor]);
  }, [send, cancel, reset, config, runWorkflowMention, agentEntries, activeAgents, emitSystem, getSubmitExtras, onAddParticipant, sessionId, conveneInterceptor, boardInterceptor, conversationType, loadSessionFromBackend, refreshConversations, t]);

  return (
    <div className="u-flex u-flex-col u-flex-1 u-minh-0">
      {/* The per-tab ⋯ actions menu (Branch / Compare / Export / Import / Share) moved INTO
          the composer toolbar (see tabComposerModifiers above) — no separate top header row. */}
      {/* Hidden file input the ⋯ Import item triggers (mirrors ChatHeader). */}
      <input
        ref={importInputRef}
        type="file"
        accept=".json,application/json"
        className="u-hidden"
        aria-label={t('importConversation')}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImport(f); e.target.value = ''; }}
      />
      {compareOpen ? (
        <Suspense fallback={null}>
          <CompareView currentSessionId={sessionId} onClose={closeCompare} />
        </Suspense>
      ) : null}
      {showChannelDetails && conversationType === 'channel' ? (
        <Suspense fallback={null}>
          <ChannelManageDialog
            channelId={sessionId}
            onClose={() => setShowChannelDetails(false)}
            onChanged={() => refreshConversations()}
            onArchived={() => { setShowChannelDetails(false); void refreshConversations(); onRequestClose?.(); }}
          />
        </Suspense>
      ) : null}
      {/* Per-tab "in this conversation" lineup (ADR 0140 G2) — restores the standalone's
          always-visible active-agents tracking (CHAT-PARITY.md R1): show it once a chat has
          substance (turns) OR a real team (>1), so a fresh empty tab stays clean but any
          actual conversation shows who you're talking to. Driven by THIS tab's own
          activeAgents (no lifting to the deck). */}
      {conversationType === 'channel' ? (
        <Suspense fallback={null}><ChannelPresenceBar channelId={sessionId} /></Suspense>
      ) : hasTurns || activeAgents.lineup.length > 1 ? (
        <ConversationLineup
          variant="strip"
          lineup={activeAgents.lineup}
          currentAgentId={activeAgents.currentAgentId ?? DEFAULT_ASSISTANT_ID}
          thinkingAgentId={thinkingAgentId}
          onSwitchAgent={activeAgents.switchTo}
          onRemoveAgent={(id) => { activeAgents.remove(id); onRemoveParticipant?.(sessionId, `agent:${id}`); }}
        />
      ) : null}
      <ConversationView
        messages={session.messages}
        tenantId={tenantId}
        draftKey={`openwop-app.chat.draft:${tenantId}:${sessionId}`}
        // Parity with the standalone (ChatSidebar) — an agent-scoped tab voices live
        // replies in THAT agent's per-agent voice (ADR 0138), not the host default.
        {...(scopeAgentId ? { voiceAgentId: scopeAgentId } : {})}
        error={error}
        isSending={isSending}
        isHydrating={isHydrating}
        onPickSuggestion={(t) => onUserSubmit(t)}
        onSend={onUserSubmit}
        onCancel={cancel}
        supportsAudioInput={supportsAudioInput}
        supportsImageInput={supportsImageInput}
        supportsPdfInput={supportsPdfInput}
        composerModifiers={tabComposerModifiers}
        onResolveInterrupt={resolveInterrupt}
        onRegenerate={onRegenerate}
        onBranchFrom={(fromSeq) => { void onBranchFrom(fromSeq); }}
        onFeedback={setFeedback}
        onReconfigureBYOK={onReconfigureBYOK}
        hasOlderMessages={hasOlderMessages}
        isLoadingEarlier={isLoadingEarlier}
        onLoadEarlier={loadEarlierMessages}
        footerSlot={conveneProjectId && conveneAgentCount > 0 ? (
          <div className="u-flex u-items-center u-wrap u-gap-2 u-pad-2-4 u-fs-12 muted">
            <button type="button" className="secondary btn-sm" disabled={isSending} onClick={() => void conveneProject('')}>
              <SparklesIcon size={13} /> {t('conveneTheTeam')}
            </button>
            <span>{t('conveneHelpPrefix')}<code>@@</code>{t('conveneHelpSuffix')}</span>
          </div>
        ) : null}
      />
    </div>
  );
}

/** Memoized so a deck re-render (tab list / streaming-set change) doesn't re-render
 *  every keep-alive sibling — only the tab whose props actually changed. */
export const TabSession = memo(TabSessionImpl);
