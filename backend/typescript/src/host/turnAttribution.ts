/**
 * Per-turn model attribution (ADR 0986 D1) — which model ANSWERED each
 * conversation agent turn, recorded by the host at the exchange.
 *
 * Why a host store: the ONE chat's turns carry no model (the 1:1 chat resolves
 * no agent, so RFC 0109 `agent.model` is unstamped on most turns), the run's
 * event log holds no model either, and the client-written `chat_messages.meta`
 * is forgeable. The exchange is the only place that knows what answered, so it
 * writes here, and the evals leaderboard (ratings, arena) reads here.
 *
 * Host-internal and never served on a run or turn read — no wire change.
 * Keyed by the CANONICAL message id the SPA rates (`conversationMessageId`),
 * with no tenant index (every read is a point get). No subject data: ids,
 * provider, model, a time. Ages out after 180 days; a rating stamps what it
 * needs at write, so it never reads a row back after that.
 *
 * A fork copies turn ids verbatim (`runs.ts` fork copies event payloads), so a
 * forked run's turn ids resolve to the SOURCE run's rows: every consumer checks
 * `row.runId` against the run it is asking about.
 *
 * @see docs/adr/0986-evals-attributed-leaderboard-and-bound-arena.md
 */
import { DurableCollection } from './hostExtPersistence.js';
import { registerKvAgeOut } from './kvAgeOut.js';
import { mockProviderEnabled } from '../aiProviders/aiProvidersHost.js';
import { conversationMessageId } from './conversationMessageId.js';
import { createLogger } from '../observability/logger.js';
import { getConversationMeta } from './conversationStore.js';

const log = createLogger('host.turnAttribution');

/** What answered a turn. `managed` marks a managed TIER id (the managed provider
 *  deliberately never exposes its underlying model), not a model. */
export interface ServedModel { provider: string; model: string; managed?: true }

export interface TurnAttribution extends ServedModel {
  tenantId: string;
  /** The canonical id the SPA rates: `conversationMessageId(wireMessageId)`. */
  messageId: string;
  /** The RFC 0005 wire turn id. */
  wireMessageId: string;
  runId: string;
  /** `run.metadata.chatSessionId` at exchange time, when the run carried one. */
  chatSessionId?: string;
  at: string;
}

export const TURN_ATTRIBUTION_TTL_DAYS = 180;

const rows = new DurableCollection<TurnAttribution>('chat:turn-model', (r) => `${r.tenantId}:${r.messageId}`);
registerKvAgeOut({ id: 'chat:turn-model', prefix: 'hostext:chat:turn-model:', ttlDays: TURN_ATTRIBUTION_TTL_DAYS, timestampField: 'at' });

/** Record what answered one agent turn. Best-effort: a failure is logged and
 *  swallowed — attribution must never fail the turn it describes. A mock reply
 *  is recorded only where the mock provider is enabled (ADR 0986 H4), so a
 *  scripted turn can never rank as a model on a production host. */
export async function recordTurnAttribution(input: {
  tenantId: string; wireMessageId: string; runId: string; chatSessionId?: string; served: ServedModel;
}): Promise<void> {
  const { served } = input;
  if (!served.provider || !served.model) return;
  if (served.provider === 'mock' && !mockProviderEnabled()) return;
  try {
    // CREATE-ONLY (code-review H1): a fork restores the source's suspended gate, so
    // its new turns reuse the source's wire ids. An overwrite would re-attribute the
    // source's turn to the fork's model; create-only keeps the first true writer,
    // and the fork's turn then fails every consumer's `row.runId` check.
    const created = await rows.compareAndSwap(null, {
      tenantId: input.tenantId,
      messageId: conversationMessageId(input.wireMessageId),
      wireMessageId: input.wireMessageId,
      runId: input.runId,
      ...(input.chatSessionId ? { chatSessionId: input.chatSessionId } : {}),
      provider: served.provider,
      model: served.model,
      ...(served.managed ? { managed: true as const } : {}),
      at: new Date().toISOString(),
    });
    // EV2CD-12 — a lost create is a fork (or a duplicate index) re-using a turn id.
    if (!created) log.info('turn_attribution_exists', { runId: input.runId });
  } catch (err) {
    log.warn('turn_attribution_write_failed', { runId: input.runId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** The attribution row for a canonical message id, or null. */
export async function getTurnAttribution(tenantId: string, messageId: string): Promise<TurnAttribution | null> {
  return rows.get(`${tenantId}:${messageId}`);
}

/** What a rating in `conversationId` of `messageId` may be attributed to (ADR
 *  0986 D2), or null. The row must belong to THIS conversation: its stamped
 *  `chatSessionId` matches, or — for a run an older SPA build bound without the
 *  stamp — the conversation's bound run IS the row's run. Never the body, never
 *  the client-written message meta, never another conversation's turn. */
export async function resolveRatingAttribution(
  tenantId: string, conversationId: string, messageId: string,
): Promise<{ served: ServedModel; runId: string } | null> {
  const row = await getTurnAttribution(tenantId, messageId);
  if (!row) return null;
  const belongs = row.chatSessionId !== undefined
    ? row.chatSessionId === conversationId
    : (await getConversationMeta(tenantId, conversationId))?.conversationRunId === row.runId;
  if (!belongs) return null;
  return { served: { provider: row.provider, model: row.model, ...(row.managed ? { managed: true as const } : {}) }, runId: row.runId };
}
