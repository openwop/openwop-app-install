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
 *  COST: an un-opted-in close pays one point-get — `extractionOp.ts:37` returns
 *  `skipped:'no-consent'` before any LLM call — so the wait is paid by exactly the
 *  users who asked for the feature. This lane has already been silently inert in
 *  production once (ADR 0666 D1: a doubled `user:` prefix, "an inert feature and a
 *  consent control that did nothing"); it should not also write where CPU is not
 *  guaranteed and say nothing when it does not finish. */
export async function maybeExtractMemoryOnClose(run: RunRecord, turns: readonly ConversationTurn[]): Promise<void> {
  const userId = run.metadata?.['actingUserId'];
  if (typeof userId !== 'string' || userId.length === 0) return;
  const transcript = turns
    .filter((t) => t.role === 'user' || t.role === 'agent')
    .map((t) => `${t.from}: ${asText(t.content)}`)
    .join('\n')
    .slice(0, 8000);
  if (!transcript.trim()) return;

  const budgetMs = memoryExtractionBudgetMs();
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), budgetMs);
    // Never hold the process open for this: the bound protects close latency, it is
    // not work in its own right.
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([
      extractConversationMemory(run.tenantId, userId, transcript, (text) => llmExtractFacts(run.tenantId, text, userId))
        .then(() => 'done' as const)
        .catch((e) => {
          // WARN, not debug: a consent-gated write that failed is the user's memory
          // silently not being written.
          logger.warn('memory_extraction_failed', { error: e instanceof Error ? e.message : String(e) });
          return 'failed' as const;
        }),
      budget,
    ]);
    if (outcome === 'timeout') {
      logger.warn('memory_extraction_abandoned', { budgetMs });
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}
