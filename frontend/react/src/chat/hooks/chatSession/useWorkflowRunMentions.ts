/**
 * `@mention` workflow-run machinery for the chat session (ADR 0327 P2 — a
 * FIFTH composed hook; the ADR's four-hook map missed this ~350-line concern,
 * recorded as a survey correction). Owns: the self-healing run SSE
 * subscription, reopen rehydration, the mount-time stuck/terminal run
 * reconciliation effect, dispatch (`runWorkflowMention`), cancel, and the
 * unmount teardown of every workflow sub.
 */

import { useCallback, useEffect, useRef } from 'react';
import i18n from '../../../i18n/index.js';
import { cancelRun, createRun, getRun } from '../../../client/runsClient.js';
import { errorReasonOf } from '../../../client/classifyHttpError.js';
import { subscribeToRun, type Subscription } from '../../../client/streamsClient.js';
import { listOpenInterrupts } from '../../../client/interruptsClient.js';
import { getSavedWorkflow } from '../../../builder/persistence/localStore.js';
import { getWorkflowRunInputs, type RunVariable } from '../../../workflows/workflowsClient.js';
import type { RunConfigurable } from '@openwop/openwop';
import { isCredentialRefVariable } from '../../../ui/RunInputsForm.js';
import { getActiveConfig } from '../../../byok/lib/byokClient.js';
// serializeWorkflow + registerWorkflow are lazy-imported at their one call site
// (running a saved workflow) so builder/palette/catalogRegistry stays out of the
// first-paint chat entry chunk.
import type { WorkflowMentionEntry } from '../../lib/workflowMentions.js';
import type { ChatMessage, ChatSession, WorkflowRunState } from '../../types.js';
import { makeWorkflowRunHandlers, reconcileWorkflowRunFromLog, type WorkflowRunHandlerContext } from '../workflowRunSubscription.js';
import type { ChatSessionCore } from './core.js';
import { SAMPLE_DEFAULT_INPUTS } from './lib.js';

export function useWorkflowRunMentions(
  core: ChatSessionCore,
  deps: {
    persistMessage: (sessionId: string, title: string, msg: ChatMessage) => Promise<void>;
    persistOrUpdateMessage: (sessionId: string, title: string, msg: ChatMessage) => Promise<void>;
  },
) {
  const {
    session, setSession, setError, backendKeyed, subRef, workflowSubsRef,
    rehydrateWorkflowRunsRef, closeWorkflowSub, closeAllWorkflowSubs,
  } = core;
  const { persistMessage, persistOrUpdateMessage } = deps;

  useEffect(() => () => {
    subRef.current?.close();
    closeAllWorkflowSubs();
  }, [closeAllWorkflowSubs, subRef]);

  // Hydration poll: any persisted workflow_run with status='running' is
  // stale (the SSE subscription died on the previous tab/reload). Fetch
  // a one-shot snapshot + open-interrupts list per stuck run so we can
  // either reconcile to a terminal state OR re-surface a missed
  // approval card inline. The ref guard ensures we only walk the
  // initial session — subsequent session changes drive their own SSE.
  const didHydrateRef = useRef(false);
  useEffect(() => {
    if (didHydrateRef.current) return;
    // Backend-keyed tab (ADR 0140): the initial session is an EMPTY placeholder; the
    // real thread arrives async via the mount-load below. Reconciling the empty
    // placeholder would flip `didHydrate` and never cover the loaded messages — so
    // wait. This effect re-fires on `session` change, running once the load lands.
    // (A genuinely empty conversation stays skipped, which is correct — nothing to
    // reconcile.)
    if (backendKeyed && session.messages.length === 0) return;
    didHydrateRef.current = true;
    let cancelled = false;
    // Re-attach LIVE to any non-terminal workflow_run restored from localStorage
    // on this initial load (F5): rebuild cards from the log + resume SSE so the
    // run keeps streaming and the HITL card stays actionable — not frozen at the
    // persisted snapshot. The one-shot reconcile loops below still run (they also
    // flag a 404'd run unavailable); rehydrate skips runs it already re-subscribed.
    rehydrateWorkflowRunsRef.current(session);
    void (async () => {
      const stuck = session.messages.filter(
        (m): m is ChatMessage & { workflowRun: WorkflowRunState } =>
          m.role === 'workflow_run'
          && m.workflowRun?.status === 'running'
          && typeof m.workflowRun?.runId === 'string',
      );
      for (const m of stuck) {
        const runId = m.workflowRun.runId;
        if (!runId) continue;
        try {
          const snap = await getRun(runId);
          if (cancelled) return;
          const next: WorkflowRunState['status'] | null = (() => {
            switch (snap.status) {
              case 'completed': return 'completed';
              case 'failed':    return 'failed';
              case 'cancelled': return 'cancelled';
              default: return null;
            }
          })();
          if (next) {
            setSession((s) => ({
              ...s,
              messages: s.messages.map((mm) => mm.id === m.id && mm.workflowRun ? {
                ...mm,
                workflowRun: {
                  ...mm.workflowRun,
                  status: next,
                  ...(next === 'failed' ? { error: { code: 'reconciled', message: 'Run failed; details in /runs.' } } : {}),
                },
              } : mm),
            }));
            continue;
          }
          // Not terminal — check for open interrupts so the approval
          // card resurfaces if SSE delivery missed the `node.suspended`
          // event (page reload, dropped connection, etc.).
          try {
            const open = await listOpenInterrupts(runId);
            if (cancelled) return;
            if (open.length > 0) {
              setSession((s) => ({
                ...s,
                messages: s.messages.map((mm) => mm.id === m.id ? { ...mm, activeInterrupts: [...open] } : mm),
              }));
            }
          } catch (e) {
            // Best-effort resurfacing, but no longer silent (GAP-ANALYSIS E6):
            // a failed listOpenInterrupts left a run stuck with a phantom
            // spinner and no signal. Surface it for diagnosis.
            console.warn('[chat] could not resurface open interrupts for run', runId, e);
          }
        } catch (err) {
          // Distinguish 404 (run record gone — account-deleted, retention
          // sweep, fresh DB) from transient errors (5xx, network drop).
          // Only 404 flips the `runUnavailable` flag permanently; other
          // errors leave the bubble as-is so the next reload can recover.
          if (err instanceof Error && /\b404\b/.test(err.message)) {
            setSession((s) => ({
              ...s,
              messages: s.messages.map((mm) => mm.id === m.id && mm.workflowRun ? {
                ...mm,
                workflowRun: { ...mm.workflowRun, runUnavailable: true },
              } : mm),
            }));
          }
          /* other errors: leave the bubble as-is; user can refresh later */
        }
      }

      // Second pass — probe terminal-status workflow_run messages that
      // haven't been validated yet. They render fine from local persisted
      // state, but action links ("Open run", "View") would 404 if the
      // BE no longer has the row. One probe per message per session-load.
      const terminal = session.messages.filter(
        (m): m is ChatMessage & { workflowRun: WorkflowRunState } =>
          m.role === 'workflow_run'
          && m.workflowRun?.runId != null
          && m.workflowRun.runUnavailable === undefined
          && (m.workflowRun.status === 'completed'
              || m.workflowRun.status === 'failed'
              || m.workflowRun.status === 'cancelled'),
      );
      for (const m of terminal) {
        const runId = m.workflowRun.runId;
        if (!runId) continue;
        try {
          await getRun(runId);
          if (cancelled) return;
          // Mark as confirmed-available so we don't re-probe next reload.
          setSession((s) => ({
            ...s,
            messages: s.messages.map((mm) => mm.id === m.id && mm.workflowRun ? {
              ...mm,
              workflowRun: { ...mm.workflowRun, runUnavailable: false },
            } : mm),
          }));
        } catch (err) {
          if (cancelled) return;
          if (err instanceof Error && /\b404\b/.test(err.message)) {
            setSession((s) => ({
              ...s,
              messages: s.messages.map((mm) => mm.id === m.id && mm.workflowRun ? {
                ...mm,
                workflowRun: { ...mm.workflowRun, runUnavailable: true },
              } : mm),
            }));
          }
          /* transient errors: leave undefined so the next reload re-probes */
        }
      }
    })();
    return () => { cancelled = true; };
  }, [session, backendKeyed, rehydrateWorkflowRunsRef, setSession]);

  /** Update a single `workflow_run` message's `workflowRun` state. */
  const updateWorkflowRun = useCallback((
    messageId: string,
    patch: (prev: WorkflowRunState) => WorkflowRunState,
  ): void => {
    setSession((s) => ({
      ...s,
      messages: s.messages.map((m) => {
        if (m.id !== messageId || !m.workflowRun) return m;
        return { ...m, workflowRun: patch(m.workflowRun) };
      }),
    }));
  }, [setSession]);

  /** Open a SELF-HEALING SSE subscription for a workflow_run message: on a stream
   *  timeout/error, reconcile from the authoritative event log then re-subscribe
   *  unless the run terminated (retries bounded when the backend is unreachable;
   *  a successful poll resets the budget so a merely-idle HITL run heals forever).
   *  The identity guard ignores a stale timeout fired after the user cancelled /
   *  switched sessions / a newer sub replaced this one. Shared by the live dispatch
   *  path AND reopen rehydration. */
  const subscribeWorkflowRun = useCallback((ctx: WorkflowRunHandlerContext): void => {
    const { runId, runMsgId } = ctx;
    const MAX_HEAL_FAILURES = 5;
    let healFailures = 0;
    const openSub = (): void => {
      const sub = subscribeToRun(runId, {
        modes: ['updates'],
        idleTimeoutMs: 5 * 60_000,
        absoluteTimeoutMs: 30 * 60_000,
        ...makeWorkflowRunHandlers(ctx),
        onTimeout: () => { void heal(sub); },
        onError: () => { void heal(sub); },
      });
      workflowSubsRef.current.set(runMsgId, sub);
    };
    const heal = async (deadSub: Subscription): Promise<void> => {
      if (workflowSubsRef.current.get(runMsgId) !== deadSub) return;
      const { terminal, polled } = await reconcileWorkflowRunFromLog(ctx);
      if (terminal) return; // reconcile finalized + closed the sub
      if (polled) healFailures = 0;
      else if (++healFailures > MAX_HEAL_FAILURES) return;
      if (workflowSubsRef.current.get(runMsgId) !== deadSub) return;
      openSub();
    };
    openSub();
  }, [workflowSubsRef]);

  /** Re-attach to every NON-terminal workflow_run in a (re)loaded session: rebuild
   *  its node cards + HITL interrupt from the authoritative event log, then RESUME
   *  live streaming unless it already finished. Makes a chat reopened from the rail
   *  continue live — the suspended HITL card is refreshed + actionable and
   *  post-resume progress streams, instead of freezing at the persisted snapshot.
   *  Idempotent: skips runs already subscribed (a same-browser current session keeps
   *  its live subs). */
  const rehydrateWorkflowRuns = useCallback((sess: ChatSession): void => {
    for (const m of sess.messages) {
      if (m.role !== 'workflow_run') continue;
      const wf = m.workflowRun;
      const runId = wf?.runId;
      if (!runId) continue;
      if (wf.status === 'completed' || wf.status === 'failed' || wf.status === 'cancelled') continue;
      if (workflowSubsRef.current.has(m.id)) continue; // already live
      const ctx: WorkflowRunHandlerContext = {
        runId, runMsgId: m.id, setSession, persistMessage: persistOrUpdateMessage,
        sessionId: sess.id, sessionTitle: sess.title, updateWorkflowRun, closeWorkflowSub,
      };
      void (async () => {
        // Rebuild cards + interrupts from the log first; subscribe only if the run
        // is still live (reconcile finalizes + skips the sub for a terminal run).
        const { terminal } = await reconcileWorkflowRunFromLog(ctx);
        if (!terminal && !workflowSubsRef.current.has(m.id)) subscribeWorkflowRun(ctx);
      })();
    }
    // closeWorkflowSub is a stable hoisted fn; setSession is stable. (matches the
    // runWorkflowMention pattern.)
  }, [persistOrUpdateMessage, updateWorkflowRun, subscribeWorkflowRun, closeWorkflowSub, setSession, workflowSubsRef]);

  // Expose rehydrateWorkflowRuns to the earlier-declared mount effect +
  // loadSessionFromBackend via the ref (avoids a forward reference).
  rehydrateWorkflowRunsRef.current = rehydrateWorkflowRuns;

  /** Built-in fallback inputs for hardcoded sample.* workflows that
   *  ship without a SavedWorkflow defaultInputs blob. Keeps `@uppercase`
   *  from dispatching with an empty `inputs.text` and silently emitting
   *  an empty string. */
  const runWorkflowMention = useCallback(async (entry: WorkflowMentionEntry, trailing?: string) => {
    setError(null);
    // Preserve what the user actually typed so the chat history shows
    // `/hello-uppercase hello` (their intent) and not just the slug.
    //
    // Symbol: `/` post-2026-05-28 mention-symbol swap. `@` now opens
    // the agents picker and goes through the agent-activation path
    // (phase D3), not the workflow dispatch path. Old persisted chat
    // history keeps showing `@slug` for workflows dispatched before
    // the swap — acceptable historical artifact; the wire content is
    // opaque to the BE.
    const trimmedTrailing = trailing?.trim() ?? '';
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmedTrailing.length > 0 ? `/${entry.slug} ${trimmedTrailing}` : `/${entry.slug}`,
      createdAt: new Date().toISOString(),
    };
    const runMsgId = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    // Builder-saved workflows live in localStorage and need to be
    // registered with the backend's in-memory catalog before /v1/runs
    // resolves them. Hardcoded `sample.*` workflows are already in the
    // catalog — skip registration and node-name population.
    const isBuilderWorkflow = entry.workflowId.startsWith('wf_');
    const saved = isBuilderWorkflow ? getSavedWorkflow(entry.workflowId) : undefined;
    if (isBuilderWorkflow && !saved) {
      // The mention pointed to a workflow that's no longer in localStorage.
      const msg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'system',
        content: i18n.t('chat:workflowDeleted', { name: entry.displayName }),
        createdAt: new Date().toISOString(),
      };
      // Title-on-first-message + write-through, mirroring `send()` at
      // line 562-572 — without this, an @mention is the only chat
      // entry-point that leaves the session unpersisted, so the
      // history drawer keeps showing "New chat — 0 messages" forever
      // even after the workflow completes.
      const userText = typeof userMsg.content === 'string' ? userMsg.content : `@${entry.slug}`;
      const deletedTitle = session.messages.length === 0 ? userText.slice(0, 60) : session.title;
      setSession((s) => ({
        ...s,
        title: s.messages.length === 0 ? userText.slice(0, 60) : s.title,
        messages: [...s.messages, userMsg, msg],
      }));
      void persistMessage(session.id, deletedTitle, userMsg);
      void persistMessage(session.id, deletedTitle, msg);
      return;
    }

    // Build nodeId → friendly-name map for "running step N of M — <name>".
    //
    // ADR 0440 P1 (grade-pass): this used to RE-DERIVE the backend nodeId as
    // `${sanitizedKind}_${index}`, mirroring what serialize.ts then emitted.
    // P1 made serialize PRESERVE the incoming id instead, so the mirror broke
    // and no `node.completed` event id matched any key here — every run started
    // from chat silently lost its step names. Ask the serializer for its own
    // map rather than re-deriving one; serialize.ts warns that these must not
    // drift, and a second copy of the rule is exactly how they drift.
    const nodeNames: Record<string, string> = {};
    let totalNodes = 0;
    let inputs: Record<string, unknown> = SAMPLE_DEFAULT_INPUTS[entry.workflowId] ?? {};
    if (saved) {
      totalNodes = saved.nodes.length;
      const { serializeWithIdMap } = await import('../../../builder/schema/serialize.js');
      const { backendIdToBuilder } = serializeWithIdMap(saved);
      const nameByBuilderId = new Map(saved.nodes.map((n) => [n.id, n.name]));
      for (const [backendId, builderId] of Object.entries(backendIdToBuilder)) {
        const name = nameByBuilderId.get(builderId);
        if (name) nodeNames[backendId] = name;
      }
      const raw = saved.defaultInputs?.trim();
      if (raw) {
        try { inputs = JSON.parse(raw) as Record<string, unknown>; } catch { /* empty */ }
      }
    }
    // User typed `/<slug> some text` — override the first key of the
    // resolved inputs object with that text. Keeps the workflow's
    // remaining defaults (e.g., a `tone` knob, a `length` cap) so the
    // user gets to swap the obvious "what do I send" field without
    // having to re-author the whole inputs JSON.
    //
    // If the workflow has no defaultInputs we synthesize `{ text: ... }`
    // since the two ports a sample workflow commonly accepts are
    // `text` (uppercase, etl-extractor) and `prompt` (mock-ai).
    if (trimmedTrailing.length > 0) {
      const keys = Object.keys(inputs);
      if (keys.length > 0) {
        const firstKey = keys[0]!;
        inputs = { ...inputs, [firstKey]: trimmedTrailing };
      } else {
        inputs = { text: trimmedTrailing };
      }
    }

    // CHAT-MENTION-1 — read the workflow's DECLARED run-input contract.
    //
    // Everything above predates `variables[]`: inputs came from a `sample.*` default
    // or localStorage, and the trailing text overwrote the FIRST existing key — or,
    // with none, an invented `text` key the contract may never declare. For a
    // workflow declaring required variables that meant every one stayed unset AND
    // the user's text landed somewhere nothing reads. The run started and died
    // mid-way naming an internal node.
    //
    // Deliberately NOT a modal: a dialog mid-conversation fights the chat primitive,
    // and CLAUDE.md forbids a second chat input surface. So — map the trailing text
    // onto the single required variable when there is exactly one (the common
    // `/summarize <text>` case), and otherwise refuse in-thread naming what is
    // missing. An honest refusal beats a run that cannot succeed.
    let declared: RunVariable[] = [];
    try {
      declared = await getWorkflowRunInputs(entry.workflowId);
    } catch {
      // A built-in role template has no stored definition. Degrading to the legacy
      // behaviour is right — blocking it would trade one silent failure for a louder
      // regression (the CHAIN-PROMPT-1 precedent).
      declared = [];
    }
    if (declared.length > 0) {
      const required = declared.filter((v) => v.required);
      if (trimmedTrailing.length > 0 && required.length === 1) {
        // Use the variable's REAL declared name, not the invented `text`.
        inputs = { ...inputs, [required[0]!.name]: trimmedTrailing };
      }
      const unmet = required.filter((v) => {
        const val = inputs[v.name];
        return val === undefined || val === null || (typeof val === 'string' && val.trim() === '');
      });
      if (unmet.length > 0) {
        const msg: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'system',
          content: i18n.t('chat:workflowNeedsInputs', {
            name: entry.displayName,
            fields: unmet.map((v) => v.name).join(', '),
            count: unmet.length,
          }),
          createdAt: new Date().toISOString(),
        };
        const userText = typeof userMsg.content === 'string' ? userMsg.content : `/${entry.slug}`;
        const title = session.messages.length === 0 ? userText.slice(0, 60) : session.title;
        setSession((st) => ({
          ...st,
          title: st.messages.length === 0 ? userText.slice(0, 60) : st.title,
          messages: [...st.messages, userMsg, msg],
        }));
        void persistMessage(session.id, title, userMsg);
        void persistMessage(session.id, title, msg);
        return;
      }
    }

    // ADR 0712 Phase 2 — a workflow that declares a `credentialRef` parameter the
    // user left unset runs on the key this chat already uses: the durable ADR 0517
    // binding, and only when the server says it is valid and it is a BYOK key. It
    // rides `configurable.ai.credentialRef` alone — never the input — so the
    // dispatcher applies it only to nodes of the provider the key names (see
    // `splitRunCredential`). Any failure here degrades to the run as before.
    let runConfigurable: RunConfigurable | undefined;
    const credentialVariable = declared.find(isCredentialRefVariable);
    if (credentialVariable) {
      const supplied = inputs[credentialVariable.name];
      if (typeof supplied !== 'string' || supplied.trim() === '') {
        try {
          const active = await getActiveConfig();
          const ref = active.valid ? active.config?.credentialRef : undefined;
          if (ref && !ref.startsWith('managed:')) runConfigurable = { version: 1, ai: { credentialRef: ref } };
        } catch { /* no binding readable — start the run without one */ }
      }
    }

    const initial: WorkflowRunState = {
      slug: entry.slug,
      workflowName: entry.displayName,
      workflowId: entry.workflowId,
      runId: null,
      status: 'pending',
      totalNodes,
      completedNodeIds: [],
      failedNodeIds: [],
      nodeOutputs: {},
      currentNodeName: null,
      nodeNames,
      startedAt,
    };
    const runMsg: ChatMessage = {
      id: runMsgId,
      role: 'workflow_run',
      content: `/${entry.slug} — starting…`,
      createdAt: startedAt,
      workflowRun: initial,
    };
    // Title-on-first-message + write-through, mirroring `send()` at
    // line 562-572. Without this, the @mention chat path is the only
    // entry-point that never persists, so the history drawer always
    // shows "New chat — 0 messages" for chats that only contain
    // workflow runs.
    //
    // We compute `nextTitle` synchronously from the same closure-time
    // `session` that `setSession` will read, so the persist call sees
    // the same value the local state lands on. `userMsg.content` is
    // always a plain string for @mentions (no attachments are
    // composed into a mention dispatch), but the `ChatMessage.content`
    // union is `string | ContentPart[]` — narrow it explicitly so the
    // `title: string` field stays typed.
    const userText = typeof userMsg.content === 'string' ? userMsg.content : `@${entry.slug}`;
    const nextTitle = session.messages.length === 0 ? userText.slice(0, 60) : session.title;
    setSession((s) => ({
      ...s,
      title: s.messages.length === 0 ? userText.slice(0, 60) : s.title,
      messages: [...s.messages, userMsg, runMsg],
    }));
    void persistMessage(session.id, nextTitle, userMsg);
    // The workflow_run message persists at terminal (run.completed /
    // failed / cancelled) below — its `workflowRun` state grows
    // throughout the run, so we want the final shape on disk, not the
    // empty "starting…" snapshot.

    let runId: string;
    try {
      if (saved) {
        // Lazy-load the builder serializer here (only reached when a user runs a
        // saved /wf_… workflow): it statically pulls builder/palette/catalogRegistry,
        // which has no business in the first-paint chat entry chunk.
        const [{ serializeWorkflow }, { registerWorkflow, fetchRegisteredWorkflow }, { definitionMetadataFor }] = await Promise.all([
          import('../../../builder/schema/serialize.js'),
          import('../../../builder/persistence/registerClient.js'),
          import('../../../builder/persistence/definitionMetadata.js'),
        ]);
        // ADR 0524 — register ONLY when the backend cannot already resolve it.
        // `saved` is a localStorage record; one written by a pre-ADR-0523 bundle
        // has no node `inputs`, and registering it would overwrite the server
        // head with the stale copy. That does NOT self-heal on refresh (the
        // staleness is in browser storage, not the bundle), and a workflow the
        // user only ever runs from chat is never healed at all.
        // FAIL CLOSED. A probe error (429 / 5xx / offline) used to fall through to
        // the register — i.e. the DESTRUCTIVE branch — and CLAUDE.md documents the
        // per-IP read budget as a real 429 source on fan-out pages, so that is not
        // theoretical. Skipping the register instead costs a loud 404 from
        // `POST /v1/runs` for a workflow that exists only locally; overwriting costs
        // the authored values silently. This ADR's whole thesis is that a loud
        // failure beats a silent loss.
        let probe: unknown | null = null;
        let probeFailed = false;
        try { probe = await fetchRegisteredWorkflow(entry.workflowId); } catch { probeFailed = true; }
        if (!probe && !probeFailed) {
          const def = serializeWorkflow(saved);
          // ADR 0440 P1 — carry the definition metadata. The route replaces the
          // definition wholesale, so registering without it erases walkthrough
          // flags, handoff gates, retention and chain provenance.
          await registerWorkflow({ ...def, metadata: definitionMetadataFor(saved) });
        }
      }
      const created = await createRun(
        {
          workflowId: entry.workflowId,
          // Same as the chat-turn createRun above: omit body.tenantId
          // so the BE infers from the authenticated session.
          inputs,
          metadata: { chatSessionId: session.id, chatMessageId: runMsgId, mentionSlug: entry.slug },
          ...(runConfigurable ? { configurable: runConfigurable } : {}),
        },
        // Per spec/v1/idempotency.md Layer 1: `runMsgId` is generated
        // once per `runWorkflowMention()` invocation and persisted on
        // the workflow_run message. A page refresh or SDK retry that
        // re-submits with this key will collapse onto the original
        // run server-side instead of creating a duplicate.
        { idempotencyKey: runMsgId },
      );
      runId = created.runId;
    } catch (err) {
      // ADR 0482 (ux-1) — createRun rejected by the owner-set daily budget
      // surfaces the honest budget sentence, keyed on the machine-readable
      // envelope reason (WopError.envelope.details.reason). The reason rides
      // the persisted error so classifyChatError can branch on data, not text.
      const reason = errorReasonOf(err);
      const msg = reason === 'workflow_budget_exhausted'
        ? i18n.t('common:errorBudgetExhausted')
        : err instanceof Error ? err.message : String(err);
      let finalizedFailed: ChatMessage | null = null;
      setSession((s) => {
        const next = s.messages.map((m) => {
          if (m.id !== runMsgId || !m.workflowRun) return m;
          const updated: ChatMessage = {
            ...m,
            workflowRun: {
              ...m.workflowRun,
              status: 'failed',
              error: { code: 'dispatch_failed', message: msg, ...(reason ? { reason } : {}) },
            },
          };
          finalizedFailed = updated;
          return updated;
        });
        return { ...s, messages: next };
      });
      // Persist the dispatch-failed run-bubble so the drawer shows
      // *something* even when /v1/runs never produced a runId.
      if (finalizedFailed) void persistMessage(session.id, nextTitle, finalizedFailed);
      setError(msg);
      return;
    }

    updateWorkflowRun(runMsgId, (prev) => ({ ...prev, runId, status: 'running' }));
    // Persist the running snapshot NOW (not just at terminal): a run that suspends
    // at a HITL gate is never terminal, so without an early write the whole
    // workflow_run card + its node cards + the interrupt card vanished on reopen.
    // `persistOrUpdateMessage` upserts, so the suspend/terminal handlers re-save
    // the evolving state onto this same message.
    void persistOrUpdateMessage(session.id, nextTitle, { ...runMsg, workflowRun: { ...initial, runId, status: 'running' } });

    const ctx = {
      runId,
      runMsgId,
      setSession,
      // Upsert — the run-backed message is re-saved as its state evolves.
      persistMessage: persistOrUpdateMessage,
      sessionId: session.id,
      sessionTitle: nextTitle,
      updateWorkflowRun,
      closeWorkflowSub,
    };

    // Open the self-healing live subscription (extracted so reopen-rehydration
    // reuses the exact same timeout/reconnect/reconcile behavior).
    subscribeWorkflowRun(ctx);
  }, [session.id, session.title, session.messages.length, updateWorkflowRun, persistMessage, persistOrUpdateMessage, subscribeWorkflowRun, closeWorkflowSub, setError, setSession]);

  const cancelWorkflowRun = useCallback(async (messageId: string) => {
    const msg = session.messages.find((m) => m.id === messageId);
    const runId = msg?.workflowRun?.runId;
    if (!runId || msg?.workflowRun?.status !== 'running') return;
    try {
      await cancelRun(runId, 'User cancelled from chat.');
      // The backend's run.cancelled event will flip the status + close
      // the SSE subscription via the existing terminal-event handler.
      // Optimistic UI: nothing to do here — the bubble updates on the
      // event arriving.
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      updateWorkflowRun(messageId, (prev) => ({
        ...prev,
        status: 'failed',
        error: { code: 'cancel_failed', message: m },
      }));
      closeWorkflowSub(messageId);
    }
  }, [session.messages, updateWorkflowRun, closeWorkflowSub]);

  return { updateWorkflowRun, subscribeWorkflowRun, rehydrateWorkflowRuns, runWorkflowMention, cancelWorkflowRun };
}
