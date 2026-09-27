/**
 * Conversation turn reconstruction from the durable event log (ADR 0327 P1).
 *
 * A leaf module. Extracted from `conversationExchange.ts` — which re-exports it
 * under the same public names — so `chatContext.ts` can import it directly
 * instead of reaching back into the orchestrator (that edge was one half of a
 * circular import; see the ADR 0327 correction note).
 */

import type { Storage } from '../../storage/storage.js';
import type { ConversationTurn } from '../conversation.js';

/** Reconstruct the conversation's turns from the durable event log (sorted by
 *  turnIndex). The open turn + every exchanged turn for this conversationId. */
/** CS-BE-2 (conversation-stack audit 2026-07-09) — incremental turn fold.
 *  The old implementation re-listed + re-folded the run's ENTIRE event log on
 *  EVERY exchange — O(all events) per turn — and, worse, silently truncated at
 *  the storage adapters' default `limit: 1000`, so a very long conversation
 *  quietly lost its oldest turns. Now a per-instance cache remembers the last
 *  folded sequence per run and only new events are listed (drained in batches,
 *  no truncation). The EVENT LOG stays the durable truth: a cache miss on
 *  another instance simply refolds from sequence 0; a fork copies events to a
 *  NEW runId (fresh cache entry), so replay determinism is untouched. */
interface TurnsCacheEntry { lastSeq: number; byConversation: Map<string, ConversationTurn[]> }
const turnsCache = new Map<string, TurnsCacheEntry>();
const TURNS_CACHE_MAX_RUNS = 500; // oldest-entry eviction backstop
const EVENT_BATCH = 1000;

/** Test-only: drop the fold cache (suite isolation across in-memory storages). */
export function __resetTurnsCacheForTests(): void { turnsCache.clear(); }

export async function loadTurns(storage: Storage, runId: string, conversationId: string): Promise<ConversationTurn[]> {
  let entry = turnsCache.get(runId);
  if (entry) {
    // Grade-code polish — LRU touch: an ACTIVE long conversation must not be
    // the eviction victim just because it was inserted first.
    turnsCache.delete(runId);
    turnsCache.set(runId, entry);
  } else {
    if (turnsCache.size >= TURNS_CACHE_MAX_RUNS) {
      const oldest = turnsCache.keys().next().value; // least-recently USED (Map order + touch)
      if (oldest) turnsCache.delete(oldest);
    }
    // The cursor is EXCLUSIVE and the first event is sequence 0 (RFC 0171 §A.3),
    // so a fresh entry starts at -1; 0 skipped the run's first turn.
    entry = { lastSeq: -1, byConversation: new Map() };
    turnsCache.set(runId, entry);
  }
  // Drain new events in batches (fromSeq is EXCLUSIVE in the adapters).
  for (;;) {
    const events = await storage.listEvents(runId, { fromSeq: entry.lastSeq, limit: EVENT_BATCH });
    for (const e of events) {
      if (e.sequence > entry.lastSeq) entry.lastSeq = e.sequence;
      const p = (e.payload ?? {}) as { conversationId?: string; initialTurn?: ConversationTurn; turn?: ConversationTurn };
      if (typeof p.conversationId !== 'string') continue;
      const turn = e.type === 'conversation.opened' ? p.initialTurn : e.type === 'conversation.exchanged' ? p.turn : undefined;
      if (!turn) continue;
      const list = entry.byConversation.get(p.conversationId) ?? [];
      list.push(turn);
      entry.byConversation.set(p.conversationId, list);
    }
    if (events.length < EVENT_BATCH) break;
  }
  // Sorted by turnIndex, and — for the historical rows where two turns share an
  // index (ADR 0491: a tool wrote a run turn at the same index the exchange had
  // reserved) — by EVENT ORDER within that index. `Array.prototype.sort` is
  // stable per ES2019 and the list is built by pushing in event-sequence order,
  // so the tiebreak is the write order. Stated explicitly because the ordering of
  // those duplicate rows is user-visible and would otherwise look accidental.
  return [...(entry.byConversation.get(conversationId) ?? [])].sort((a, b) => a.turnIndex - b.turnIndex);
}
