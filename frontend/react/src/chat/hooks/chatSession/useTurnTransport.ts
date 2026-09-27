/**
 * Turn transport for the chat session (ADR 0327 P2 — the ADR's
 * `useTurnTransport`). Owns the RFC 0005 conversation exchange lifecycle:
 * the wire-turn merge/rebuild, the durable turn mirror, `send` (via the
 * long-lived conversation run + the ADR 0079 delta stream / async settle),
 * `cancel`, `emitSystem`, and `regenerate`.
 */

import { useCallback, useRef } from 'react';
import i18n from '../../../i18n/index.js';
import { formatNumber } from '../../../i18n/format.js';
import { toast } from '../../../ui/toast.js';
import { cancelRun } from '../../../client/runsClient.js';
import { subscribeToRun, type Subscription } from '../../../client/streamsClient.js';
import { setConversationRun } from '../../../client/chatSessionsClient.js';
import type { BYOKActiveConfig } from '../../../byok/lib/useBYOKConfig.js';
import { chatSessionReducer } from '../../lib/chatSessionReducer.js';
import { applyAutoTitle } from '../../lib/applyAutoTitle.js';
import { openConversationSession, sendConversationTurn, fetchTurns, turnsToBubbles, seedRunState, streamDeltaFromEvent, exchangeSettleSignal, exchangeErrorPayload, toolActivityFromEvent, titledFromEvent, recallUsedFromEvent, contextDegradedFromEvent, CONVERSATION_GATE_NODE_ID, type ConversationBubble } from '../../conversationTransport.js';
import type { ConversationTurn } from '../../conversationClient.js';
import { WopError } from '@openwop/openwop';
import type { ChatMessage, ContentPart, SendOptions } from '../../types.js';
import { messageText } from '../../types.js';
import type { ChatSessionCore } from './core.js';
import { ASYNC_SETTLE_TIMEOUT_MS, applyToolActivity, conversationMessageId } from './lib.js';

export function useTurnTransport(
  core: ChatSessionCore,
  deps: {
    persistMessage: (sessionId: string, title: string, msg: ChatMessage) => Promise<void>;
    ensureSessionInBackend: (sessionId: string, title: string) => Promise<void>;
  },
) {
  const {
    persist, session, setSession, isSending, setIsSending, setThinkingAgentIdState,
    setError, sessionRef, subRef, inFlightRunIdRef, inFlightAssistantIdRef,
    conversationRef, conversationTurnsRef, conversationCursorRef, mountLoadRef,
    animation, rehydrateWorkflowRunsRef,
  } = core;
  const { persistMessage, ensureSessionInBackend } = deps;

  // Fold tailed turns into the accumulator and rebuild the message list from the
  // wire (the source of truth). Keyed by messageId so a re-fetch is idempotent;
  // sorted by turnIndex so order is wire-authoritative, not arrival order.
  // Pure display rebuild — folds the exchange delta into the accumulator, rebuilds
  // the message list from the wire (source of truth), and RETURNS the messages new
  // to THIS merge so the caller can persist them (the durable write is a separate
  // concern — see `persistTurns`). Each turn's display id is the canonical
  // `conversationMessageId` (sanitized once, here) so the SAME id is used live, in
  // the durable store, and on a later reopen — no per-path id duality.
  // ADV-UX-5 / WF-BOA-8 — ids of user turns the ORCHESTRATOR authored. The merge
  // rebuilds every message from the wire, so an optimistic flag would be erased;
  // recording the id here and re-stamping on every rebuild is what makes the
  // marker survive the merge, the persist (it rides the message's content JSON —
  // no backend change), and a later reopen.
  const orchestratedIdsRef = useRef<Set<string>>(new Set());
  // RCL-UX-1 — ids of assistant turns that drew on twin borrowed recall (the
  // `recall_used` run event). Same shape and rationale as `orchestratedIdsRef`:
  // the merge rebuilds every message from the wire, so the stamp must be
  // re-applied on every rebuild; the persisted meta carries it across reopens.
  const twinRecalledIdsRef = useRef<Set<string>>(new Set());
  // RCL-UX-2 / RCL-7 — degradation ledgers per assistant-turn id, so the
  // reduced-context notice survives every wire rebuild (same rationale).
  const degradedIdsRef = useRef<Map<string, string[]>>(new Map());
  const boundIdSet = (set: Set<string> | Map<string, unknown>): void => {
    if (set.size < 1000) return;
    const iter = set.keys();
    for (let i = 0; i < 200; i += 1) {
      const oldest = iter.next();
      if (oldest.done) break;
      set.delete(oldest.value);
    }
  };

  const mergeConversationTurns = useCallback((incoming: readonly ConversationTurn[], orchestrated = false, recallUsed = false, degradedBlocks: string[] | null = null): ChatMessage[] => {
    // The ids new to THIS merge (the exchange delta), in the canonical scheme.
    const incomingIds = new Set(
      incoming.map((t) => t?.messageId).filter((id): id is string => typeof id === 'string').map(conversationMessageId),
    );
    for (const t of incoming) {
      if (t && typeof t.messageId === 'string') conversationTurnsRef.current.set(t.messageId, t);
    }
    const sorted = [...conversationTurnsRef.current.values()].sort((a, b) => a.turnIndex - b.turnIndex);
    // Resolve each turn's raw agentId (wire `agent.agentId`/`from`) to its lineup
    // row so the bubble can attribute by name + @handle, not a raw id "blob".
    const lineup = sessionRef.current.activeAgents?.lineup ?? [];
    const mapped: ChatMessage[] = turnsToBubbles(sorted).map((b: ConversationBubble) => {
      const rawId = b.agentPersona; // turnsToBubbles set this to agent.agentId ?? from
      const row = rawId ? lineup.find((a) => a.agentId === rawId) : undefined;
      const base = {
        // Canonical id: the wire turn id (`${runId}:gate:0:N:role`) sanitized to the
        // store's pattern — identical live, persisted, and on reopen (no id-flip).
        id: conversationMessageId(b.id), content: b.content, createdAt: new Date().toISOString(),
        ...(rawId ? { agentId: rawId } : {}),
        ...(row?.persona ? { agentPersona: row.persona } : {}),
        ...(row?.slug ? { agentSlug: row.slug } : {}),
      };
      // A run an agent tool ignited this turn. Seeded as `running` with only the
      // runId known — `rehydrateWorkflowRuns` then reconciles the authoritative
      // node/terminal state from the run's event log and attaches the live
      // stream, so a run that FAILS (e.g. the Factory's fail-closed refusal of
      // demo research sources) surfaces its error here instead of the agent's
      // narration being the user's only, and possibly false, signal.
      if (b.role === 'workflow_run' && b.runRef) {
        // The dispatching tool names the workflow (host/turnRunDispatch.ts); fall
        // back to its id, then to a translated generic label. Never blank — the
        // bubble header and the rail render this string directly.
        // A translation for this workflow id, when the catalog has one (empty ⇒ fall
        // back to the backend's English display default).
        const localized = b.runRef.workflowId
          ? i18n.t(`chat:workflowNames.${b.runRef.workflowId}`, { defaultValue: '' })
          : '';
        const workflowRun = seedRunState(b.runRef, i18n.t('chat:workflowRunGeneric'), new Date().toISOString(), localized);
        return { ...base, role: 'workflow_run' as const, content: workflowRun.workflowName, workflowRun };
      }
      const role = b.role as 'user' | 'assistant';
      // RCL-UX-1/-2 — re-stamp the recall + degradation markers on every
      // rebuild (wire turns carry no meta; the durable message row persists
      // them for reopens).
      const meta: NonNullable<ChatMessage['meta']> = {};
      if (role === 'assistant' && twinRecalledIdsRef.current.has(base.id)) meta.twinRecalled = true;
      const dg = role === 'assistant' ? degradedIdsRef.current.get(base.id) : undefined;
      if (dg) meta.degradedBlocks = dg;
      // ADR 0665 D4 — carried on the WIRE TURN itself (not an id set like the two
      // above), so it needs no re-stamp bookkeeping and survives a reopen for free.
      if (role === 'assistant' && b.noContribution) meta.noContribution = true;
      return {
        ...base, role,
        ...(role === 'user' && orchestratedIdsRef.current.has(base.id) ? { orchestrated: true as const } : {}),
        ...(Object.keys(meta).length > 0 ? { meta } : {}),
      };
    });
    if (orchestrated) {
      // The newest INCOMING user turn is this send's hand-off prompt.
      const mine = mapped.filter((m) => m.role === 'user' && incomingIds.has(m.id)).pop();
      if (mine) {
        // M6 rider — BOUNDED. This set is never cleared on `/clear` or a session
        // switch (it is local to this hook; the sibling `conversationTurnsRef` is
        // owned by `core.ts` and cleared from `useSessionPersistence`), so it grew
        // for the life of the mount. It cannot MIS-attribute across sessions —
        // every id embeds the run id (`${runId}:gate:0:N:role`) — so the residual
        // was memory, not correctness. Sets keep insertion order, so the oldest
        // ids go first; a long-lived tab now costs a bounded slice instead of an
        // unbounded one. Dropping an old id only loses the re-stamp on a REBUILD
        // of a turn that far back, and the durable message row still carries it.
        if (orchestratedIdsRef.current.size >= 1000) {
          const iter = orchestratedIdsRef.current.values();
          for (let i = 0; i < 200; i += 1) {
            const oldest = iter.next();
            if (oldest.done) break;
            orchestratedIdsRef.current.delete(oldest.value);
          }
        }
        orchestratedIdsRef.current.add(mine.id);
        mine.orchestrated = true;
      }
    }
    if (recallUsed || degradedBlocks) {
      // The newest INCOMING assistant turn is the reply this exchange's
      // recall_used / context_degraded events describe (one exchange, one
      // assistant turn).
      const mine = mapped.filter((m) => m.role === 'assistant' && incomingIds.has(m.id)).pop();
      if (mine) {
        if (recallUsed) {
          boundIdSet(twinRecalledIdsRef.current);
          twinRecalledIdsRef.current.add(mine.id);
          mine.meta = { ...(mine.meta ?? {}), twinRecalled: true };
        }
        if (degradedBlocks) {
          boundIdSet(degradedIdsRef.current);
          degradedIdsRef.current.set(mine.id, degradedBlocks);
          mine.meta = { ...(mine.meta ?? {}), degradedBlocks };
        }
      }
    }
    setSession((s) => ({ ...s, messages: mapped }));
    // Attach the live stream to any run bubble this merge introduced. Without
    // this the bubble renders once and then FREEZES at "running" — it would
    // never show completion, failure, or an approval gate, which is the same
    // "the chat says it's fine, reality disagrees" failure the seam removes.
    // `rehydrateWorkflowRuns` is idempotent (it skips already-subscribed runs),
    // so re-running it on every merge is safe.
    if (mapped.some((m) => m.role === 'workflow_run')) {
      rehydrateWorkflowRunsRef.current({ ...sessionRef.current, messages: mapped });
    }
    return mapped.filter((m) => incomingIds.has(m.id) && (m.role === 'user' || m.role === 'assistant'));
  }, [conversationTurnsRef, sessionRef, setSession, rehydrateWorkflowRunsRef]);

  // Mirror newly-arrived conversation turns into the durable chat-message store so
  // reopening a past chat from the rail (loadSessionFromBackend reads that store)
  // isn't blank. Best-effort, like the @mention workflow_run path; ephemeral
  // (persist:false) chats no-op inside persistMessage; the canonical-id dedup
  // (persistedIdsRef) keeps a re-merge / reload from re-POSTing a stored id (the
  // backend 409s on duplicates). SEQUENTIAL (await each before the next): the store
  // stamps `created_at` server-side and orders by it, so two CONCURRENT appends
  // could land the agent turn before its user turn (a reopened thread would show
  // the reply above the prompt). `msgs` is turnIndex-sorted, so awaiting in order
  // keeps the timestamps monotonic. persistMessage never rejects.
  const persistTurns = useCallback((msgs: readonly ChatMessage[]): void => {
    if (msgs.length === 0) return;
    const sid = sessionRef.current.id;
    const stitle = sessionRef.current.title;
    void (async () => {
      for (const m of msgs) await persistMessage(sid, stitle, m);
    })();
  }, [persistMessage, sessionRef]);

  const sendViaConversation = useCallback(async (text: string, config: BYOKActiveConfig, opts?: SendOptions): Promise<void> => {
    // Multimodal turn: attachments ride the exchange as ContentPart[] (turn content
    // is opaque on the RFC 0005 wire; the backend passes real parts to dispatch).
    // Text-only stays a plain string. An attachment-only send (voice clip, image,
    // no typed text) is a VALID turn — it previously 422'd because the attachments
    // were silently dropped here and the turn went out with empty content.
    const turnContent: string | ContentPart[] = opts?.attachments?.length
      ? [...(text.trim().length > 0 ? [{ type: 'text' as const, text }] : []), ...opts.attachments]
      : text;
    const optimistic: ChatMessage = {
      id: crypto.randomUUID(), role: 'user', content: turnContent, createdAt: new Date().toISOString(),
      ...(opts?.orchestrated ? { orchestrated: true } : {}),
    };
    // The conversation `exchange` is synchronous and can run for tens of seconds
    // (a reasoning advisor), so show an optimistic "thinking" bubble attributed
    // to the addressed agent — otherwise the feed freezes with no who/what. It's
    // replaced by the real turn on success (mergeConversationTurns rebuilds from
    // the wire) and removed in the catch on failure.
    const thinkingId = crypto.randomUUID();
    const thinkingRow = opts?.activeAgentId ? sessionRef.current.activeAgents?.lineup.find((a) => a.agentId === opts.activeAgentId) : undefined;
    const thinking: ChatMessage = {
      id: thinkingId, role: 'assistant', content: '', isStreaming: true, createdAt: new Date().toISOString(),
      ...(opts?.activeAgentId ? { agentId: opts.activeAgentId } : {}),
      ...(thinkingRow?.persona ? { agentPersona: thinkingRow.persona } : {}),
      ...(thinkingRow?.slug ? { agentSlug: thinkingRow.slug } : {}),
    };
    setSession((s) => ({ ...s, title: s.messages.length === 0 ? text.slice(0, 60) : s.title, messages: [...s.messages, optimistic, thinking] }));
    // Stable idempotency key for THIS send: a double-submit / retry reuses it so
    // the backend returns the existing turns instead of duplicating them (ADR 0067).
    const exchangeKey = crypto.randomUUID();
    // ADR 0079 §Phase 2 — tail the run SSE so the reply's `output.chunk`
    // deltas type into the optimistic bubble live, then reconcile to the wire turn.
    let streamSub: Subscription | null = null;
    // ADR 0079 §Phase 3 — fallback timer for the async settle-wait (cleared in finally).
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Reuse this session's open conversation run across reloads (the suspended
      // run survives restarts) so the agent keeps server-side context. Only open
      // a NEW one when neither the in-memory ref nor the persisted id exists —
      // opening with the SAME provider/model/credential the per-turn chat uses.
      if (!conversationRef.current) {
        const persistedRunId = sessionRef.current.conversationRunId;
        if (persistedRunId) {
          conversationRef.current = { runId: persistedRunId, nodeId: CONVERSATION_GATE_NODE_ID };
          // Reload recovery: seed the turn accumulator + cursor from the run's
          // events so the first exchange tails forward (and dedups) instead of
          // rescanning. Silent (no setSession) — the persisted local thread stays
          // visible until the exchange rebuilds it from the wire.
          if (conversationCursorRef.current === 0 && conversationTurnsRef.current.size === 0) {
            try {
              const hydrated = await fetchTurns(persistedRunId, 0);
              conversationCursorRef.current = hydrated.lastSeq;
              for (const t of hydrated.turns) {
                if (t && typeof t.messageId === 'string') conversationTurnsRef.current.set(t.messageId, t);
              }
            } catch { /* best-effort hydration — a fresh exchange still works */ }
          }
        } else {
          conversationRef.current = await openConversationSession({ provider: config.provider, model: config.model, credentialRef: config.credentialRef, chatSessionId: sessionRef.current.id, ...(opts?.webSearch ? { webSearch: true } : {}) });
          const openedRunId = conversationRef.current.runId;
          conversationTurnsRef.current = new Map();
          conversationCursorRef.current = 0;
          setSession((s) => ({ ...s, conversationRunId: openedRunId }));
          // Persist the run id server-side (ADR 0067 continuity) so reopening the
          // chat on another device / after the local blob is gone reuses THIS
          // suspended run instead of orphaning it. Ensure the session row exists
          // first (the PUT 404s on an unknown session); both calls are idempotent.
          // Best-effort + persisted-mode only (ephemeral chats keep no BE record).
          if (persist) {
            const sid = sessionRef.current.id;
            const stitle = sessionRef.current.title;
            void (async () => {
              await ensureSessionInBackend(sid, stitle);
              await setConversationRun(sid, openedRunId).catch((e) => {
                // Continuity silently degrades to "fresh run per reopen" (pre-#586
                // behavior) if this never lands — surface it for diagnosis rather
                // than failing the turn.
                console.warn('[chat] failed to persist conversationRunId (reopen continuity degraded)', e);
              });
            })();
          }
        }
      }
      const { runId, nodeId } = conversationRef.current;
      // Stream this exchange's deltas into the optimistic thinking bubble. The
      // animation batcher flushes into `inFlightAssistantIdRef`; point it at the
      // placeholder. Guard on `sequence > startSeq` because the run SSE replays
      // from seq 0 on connect — without it, a prior exchange's deltas would
      // re-type into this bubble. Best-effort: the exchange below reconciles the
      // authoritative turn regardless, so a missed/closed stream just means no
      // live tokens, never a wrong reply.
      inFlightAssistantIdRef.current = thinkingId;
      const startSeq = conversationCursorRef.current;
      // ADR 0079 §Phase 3 — when the backend runs the exchange async, the POST
      // acks BEFORE the reply is emitted (so it rides the SSE past the ~60s CDN
      // ceiling). Resolve `settled` when the agent's authoritative turn — or a
      // terminal error — lands on the stream; the post-ack branch awaits it.
      let resolveSettle: ((s: 'agent' | 'error') => void) | null = null;
      const settled = new Promise<'agent' | 'error'>((res) => { resolveSettle = res; });
      // Holder (not a bare `let`) so control-flow analysis re-widens it after the
      // `await` below — a bare let assigned only inside the closure narrows to `null`.
      const asyncErr: { value: { code?: string; message?: string } | null } = { value: null };
      // RCL-UX-1 — holder (same narrowing rationale as `asyncErr`): flipped by
      // the event stream, read after the awaits below to stamp the reply.
      const recallUsed = { value: false };
      // RCL-UX-2 / RCL-7 — the turn's degradation ledger, stamped onto the
      // settled reply so the acting user finally sees what the model was told.
      const degraded = { value: null as string[] | null };
      streamSub = subscribeToRun(runId, {
        modes: ['updates'],
        onEvent: (ev) => {
          const delta = streamDeltaFromEvent(ev, startSeq);
          if (delta !== null) { animation.push(delta); return; }
          // RCL-UX-1 — this exchange drew on the caller's shared memories.
          if (recallUsedFromEvent(ev, startSeq)) { recallUsed.value = true; return; }
          const degradedBlocks = contextDegradedFromEvent(ev, startSeq);
          if (degradedBlocks) { degraded.value = degradedBlocks; return; }
          // ADR 0089 Phase 2 — render the agent's live tool progress into the
          // in-flight bubble's existing `agentEvents.toolCalls` cards.
          const activity = toolActivityFromEvent(ev, startSeq);
          if (activity) { applyToolActivity(thinkingId, activity, setSession); return; }
          // ADR 0151 — the auto-titler named this conversation; swap the substring
          // placeholder live. A manual rename ('user' provenance) is never emitted,
          // so this only ever replaces a default/auto title.
          const autoTitle = titledFromEvent(ev, startSeq);
          if (autoTitle) { applyAutoTitle(autoTitle, setSession); return; } // + SR announcement (ATU-1)
          const signal = exchangeSettleSignal(ev, startSeq);
          if (signal === 'error') { asyncErr.value = exchangeErrorPayload(ev); resolveSettle?.('error'); }
          else if (signal === 'agent') resolveSettle?.('agent');
        },
        onError: () => { /* best-effort streaming — the exchange still reconciles */ },
      });
      // Tail from the cursor: fetch only events past what we've folded, then merge.
      const { turns, lastSeq, notice } = await sendConversationTurn(
        runId, nodeId,
        { content: turnContent, exchangeKey, ...(opts?.activeAgentId ? { to: opts.activeAgentId } : {}), ...(opts?.webSearch !== undefined ? { webSearch: opts.webSearch } : {}), ...(opts?.model ? { model: opts.model } : {}), ...(opts?.provider ? { provider: opts.provider } : {}), ...(opts?.permissionMode ? { permissionMode: opts.permissionMode } : {}) },
        conversationCursorRef.current,
      );
      // ADR 0178 — the turn SUCCEEDED but the org is approaching its BYOK daily
      // spend cap. Surface a non-blocking, dismissible warning toast (never block
      // the turn); auto-coalesced so a run of near-cap turns shows one toast.
      if (notice?.code === 'byok_budget_warning') {
        toast.warning(i18n.t('chat:byokBudgetWarning', {
          usedPct: Math.round(notice.usedPct),
          cap: formatNumber(notice.cap),
        }));
      }
      // XCH-GRP-3 — the mentioned agent declared a DEEP investigation, but this
      // room spent its deep-run budget for the window, so the turn degraded to a
      // normal reply. The answer still arrived; say why there's no run bubble
      // (a silent degrade would read as "the investigation just didn't happen").
      if (notice?.code === 'deep_run_budget_exceeded') {
        toast.info(i18n.t('chat:deepRunBudgetExceeded', { limit: notice.limit }));
      }
      // A "synchronous" exchange is one whose authoritative AGENT turn is already
      // on the wire — detect THAT, not `lastSeq > cursor`. Under the async path
      // (ADR 0079 §Phase 3 / the ADR 0089 tool loop) the POST acks BEFORE the
      // reply, but transient `output.chunk` deltas have already bumped the
      // sequence; the old `lastSeq > cursor` heuristic mis-read those chunks as a
      // completed turn, advanced the cursor past them, and merged an EMPTY turn
      // set — silently dropping that reply. Across a board cadence (one exchange
      // per advisor) several replies (and the opening question) vanished this way.
      const hasNewAgentTurn = turns.some(
        (t) => t.role === 'agent' && !conversationTurnsRef.current.has(t.messageId),
      );
      if (hasNewAgentTurn) {
        // Synchronous exchange (default) — the user+agent turns are already on
        // the wire; reconcile immediately.
        animation.flush();
        conversationCursorRef.current = lastSeq;
        persistTurns(mergeConversationTurns(turns, opts?.orchestrated === true, recallUsed.value, degraded.value));
      } else {
        // Async ack — the reply lands later on the SSE. Wait for the settle
        // signal (or a generous timeout matching the backend dispatch budget)
        // BEFORE refetching + merging, so the optimistic user/thinking bubbles
        // aren't erased by a merge over a still-empty wire. NOTE: the cursor is
        // deliberately NOT advanced here — the refetch below must restart from the
        // SAME cursor so it re-reads past the transient chunk events and captures
        // the authoritative `conversation.exchanged` turns.
        const outcome = await Promise.race([
          settled,
          new Promise<'timeout'>((res) => { settleTimer = setTimeout(() => res('timeout'), ASYNC_SETTLE_TIMEOUT_MS); }),
        ]);
        animation.flush();
        if (outcome === 'error') {
          // No POST 4xx to catch — rethrow the terminal event so the shared
          // catch below renders the classified error bubble (preserving the code).
          throw Object.assign(new Error(asyncErr.value?.message ?? i18n.t('chat:replyFailed')), { code: asyncErr.value?.code });
        }
        const tail = await fetchTurns(runId, conversationCursorRef.current);
        if (tail.lastSeq <= conversationCursorRef.current) {
          throw new Error(i18n.t('chat:replyTimedOut'));
        }
        conversationCursorRef.current = tail.lastSeq;
        persistTurns(mergeConversationTurns(tail.turns, opts?.orchestrated === true, recallUsed.value, degraded.value));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Preserve the wire error CODE so the ErrorCard classifier fires the right
      // card + CTA (e.g. credential_unavailable → "Open BYOK settings"). Without
      // this, every exchange error collapsed to a generic "Something went wrong".
      // Prefer the wire envelope code; fall back to the `.code` an async terminal
      // (`openwop-app.ai.message-error`) rethrow carries (no WopError envelope in that path).
      const code = err instanceof WopError
        ? err.envelope?.error
        : (err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
            ? (err as { code: string }).code
            : undefined);
      setError(message);
      // Self-heal ONLY when the run itself is dead (closed/cancelled/gone) so the
      // NEXT send opens fresh. Gate on the actual wire CODE — not a message regex:
      // a credential_unavailable message literally contains "expired", which the
      // old regex misread as a dead run and needlessly tore down the conversation.
      const DEAD_RUN_CODES = new Set(['interrupt_already_resolved', 'interrupt_gone', 'run_not_found']);
      const isDeadRun = code ? DEAD_RUN_CODES.has(code) : /resolved|gone|not.?found/i.test(message);
      if (isDeadRun) {
        conversationRef.current = null;
        conversationTurnsRef.current = new Map();
        conversationCursorRef.current = 0;
        setSession((s) => ({ ...s, conversationRunId: undefined }));
      }
      // Mirror the per-turn path's error UX: keep the user's message and append
      // an assistant error bubble (ErrorCard classifies the code, e.g. a BYOK
      // prompt), rather than leaving a dangling user turn with no reply.
      const errBubble: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '',
        createdAt: new Date().toISOString(),
        meta: { error: { code: code ?? 'conversation_exchange_failed', message } },
      };
      // Drop the optimistic "thinking" bubble (the reply never landed) and append
      // the error bubble, keeping the user's message.
      setSession((s) => ({ ...s, messages: [...s.messages.filter((m) => m.id !== thinkingId), errBubble] }));
    } finally {
      // Always tear down the delta stream + release the animation target.
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      streamSub?.close();
      inFlightAssistantIdRef.current = null;
    }
    // `animation` is the token batcher from useApplyAnimation; its push/flush are
    // stable useCallbacks and the object is only used synchronously during a send,
    // so it's intentionally not a dependency (adding the fresh-each-render object
    // would recreate this handler every render for no behavioral gain).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mergeConversationTurns, persistTurns, persist, ensureSessionInBackend]);

  const send = useCallback(async (text: string, config: BYOKActiveConfig, opts?: SendOptions) => {
    // Backend-keyed tab (ADR 0140): if a turn is fired before the one-shot mount-load
    // has hydrated the thread, wait for it. Otherwise this send would open a fresh
    // conversation run that `loadSessionFromBackend` then resets (it nulls
    // `conversationRef`), stranding the turn against the wrong run.
    if (mountLoadRef.current) await mountLoadRef.current;
    setIsSending(true);
    setThinkingAgentIdState(opts?.activeAgentId ?? null);
    setError(null);

    // The RFC 0005 conversation primitive is the SOLE chat transport. The
    // per-turn `openwop-app.chat.turn` fallback was retired in ADR 0067 Phase 6
    // (parity + telemetry clean); the backend workflow is kept ONLY so historical
    // per-turn runs still replay/fork (the wire contract), not for new sends.
    await sendViaConversation(text, config, opts);
    setIsSending(false);
  }, [sendViaConversation, mountLoadRef, setError, setIsSending, setThinkingAgentIdState]);

  const cancel = useCallback(async () => {
    // NOTE: `inFlightRunIdRef` is populated only by the @mention workflow-run path
    // (`runWorkflowMention`); `sendViaConversation` does not set it (cancelling the
    // long-lived conversation run would tear down the whole thread, not the one
    // in-flight exchange). So Stop is a no-op mid-chat-exchange — aborting a single
    // conversation `exchange` is a tracked follow-up (ADR 0067), not part of Phase 6.
    const runId = inFlightRunIdRef.current;
    if (!runId) return;
    // Close the SSE subscription immediately so further deltas don't
    // arrive after the user clicked Stop. Flush any buffered animation
    // tail first so it lands in the bubble. The BE's cancelRun call
    // races in parallel — whichever finishes first wins.
    animation.flush();
    subRef.current?.close();
    subRef.current = null;
    try {
      await cancelRun(runId, 'cancelled by user from chat');
    } catch (err) {
      // Cancel failed (run already terminal, network blip, etc.) —
      // still surface a friendly cancellation in the bubble.
      setError(err instanceof Error ? err.message : String(err));
    }
    const assistantId = inFlightAssistantIdRef.current;
    if (assistantId) {
      setSession((s) => ({
        ...s,
        messages: s.messages.map((m) => m.id === assistantId ? {
          ...m,
          isStreaming: false,
          meta: { ...(m.meta ?? {}), error: { code: 'cancelled', message: i18n.t('chat:stoppedByUser') }, runId: runId },
        } : m),
      }));
    }
    inFlightRunIdRef.current = null;
    inFlightAssistantIdRef.current = null;
    setIsSending(false);
    // animation's methods are ref-backed useCallbacks (stable); cancel reads
    // only refs + setIsSending. No reactive deps. (GAP-ANALYSIS code-review)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emitSystem = useCallback((content: string) => {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'system',
      content,
      createdAt: new Date().toISOString(),
    };
    setSession((s) => chatSessionReducer(s, { type: 'appendMessage', message: msg }));
  }, [setSession]);

  // `send` is declared above but referenced in the regenerate closure;
  // keep this useCallback inside the hook so it picks up the latest
  // `session`/`send` bindings on each render.
  //
  // APPEND, don't replace (architect verdict): the RFC 0005 conversation run is an
  // append-only, linear log (turns are immutable; replay re-folds them), and the
  // spec deliberately rejected in-conversation branching for v1.x (RFC 0005 §195).
  // The old slice-and-replace fought that grain — it dropped the assistant bubble
  // LOCALLY while the run event log + the chat-message store kept it, so the turn
  // resurfaced on the next merge (live) and on hydration (reload). "Try again" is
  // therefore a fresh exchange of the same prompt, APPENDED — correct across every
  // persistence/restore/hydration path, no drift, no tombstone, no wire change.
  // (True "compare answers" is the spec's sibling-conversation mechanism — a
  // separate future feature, not this button.)
  const regenerate = useCallback(async (messageId: string, config: BYOKActiveConfig) => {
    if (isSending) return; // a turn is already in flight
    const idx = session.messages.findIndex((m) => m.id === messageId);
    if (idx < 1) return;
    const assistant = session.messages[idx];
    const prior = session.messages[idx - 1];
    if (!assistant || assistant.role !== 'assistant') return;
    if (!prior || prior.role !== 'user') return;
    const priorText = messageText(prior);
    if (!priorText) return;
    await send(priorText, config);
  }, [isSending, session.messages, send]);

  return { send, cancel, emitSystem, regenerate };
}
