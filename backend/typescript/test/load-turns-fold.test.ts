/**
 * GC-CHAT-1 (grade pass 2026-07-10) — the CS-BE-2 fold-cache characterization
 * tests the seams suite's header had CLAIMED since the fix landed but never
 * contained. Pins the two properties the incremental fold exists for:
 *
 *  1. NO TRUNCATION: a conversation whose event log exceeds the storage
 *     adapters' default 1000-row `listEvents` limit (and loadTurns' own
 *     EVENT_BATCH) folds EVERY turn — the pre-CS-BE-2 implementation silently
 *     lost the oldest turns past row 1000.
 *  2. INCREMENTAL DRAIN: a second fold after new events lists only the delta
 *     (observed via a listEvents spy), yet returns exactly what a cold fold
 *     of the full log returns — the cache is an optimization, never an owner.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { loadTurns, __resetTurnsCacheForTests } from '../src/host/exchange/loadTurns.js';

const CONV = 'conv-fold-1';
const RUN = 'run-fold-1';

/** Append one conversation.exchanged event carrying turn N (plus periodic
 *  unrelated events, so the fold filters as it would in a real log). */
async function appendTurnEvents(storage: Storage, runId: string, from: number, to: number): Promise<void> {
  const batch = [];
  for (let n = from; n < to; n++) {
    if (n % 5 === 0) {
      batch.push({
        eventId: `evt-noise-${n}`, runId, type: 'node.completed',
        payload: { outputs: { n } }, timestamp: new Date().toISOString(),
      });
    }
    batch.push({
      eventId: `evt-turn-${n}`, runId,
      type: n === from && from === 0 ? 'conversation.opened' : 'conversation.exchanged',
      payload: n === from && from === 0
        ? { conversationId: CONV, initialTurn: { turnIndex: n, role: 'user', content: `turn ${n}` } }
        : { conversationId: CONV, turn: { turnIndex: n, role: n % 2 ? 'assistant' : 'user', content: `turn ${n}` } },
      timestamp: new Date().toISOString(),
    });
  }
  await storage.appendEventsBatch(batch);
}

describe('GC-CHAT-1 — loadTurns fold cache (CS-BE-2 characterization)', () => {
  beforeEach(() => __resetTurnsCacheForTests());

  it('folds every turn past the adapters` default 1000-event limit (no truncation)', async () => {
    const storage = await openStorage('memory://');
    // 1,400 turns + 280 noise events = 1,680 events ≫ EVENT_BATCH (1000).
    await appendTurnEvents(storage, RUN, 0, 1400);
    const turns = await loadTurns(storage, RUN, CONV);
    expect(turns).toHaveLength(1400);
    // Order + completeness: turnIndex 0..1399 exactly once each.
    expect(turns[0]!.turnIndex).toBe(0);
    expect(turns[1399]!.turnIndex).toBe(1399);
    expect(new Set(turns.map((t) => t.turnIndex)).size).toBe(1400);
    // The OLDEST turn (the pre-fix truncation victim) is intact.
    expect((turns[0] as { content?: string }).content).toBe('turn 0');
  });

  it('drains only the delta on a warm fold, matching a cold fold byte-for-byte', async () => {
    const storage = await openStorage('memory://');
    await appendTurnEvents(storage, RUN, 0, 1200);

    let listCalls = 0;
    const spied: Storage = new Proxy(storage, {
      get(target, prop, recv) {
        if (prop === 'listEvents') {
          return (...args: Parameters<Storage['listEvents']>) => { listCalls += 1; return target.listEvents(...args); };
        }
        return Reflect.get(target, prop, recv);
      },
    });

    const first = await loadTurns(spied, RUN, CONV);
    expect(first).toHaveLength(1200);
    const coldCalls = listCalls; // 1,440 events ⇒ 2 full batches + the short tail

    // Append a small delta; the warm fold must list ONE batch, not re-fold.
    await appendTurnEvents(storage, RUN, 1200, 1210);
    const second = await loadTurns(spied, RUN, CONV);
    expect(second).toHaveLength(1210);
    expect(listCalls - coldCalls).toBe(1);

    // And the warm result equals a COLD fold of the same log (cache = pure optimization).
    __resetTurnsCacheForTests();
    const cold = await loadTurns(storage, RUN, CONV);
    expect(second).toEqual(cold);
  });
});
