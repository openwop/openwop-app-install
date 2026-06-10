/**
 * Chat-turn SSE handler. Extracted VERBATIM from `useChatSession.ts`'s
 * inline `subscribeToRun(...)` subscription so the ~380-line event switch
 * lives in one testable module instead of inside the `send` callback.
 *
 * `makeChatTurnHandlers(ctx)` returns the `SubscribeOptions` handlers
 * (`onEvent` / `onError` / `onTimeout`) minus `modes`; `send` spreads them
 * into `subscribeToRun(runId, { modes: ['updates'], ...makeChatTurnHandlers(ctx) })`.
 * The `accumulated` token buffer is factory-local state (one per turn).
 */

import type React from 'react';
import type { RunEventDoc } from '@openwop/openwop';
import { listOpenInterrupts } from '../../client/interruptsClient.js';
import type { Subscription, SubscribeOptions } from '../../client/streamsClient.js';
import type { ApplyAnimationHandle } from './useApplyAnimation.js';
import type {
  ChatMessage,
  ChatMessageThoughts,
  ChatSession,
  Citation,
} from '../types.js';

/** Functional state-update helper for a single message in the session.
 *  Encapsulates the spread-map-spread dance so callers can express the
 *  diff in one line ("transform message m"). */
function updateMessage(
  setSession: React.Dispatch<React.SetStateAction<ChatSession>>,
  messageId: string,
  transform: (m: ChatMessage) => ChatMessage,
): void {
  setSession((s) => ({
    ...s,
    messages: s.messages.map((m) => (m.id === messageId ? transform(m) : m)),
  }));
}

/** Specialization of {@link updateMessage} for the `agentEvents` field.
 *  Takes a callback that receives the prior agent-event log (with empty
 *  defaults) and returns the next one. */
function updateAgentEvents(
  setSession: React.Dispatch<React.SetStateAction<ChatSession>>,
  messageId: string,
  appender: (prev: NonNullable<ChatMessage['agentEvents']>) => NonNullable<ChatMessage['agentEvents']>,
): void {
  updateMessage(setSession, messageId, (m) => ({
    ...m,
    agentEvents: appender(m.agentEvents ?? { toolCalls: [], handoffs: [], decisions: [] }),
  }));
}

const EMPTY_ENVELOPE_EVENTS: NonNullable<ChatMessage['envelopeEvents']> = {
  retries: [],
  retriesExhausted: [],
  refusals: [],
  truncations: [],
  nlCoercions: [],
  recoveries: [],
  capabilitySubstitutions: [],
  capabilitiesInsufficient: [],
};

/** Specialization of {@link updateMessage} for the `envelopeEvents` field.
 *  Surfaces RFC 0030 / 0031 / 0032 / 0033 events grouped per assistant
 *  turn for the EnvelopeEventsTimeline chat card. */
function updateEnvelopeEvents(
  setSession: React.Dispatch<React.SetStateAction<ChatSession>>,
  messageId: string,
  appender: (prev: NonNullable<ChatMessage['envelopeEvents']>) => NonNullable<ChatMessage['envelopeEvents']>,
): void {
  updateMessage(setSession, messageId, (m) => ({
    ...m,
    envelopeEvents: appender(m.envelopeEvents ?? EMPTY_ENVELOPE_EVENTS),
  }));
}

/** Dependencies the chat-turn SSE handler closes over. Threaded through
 *  instead of capturing the whole `session` so the handler can live
 *  outside the hook. Values (`runId`, `assistantId`, `sessionId`,
 *  `sessionTitle`) are snapshotted per turn; refs + setters are stable. */
export interface ChatTurnHandlerContext {
  runId: string;
  assistantId: string;
  animation: ApplyAnimationHandle;
  setSession: React.Dispatch<React.SetStateAction<ChatSession>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setIsSending: React.Dispatch<React.SetStateAction<boolean>>;
  persistMessage: (sessionId: string, title: string, msg: ChatMessage) => Promise<void>;
  sessionId: string;
  sessionTitle: string;
  subRef: React.MutableRefObject<Subscription | null>;
  inFlightRunIdRef: React.MutableRefObject<string | null>;
  inFlightAssistantIdRef: React.MutableRefObject<string | null>;
}

/** Build the chat-turn SSE handlers. Returns the `SubscribeOptions`
 *  handlers (minus `modes`) so the caller can do
 *  `subscribeToRun(runId, { modes: ['updates'], ...makeChatTurnHandlers(ctx) })`. */
export function makeChatTurnHandlers(
  ctx: ChatTurnHandlerContext,
): Pick<SubscribeOptions, 'onEvent' | 'onError' | 'onTimeout'> {
  const {
    runId,
    assistantId,
    animation,
    setSession,
    setError,
    setIsSending,
    persistMessage,
    sessionId,
    sessionTitle,
    subRef,
    inFlightRunIdRef,
    inFlightAssistantIdRef,
  } = ctx;
  let accumulated = '';
  return {
    onEvent: async (ev: RunEventDoc) => {
      const payload = (ev.payload as Record<string, unknown>) ?? {};
      if (ev.type === 'node.message' && typeof payload.delta === 'string') {
        accumulated += payload.delta;
        animation.push(payload.delta);
      } else if (ev.type === 'agent.reasoning.delta' && typeof payload.delta === 'string') {
        // Phase 2 streaming reasoning. Incremental chunks arrive
        // before the final agent.reasoned; the disclosure renders
        // them live with a typewriter cursor.
        const delta = payload.delta;
        const verbosity = payload.verbosity as ChatMessageThoughts['verbosity'];
        const agentId = typeof payload.agentId === 'string' ? payload.agentId : undefined;
        const now = new Date().toISOString();
        updateMessage(setSession, assistantId, (m) => {
          const prev = m.thoughts;
          return {
            ...m,
            thoughts: {
              content: (prev?.content ?? '') + delta,
              startedAt: prev?.startedAt ?? now,
              ...(prev?.finishedAt ? { finishedAt: prev.finishedAt } : {}),
              ...(prev?.durationMs != null ? { durationMs: prev.durationMs } : {}),
              ...(verbosity ? { verbosity } : prev?.verbosity ? { verbosity: prev.verbosity } : {}),
              ...(agentId ? { agentId } : prev?.agentId ? { agentId: prev.agentId } : {}),
            },
          };
        });
      } else if (ev.type === 'agent.toolCalled' && typeof payload.callId === 'string' && typeof payload.toolName === 'string') {
        const callId = payload.callId;
        const toolName = payload.toolName;
        const agentIdRaw = typeof payload.agentId === 'string' ? payload.agentId : '';
        const inputs = payload.inputs;
        const now = new Date().toISOString();
        updateAgentEvents(setSession, assistantId, (prev) => ({
          ...prev,
          toolCalls: [...prev.toolCalls, { callId, toolName, agentId: agentIdRaw, inputs, startedAt: now }],
        }));
      } else if (ev.type === 'agent.toolReturned' && typeof payload.callId === 'string') {
        const callId = payload.callId;
        const errorPayload = payload.error;
        const error = errorPayload && typeof errorPayload === 'object' && 'code' in errorPayload && 'message' in errorPayload
          ? { code: String((errorPayload as Record<string, unknown>).code), message: String((errorPayload as Record<string, unknown>).message) }
          : undefined;
        const outcome = payload.outcome;
        const now = new Date().toISOString();
        updateAgentEvents(setSession, assistantId, (prev) => ({
          ...prev,
          toolCalls: prev.toolCalls.map((tc) =>
            tc.callId === callId
              ? { ...tc, finishedAt: now, outcome, ...(error ? { error } : {}) }
              : tc,
          ),
        }));
      } else if (ev.type === 'agent.handoff' && typeof payload.fromAgentId === 'string' && typeof payload.toAgentId === 'string') {
        const fromAgentId = payload.fromAgentId;
        const toAgentId = payload.toAgentId;
        const reason = typeof payload.reason === 'string' ? payload.reason : undefined;
        const now = new Date().toISOString();
        updateAgentEvents(setSession, assistantId, (prev) => ({
          ...prev,
          handoffs: [...prev.handoffs, { fromAgentId, toAgentId, at: now, ...(reason ? { reason } : {}) }],
        }));
      } else if (ev.type === 'agent.decided' && typeof payload.agentId === 'string') {
        const agentIdRaw = payload.agentId;
        const confidence = typeof payload.confidence === 'number' ? payload.confidence : undefined;
        const decision = payload.decision;
        const now = new Date().toISOString();
        updateAgentEvents(setSession, assistantId, (prev) => ({
          ...prev,
          decisions: [
            ...prev.decisions,
            { agentId: agentIdRaw, decision, at: now, ...(confidence != null ? { confidence } : {}) },
          ],
        }));
      } else if (
        ev.type === 'agent.verified' &&
        typeof payload.agentId === 'string' &&
        typeof payload.target === 'string' &&
        (payload.verdict === 'pass' || payload.verdict === 'fail' || payload.verdict === 'revise')
      ) {
        // RFC 0090 — an independent critic's verdict over the actor's
        // result. Content-free: only verdict + target + optional criteria
        // keys / confidence are surfaced (verifier-no-content-leak).
        const agentIdRaw = payload.agentId;
        const target = payload.target;
        const verdict = payload.verdict;
        const criteria = Array.isArray(payload.criteria)
          ? (payload.criteria.filter((c) => typeof c === 'string') as string[])
          : undefined;
        const confidence = typeof payload.confidence === 'number' ? payload.confidence : undefined;
        const now = new Date().toISOString();
        updateAgentEvents(setSession, assistantId, (prev) => ({
          ...prev,
          verified: [
            ...(prev.verified ?? []),
            { agentId: agentIdRaw, target, verdict, at: now, ...(criteria && criteria.length ? { criteria } : {}), ...(confidence != null ? { confidence } : {}) },
          ],
        }));
      } else if (ev.type === 'agent.reasoned' && typeof payload.reasoning === 'string') {
        // Phase 1 path: full block delivered in one event after
        // </think>. Also acts as the "finalize" for any Phase 2
        // streaming deltas that preceded it.
        const reasoning = payload.reasoning;
        const verbosity = payload.verbosity as ChatMessageThoughts['verbosity'];
        const agentId = typeof payload.agentId === 'string' ? payload.agentId : undefined;
        const now = new Date().toISOString();
        updateMessage(setSession, assistantId, (m) => {
          const startedAt = m.thoughts?.startedAt ?? now;
          const durationMs = Date.parse(now) - Date.parse(startedAt);
          return {
            ...m,
            thoughts: {
              content: reasoning,
              startedAt,
              finishedAt: now,
              durationMs: Number.isFinite(durationMs) ? durationMs : 0,
              ...(verbosity ? { verbosity } : {}),
              ...(agentId ? { agentId } : {}),
            },
          };
        });
      } else if (ev.type === 'envelope.retry.attempted' && typeof payload.nodeId === 'string') {
        const nodeId = payload.nodeId;
        const attempt = typeof payload.attempt === 'number' ? payload.attempt : 0;
        const reason = typeof payload.reason === 'string' ? payload.reason : 'unknown';
        const previousError = typeof payload.previousError === 'string' ? payload.previousError : undefined;
        const now = new Date().toISOString();
        updateEnvelopeEvents(setSession, assistantId, (prev) => ({
          ...prev,
          retries: [...prev.retries, { nodeId, attempt, reason, at: now, ...(previousError ? { previousError } : {}) }],
        }));
      } else if (ev.type === 'envelope.retry.exhausted' && typeof payload.nodeId === 'string') {
        const nodeId = payload.nodeId;
        const totalAttempts = typeof payload.totalAttempts === 'number' ? payload.totalAttempts : 0;
        const finalReason = typeof payload.finalReason === 'string' ? payload.finalReason : 'unknown';
        const finalError = typeof payload.finalError === 'string' ? payload.finalError : undefined;
        const now = new Date().toISOString();
        updateEnvelopeEvents(setSession, assistantId, (prev) => ({
          ...prev,
          retriesExhausted: [...prev.retriesExhausted, { nodeId, totalAttempts, finalReason, at: now, ...(finalError ? { finalError } : {}) }],
        }));
      } else if (ev.type === 'envelope.refusal' && typeof payload.nodeId === 'string') {
        const nodeId = payload.nodeId;
        const provider = String(payload.provider ?? '');
        const model = String(payload.model ?? '');
        const refusalText = typeof payload.refusalText === 'string' ? payload.refusalText : undefined;
        const safetyCategory = typeof payload.safetyCategory === 'string' ? payload.safetyCategory : undefined;
        const now = new Date().toISOString();
        updateEnvelopeEvents(setSession, assistantId, (prev) => ({
          ...prev,
          refusals: [...prev.refusals, {
            nodeId, provider, model, at: now,
            ...(refusalText ? { refusalText } : {}),
            ...(safetyCategory ? { safetyCategory } : {}),
          }],
        }));
      } else if (ev.type === 'envelope.truncated' && typeof payload.nodeId === 'string') {
        const nodeId = payload.nodeId;
        const provider = String(payload.provider ?? '');
        const model = String(payload.model ?? '');
        const stopReason = typeof payload.stopReason === 'string' ? payload.stopReason : 'unknown';
        const partialPayloadAvailable = typeof payload.partialPayloadAvailable === 'boolean' ? payload.partialPayloadAvailable : undefined;
        const outputTokenCount = typeof payload.outputTokenCount === 'number' ? payload.outputTokenCount : undefined;
        const now = new Date().toISOString();
        updateEnvelopeEvents(setSession, assistantId, (prev) => ({
          ...prev,
          truncations: [...prev.truncations, {
            nodeId, provider, model, stopReason, at: now,
            ...(partialPayloadAvailable !== undefined ? { partialPayloadAvailable } : {}),
            ...(outputTokenCount !== undefined ? { outputTokenCount } : {}),
          }],
        }));
      } else if (ev.type === 'envelope.nlToFormat.engaged' && typeof payload.nodeId === 'string') {
        const nodeId = payload.nodeId;
        const originalEnvelopeType = typeof payload.originalEnvelopeType === 'string' ? payload.originalEnvelopeType : '';
        const fallbackCalls = typeof payload.fallbackCalls === 'number' ? payload.fallbackCalls : undefined;
        const now = new Date().toISOString();
        updateEnvelopeEvents(setSession, assistantId, (prev) => ({
          ...prev,
          nlCoercions: [...prev.nlCoercions, { nodeId, originalEnvelopeType, at: now, ...(fallbackCalls !== undefined ? { fallbackCalls } : {}) }],
        }));
      } else if (ev.type === 'envelope.recovery.applied' && typeof payload.nodeId === 'string') {
        const nodeId = payload.nodeId;
        const path = typeof payload.path === 'string' ? payload.path : '';
        const byteOffset = typeof payload.byteOffset === 'number' ? payload.byteOffset : undefined;
        const now = new Date().toISOString();
        updateEnvelopeEvents(setSession, assistantId, (prev) => ({
          ...prev,
          recoveries: [...prev.recoveries, { nodeId, path, at: now, ...(byteOffset !== undefined ? { byteOffset } : {}) }],
        }));
      } else if (ev.type === 'model.capability.substituted' && typeof payload.nodeId === 'string') {
        const nodeId = payload.nodeId;
        const originalProvider = String(payload.originalProvider ?? '');
        const originalModel = String(payload.originalModel ?? '');
        const fallbackProvider = String(payload.fallbackProvider ?? '');
        const fallbackModel = String(payload.fallbackModel ?? '');
        const missingCapabilities = Array.isArray(payload.missingCapabilities)
          ? (payload.missingCapabilities as unknown[]).filter((c): c is string => typeof c === 'string')
          : [];
        const now = new Date().toISOString();
        updateEnvelopeEvents(setSession, assistantId, (prev) => ({
          ...prev,
          capabilitySubstitutions: [...prev.capabilitySubstitutions, {
            nodeId, originalProvider, originalModel, fallbackProvider, fallbackModel, missingCapabilities, at: now,
          }],
        }));
      } else if (ev.type === 'model.capability.insufficient' && typeof payload.nodeId === 'string') {
        const nodeId = payload.nodeId;
        const provider = String(payload.provider ?? '');
        const model = String(payload.model ?? '');
        const missingCapabilities = Array.isArray(payload.missingCapabilities)
          ? (payload.missingCapabilities as unknown[]).filter((c): c is string => typeof c === 'string')
          : [];
        const fallbackAttempted = typeof payload.fallbackAttempted === 'boolean' ? payload.fallbackAttempted : undefined;
        const now = new Date().toISOString();
        updateEnvelopeEvents(setSession, assistantId, (prev) => ({
          ...prev,
          capabilitiesInsufficient: [...prev.capabilitiesInsufficient, {
            nodeId, provider, model, missingCapabilities, at: now,
            ...(fallbackAttempted !== undefined ? { fallbackAttempted } : {}),
          }],
        }));
      } else if (ev.type === 'node.completed') {
        // Flush any buffered animation tail so the bubble has the
        // full streamed content before we overwrite with the final
        // outputs.completion (which is authoritative).
        animation.flush();
        const outputs = (payload.outputs as Record<string, unknown>) ?? {};
        const completion = typeof outputs.completion === 'string' ? outputs.completion : accumulated;
        const usage = outputs.usage as Record<string, number> | undefined;
        const citations = Array.isArray(outputs.citations) ? outputs.citations as Citation[] : undefined;
        // RFC 0030 §A — the `reasoning` string is OPTIONAL on three
        // universal envelope kinds (clarification.request, schema.request,
        // error). A standard chat completion is none of those, so this
        // capture only fires when the assistant turn happens to surface
        // a universal-kind envelope (e.g., a node that requested
        // clarification or returned a typed error). For the typical
        // happy-path completion the capture returns undefined and
        // ReasoningDisclosure renders nothing. Probes both the outputs
        // root and the nested envelope.payload shape so hosts can lift
        // reasoning either way without breaking the FE.
        const envelopeReasoning = (() => {
          if (typeof outputs.reasoning === 'string' && outputs.reasoning.length > 0) return outputs.reasoning;
          const envelope = outputs.envelope as Record<string, unknown> | undefined;
          if (!envelope) return undefined;
          const payloadField = envelope.payload as Record<string, unknown> | undefined;
          if (payloadField && typeof payloadField.reasoning === 'string' && payloadField.reasoning.length > 0) {
            return payloadField.reasoning;
          }
          return undefined;
        })();
        // RFC 0055 §B: lift the optional `meta.rendering` hint if the
        // turn surfaced an AI envelope carrying one (envelope.meta.rendering),
        // or the host lifted it to the outputs root. Validated against the
        // closed `display` vocabulary; anything else is dropped (the
        // renderer falls back to default text rendering anyway).
        const envelopeRendering = ((): NonNullable<ChatMessage['meta']>['rendering'] => {
          const DISPLAYS = ['markdown', 'code', 'card', 'image', 'audio', 'file'] as const;
          const envelope = outputs.envelope as Record<string, unknown> | undefined;
          const envMeta = envelope?.meta as Record<string, unknown> | undefined;
          const raw = (envMeta?.rendering ?? outputs.rendering) as Record<string, unknown> | undefined;
          if (!raw || typeof raw !== 'object') return undefined;
          const display = raw.display;
          if (typeof display !== 'string' || !(DISPLAYS as readonly string[]).includes(display)) return undefined;
          const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
          return {
            display: display as (typeof DISPLAYS)[number],
            ...(str(raw.mimeType) ? { mimeType: str(raw.mimeType)! } : {}),
            ...(str(raw.lang) ? { lang: str(raw.lang)! } : {}),
            ...(str(raw.alt) ? { alt: str(raw.alt)! } : {}),
            ...(str(raw.title) ? { title: str(raw.title)! } : {}),
          };
        })();
        let finalized: ChatMessage | null = null;
        setSession((s) => {
          const next = s.messages.map((m) => {
            if (m.id !== assistantId) return m;
            const updated: ChatMessage = {
              ...m,
              isStreaming: false,
              content: completion,
              ...(envelopeReasoning ? { reasoning: envelopeReasoning } : {}),
              meta: {
                runId,
                provider: outputs.provider as string | undefined,
                model: outputs.model as string | undefined,
                inputTokens: usage?.inputTokens,
                outputTokens: usage?.outputTokens,
                ...(citations && citations.length > 0 ? { citations } : {}),
                ...(envelopeRendering ? { rendering: envelopeRendering } : {}),
              },
            };
            finalized = updated;
            return updated;
          });
          return { ...s, messages: next };
        });
        if (finalized) void persistMessage(sessionId, sessionTitle, finalized);
      } else if (ev.type === 'node.suspended') {
        // An interrupt fired mid-turn — fetch the open interrupts and
        // attach the latest to the assistant bubble so the card host
        // can render an inline approval / clarification / etc. card.
        try {
          const open = await listOpenInterrupts(runId);
          const active = open[open.length - 1] ?? null;
          setSession((s) => ({
            ...s,
            messages: s.messages.map((m) => m.id === assistantId ? { ...m, activeInterrupt: active } : m),
          }));
        } catch (e) {
          // No longer silent (GAP-ANALYSIS E6): a dropped interrupt fetch
          // previously left the approval card absent with no trace.
          console.warn('[chat] could not load open interrupt for run', runId, e);
        }
      } else if (ev.type === 'node.interrupt.resolved') {
        setSession((s) => ({
          ...s,
          messages: s.messages.map((m) => m.id === assistantId ? { ...m, activeInterrupt: null } : m),
        }));
      } else if (ev.type === 'run.failed') {
        animation.flush();
        const err = (payload.error as Record<string, string>) ?? { code: 'unknown', message: 'unknown failure' };
        let finalized: ChatMessage | null = null;
        setSession((s) => {
          const next = s.messages.map((m) => {
            if (m.id !== assistantId) return m;
            const updated: ChatMessage = {
              ...m,
              isStreaming: false,
              content: accumulated,
              meta: { runId, error: { code: err.code ?? 'unknown', message: err.message ?? 'unknown' } },
            };
            finalized = updated;
            return updated;
          });
          return { ...s, messages: next };
        });
        if (finalized) void persistMessage(sessionId, sessionTitle, finalized);
        setIsSending(false);
        inFlightRunIdRef.current = null;
        inFlightAssistantIdRef.current = null;
        // Close the SSE subscription explicitly so the idle timer
        // doesn't fire 30s later and overwrite the bubble with a
        // spurious stream_timeout error. The BE already closed its
        // side via res.end(); browser EventSource auto-reconnect
        // would otherwise keep our timer alive.
        subRef.current?.close();
        subRef.current = null;
      } else if (ev.type === 'run.cancelled') {
        // User-initiated stop. Mark the in-flight bubble as cancelled
        // with whatever content we accumulated so far.
        animation.flush();
        let finalized: ChatMessage | null = null;
        setSession((s) => {
          const next = s.messages.map((m) => {
            if (m.id !== assistantId) return m;
            const updated: ChatMessage = {
              ...m,
              isStreaming: false,
              content: accumulated || '',
              meta: { runId, error: { code: 'cancelled', message: 'Stopped by user.' } },
            };
            finalized = updated;
            return updated;
          });
          return { ...s, messages: next };
        });
        if (finalized) void persistMessage(sessionId, sessionTitle, finalized);
        setIsSending(false);
        inFlightRunIdRef.current = null;
        inFlightAssistantIdRef.current = null;
        subRef.current?.close();
        subRef.current = null;
      } else if (ev.type === 'run.completed') {
        setIsSending(false);
        inFlightRunIdRef.current = null;
        inFlightAssistantIdRef.current = null;
        subRef.current?.close();
        subRef.current = null;
      }
    },
    onError: () => {
      setError('SSE stream lost; the bubble may be incomplete.');
    },
    onTimeout: (kind) => {
      animation.flush();
      let finalized: ChatMessage | null = null;
      setSession((s) => {
        const next = s.messages.map((m) => {
          if (m.id !== assistantId) return m;
          const updated: ChatMessage = {
            ...m,
            isStreaming: false,
            content: accumulated,
            meta: {
              runId,
              error: {
                code: 'stream_timeout',
                message: kind === 'idle'
                  ? 'No tokens received for 30s — the stream appears stuck. The bubble shows whatever arrived before the timeout.'
                  : 'Stream exceeded the absolute deadline (120s). The bubble shows whatever arrived before the timeout.',
              },
            },
          };
          finalized = updated;
          return updated;
        });
        return { ...s, messages: next };
      });
      if (finalized) void persistMessage(sessionId, sessionTitle, finalized);
      setIsSending(false);
      inFlightRunIdRef.current = null;
      inFlightAssistantIdRef.current = null;
    },
  };
}
