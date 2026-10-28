/**
 * Durable persistence for one conversation exchange (ADR 0327 P1).
 *
 * Owns the `conversation.exchanged` append pair, the `messages`-channel
 * mirror, and the post-persist hooks (ADR 0151 autotitle, ADR 0120 Phase 2d
 * memory extraction). Idempotency claim/commit/release ORDERING stays in the
 * orchestrator (claim before dispatch, release on failure, commit after both
 * appends) — this module only persists; it never decides the sequence.
 */

import { getEventLog } from '../../executor/eventLog.js';
import { createLogger } from '../../observability/logger.js';
import { appendChannelMessage } from '../channelsRuntime.js';
import type { ConversationTurn } from '../conversation.js';
import type { RunRecord } from '../../types.js';
import type { Storage } from '../../storage/storage.js';
import { stripSecretsFromPersisted } from '../../byok/ephemeralRunSecrets.js';
import { extractConversationMemory } from '../../features/memory-auto-extract/extractionBinding.js';
import { llmExtractFacts } from '../../features/memory-auto-extract/memoryExtractor.js';
import type { ExtractionOutcome } from '../../features/memory-auto-extract/extractionOp.js';
import { maybeAutotitleOnFirstExchange } from '../../features/chat-autotitle/binding.js';
import { asText } from './contentParts.js';

// Same component name as the orchestrator — log identity is an ops surface.
const logger = createLogger('host.conversationExchange');

/** Append the user+agent turn pair as `conversation.exchanged` events (SR-1:
 *  secrets stripped at the persistence boundary, parity with ctx.emit). */
export async function persistExchangedPair(input: {
  runId: string;
  nodeId: string;
  conversationId: string;
  entries: ReadonlyArray<readonly [number, ConversationTurn]>;
}): Promise<void> {
  const log = getEventLog();
  // ADR 0491 — the log is a pure APPEND (no overwrite, no dedup by index), and
  // `loadTurns` folds with a bare push, so two turns written at one index both
  // survive and sort against each other. That is exactly how the tool-dispatched
  // run bubble collided with the user's own message. Turn the single-allocator
  // invariant into an enforced precondition for anything this function writes.
  //
  // HONEST LIMIT: this catches a duplicate WITHIN one batch — which is the shape
  // a multi-entry caller (user + agent + N run turns) can regress into. It cannot
  // see a collision against turns already in the log; that one is prevented by
  // there being a single allocator, which is what the seam exists to guarantee.
  const indices = input.entries.map(([idx]) => idx);
  if (new Set(indices).size !== indices.length) {
    throw new Error(`persistExchangedPair: duplicate turnIndex in one batch (${indices.join(',')}) — conversation ${input.conversationId}`);
  }
  for (const [idx, turn] of input.entries) {
    await log.append({
      runId: input.runId, nodeId: input.nodeId, type: 'conversation.exchanged',
      payload: stripSecretsFromPersisted({ conversationId: input.conversationId, turnIndex: idx, turn }),
    });
  }
}

/** Mirror one turn onto the run's `messages` channel (the string projection —
 *  the authoritative structured turn is the `conversation.exchanged` event). */
export function mirrorTurnToChannel(runId: string, msg: {
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  agentId?: string | undefined;
}): void {
  appendChannelMessage(runId, 'messages', {
    messageId: msg.messageId, role: msg.role, content: msg.content,
    timestamp: msg.timestamp, ...(msg.agentId ? { agentId: msg.agentId } : {}),
  });
}

/** ADR 0151 — first-exchange auto-titling. Fire-and-forget + FAIL-CLOSED inside
 *  the binding (no chat session / toggle off / already titled / manual rename ⇒
 *  no-op), so it never blocks the turn and runs at most once per conversation.
 *  Emits `openwop-app.conversation.titled` on the run log so the FE rail/tab updates live. */
export function autotitleAfterExchange(input: {
  run: RunRecord;
  chatSessionId: string | undefined;
  conversationId: string;
  nodeId: string;
  userText: string;
  replyText: string;
  storage: Storage;
}): void {
  const { run, chatSessionId, conversationId, nodeId, userText, replyText, storage } = input;
  const actingUserId = run.metadata?.['actingUserId'];
  const log = getEventLog();
  maybeAutotitleOnFirstExchange({
    tenantId: run.tenantId,
    userId: typeof actingUserId === 'string' && actingUserId.length > 0 ? actingUserId : undefined,
    chatSessionId,
    userText,
    replyText,
    storage,
    onTitled: (title) => {
      void log.append({
        runId: run.runId, nodeId, type: 'openwop-app.conversation.titled',
        payload: stripSecretsFromPersisted({ conversationId, ...(chatSessionId ? { chatSessionId } : {}), title }),
      }).catch(() => { /* best-effort title event */ });
    },
  });
}

/** How long conversation close will wait for extraction before abandoning it. Only an
 *  opted-in user ever reaches the LLM call, so only they can pay this.
 *
 *  Operator-tunable like the other latency knobs in this codebase (cf.
 *  `OPENWOP_SPA_SHELL_TTL_S`): a slow provider is a deployment property, not a
 *  constant, and an operator should be able to trade close latency against extraction
 *  completeness without a redeploy. Read per call so a test — or a running service —
 *  can change it without reloading the module. */
export function memoryExtractionBudgetMs(): number {
  const raw = Number(process.env['OPENWOP_MEMORY_EXTRACTION_BUDGET_MS']);
  return Number.isFinite(raw) && raw > 0 ? raw : 8000;
}

/** ADR 0120 Phase 2d — at conversation close, run consent-gated memory extraction over
 *  the full transcript (once). FAIL-CLOSED in the op: no grant ⇒ no LLM call, no write.
 *
 *  AWAITED IN-REQUEST, BOUNDED (ADR 0699 D1). This used to be fire-and-forget
 *  (`void … .catch(debug)`), called one line before `handleConversationResolve`
 *  returns — so the continuation, an LLM call taking SECONDS, ran after the response
 *  was flushed. `ARCHITECTURE.md:147` measures that shape: under Cloud Run's
 *  `cpu-throttling=true` a detached continuation "may not resume for a long time —
 *  MEASURED at 16+ minutes in #3056 … i.e. effectively never for any purpose that
 *  matters", and names awaiting in-request as "the only place CPU is guaranteed".
 *
 *  A TIMER-BASED OBSERVER WOULD NOT HAVE WORKED, which is why this awaits rather than
 *  just logging: under throttling the `setTimeout` callback is throttled too, so an
 *  observer built on one cannot fire under the exact condition it exists to observe.
 *  That is the #3056 signature — "ten requests served, ZERO fetch failures logged" —
 *  reproduced in the instrument instead of the subject. Here the bound is reachable
 *  precisely BECAUSE we are still in-request.
 *
 *  COST (ADR 0982 A8): a close outside a personal `user:` tenant pays nothing (the tenant check is
 *  pure and runs first). An un-opted-in close in a personal tenant pays three point-gets (the
 *  conversation record, the canonical person and the grant) before `skipped:'no-consent'`, so the
 *  LLM wait is paid only by people who asked for the feature. */
export async function maybeExtractMemoryOnClose(run: RunRecord, turns: readonly ConversationTurn[]): Promise<void> {
  // ADR 0982 D3 — only the person's OWN turns are extraction input. Agent turns echo tool results,
  // MCP content, fetched pages and mock output; before this they were sent too, unfenced.
  const userTurns = turns.filter((t) => t.role === 'user').map((t) => asText(t.content));
  const actingSubject = typeof run.metadata?.['actingUserId'] === 'string' ? run.metadata['actingUserId'] as string : undefined;

  // ADR 0982 D4 (architect A2) — ONE deadline governs the whole lane. The old shape raced a timer
  // and cancelled nothing, so (with CPU always allocated since ADR 0741) an "abandoned" extraction
  // still finished and wrote after the warning. The signal aborts the provider call, stops a
  // repair from starting and is checked before every write.
  const budgetMs = memoryExtractionBudgetMs();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), budgetMs);
  // Never hold the process open for this: the bound protects close latency, it is not work.
  timer.unref?.();
  try {
    const work = extractConversationMemory(
      run, userTurns,
      (sent) => llmExtractFacts(run.tenantId, sent, { ...(actingSubject ? { actingSubject } : {}), signal: deadline.signal }),
      deadline.signal,
    ).catch((e): ExtractionOutcome => {
      // WARN, not debug: a consent-gated write that failed is the person's memory silently not
      // being written.
      logger.warn('memory_extraction_failed', { error: e instanceof Error ? e.message : String(e) });
      // A throw here is a lane read (grant, conversation, person) or an unexpected error, not a
      // write: per-fact write failures are counted inside the op (code-review #1).
      return { status: 'failed', reason: 'lane-error' };
    });
    // The race still bounds close latency if some step ignores the signal (a hung store read);
    // the signal is what guarantees no write STARTS after the deadline. A write already under way
    // (the note and its recall index) finishes (MAE2CD-7).
    const expired = new Promise<ExtractionOutcome>((resolve) => {
      deadline.signal.addEventListener('abort', () => resolve({ status: 'abandoned' }), { once: true });
    });
    const outcome = await Promise.race([work, expired]);
    if (outcome.status === 'abandoned') {
      logger.warn('memory_extraction_abandoned', { budgetMs });
    } else if (outcome.status === 'failed') {
      logger.warn('memory_extraction_outcome', { ...outcome });
    } else if (outcome.status !== 'skipped' || outcome.reason !== 'not-personal') {
      // One line per close that reached the lane: status, counts and reason, never content.
      logger.info('memory_extraction_outcome', { ...outcome });
    }
  } finally {
    clearTimeout(timer);
  }
}
