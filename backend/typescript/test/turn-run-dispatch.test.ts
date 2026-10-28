/**
 * Turn-scoped run-dispatch surfacing (`host/turnRunDispatch.ts`).
 *
 * REGRESSION ORIGIN (2026-07-25, Challenge Factory incident). A user asked the
 * Challenge Author to build a challenge; the tool really did ignite a run, the
 * agent narrated "the run is active", and the chat showed NOTHING — no inline
 * bubble, and a Workflow-progress rail reading "No workflow runs yet". Two
 * distinct defects, both pinned here:
 *
 *   1. TWO turnIndex allocators. The exchange reserves N (user) / N+1 (agent)
 *      from turns loaded before dispatch; the tool then re-read the log — which
 *      still lacked the not-yet-persisted user turn — and allocated N again. The
 *      run bubble collided with the user's own message.
 *   2. The run turn was written out-of-band, AFTER the exchange had already
 *      computed its response from a pre-dispatch snapshot, so it never reached
 *      the client until a full reload.
 *
 * The seam moves allocation + materialization to the exchange (the one owner of
 * both) and leaves tools with a record-only sink.
 *
 * Protected (incident witness). Wave 61 — every case keeps its place; what changed:
 *   - SEAM-1 compared `buildRunDispatchTurns` with ITSELF (probe trd-seam1,
 *     vacuous). It now drives the REAL `appendRunTurnDirect` against a
 *     sqlite-memory event log + conversation meta and reads the turn back
 *     through `loadTurns`.
 *   - HIST-2 sorted a local array with a local comparator (trd-hist2, vacuous).
 *     It now writes the duplicate-index rows through `persistExchangedPair` and
 *     reads them through `loadTurns`.
 *   - THE COLLISION PIN re-derives the exchange's arithmetic locally, so it
 *     proves the BUILDER never reuses indices below `firstIndex` — not the
 *     exchange. The real allocator, `conversationExchange.ts` ~:737
 *     (`buildRunDispatchTurns(…, agentIndex + 1)` inside
 *     `handleConversationResolve`), is NOT covered by any test (probe
 *     trd-collision-exchange, vacuous): a grade-code row, EXCH-ALLOC-1.
 *   - SCHEMA-1 uses `toStrictEqual` (a `workflowId: undefined` key is not
 *     "omitted"); "omits the sink" checks key ABSENCE with `Object.hasOwn`.
 *   - the dedupe case records the SAME runId with a DIFFERENT agentId, so the
 *     first-wins `has()` guard is observable (trd-dedupe-has was vacuous: a
 *     same-value overwrite looks identical).
 *   - SEAM-2 witnesses its log line; "ignores a dispatch with no runId" is its
 *     twin and now also asserts the drop does not poison a later valid record.
 *   - the routing cases pass a storage Proxy that THROWS on any use, instead of
 *     `{} as Storage`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendRunTurnDirect,
  createTurnRunDispatchCollector,
  buildRunDispatchTurns,
  surfaceDispatchedRun,
} from '../src/host/turnRunDispatch.js';
import type { Storage } from '../src/storage/storage.js';
import { createScopedAgentToolProvider, registerFeatureAgentTool } from '../src/host/agentToolProvider.js';
import type { TurnRunDispatch, TurnRunDispatchSink } from '../src/host/turnRunDispatch.js';
import { persistExchangedPair } from '../src/host/exchange/persistExchange.js';
import { loadTurns, __resetTurnsCacheForTests } from '../src/host/exchange/loadTurns.js';
import { setConversationRun } from '../src/host/conversationStore.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import type { ConversationTurn } from '../src/host/conversation.js';

const CONV = 'conv:test';

// A real sqlite-memory event log + host-ext persistence (conversation metas),
// for the cases that drive the durable path end to end.
const storage = openSqliteStorage(':memory:');
beforeAll(() => {
  initHostExtPersistence(storage);
  setEventLogBackend(storage);
});
afterAll(async () => {
  __resetHostExtPersistence();
  await storage.close();
});
beforeEach(() => __resetTurnsCacheForTests());

/** Capture structured log lines (JSON on stdout) emitted while `fn` runs. */
function logLinesDuring(msg: string, fn: () => void): Array<Record<string, unknown>> {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array, ...rest: unknown[]) => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return orig(chunk, ...(rest as []));
  });
  try { fn(); } finally { spy.mockRestore(); }
  const out: Array<Record<string, unknown>> = [];
  for (const l of lines.join('').split('\n')) {
    if (!l.startsWith('{')) continue;
    try { const j = JSON.parse(l) as Record<string, unknown>; if (j.msg === msg) out.push(j); } catch { /* not a log line */ }
  }
  return out;
}

describe('createTurnRunDispatchCollector', () => {
  it('collects what tools record, in order', () => {
    const c = createTurnRunDispatchCollector();
    c.sink.record({ runId: 'r1', agentId: 'a1' });
    c.sink.record({ runId: 'r2', agentId: 'a2' });
    expect(c.drain()).toEqual([
      { runId: 'r1', agentId: 'a1' },
      { runId: 'r2', agentId: 'a2' },
    ]);
  });

  it('dedupes by runId — a retried tool call must not double-render a bubble', () => {
    const c = createTurnRunDispatchCollector();
    c.sink.record({ runId: 'r1', agentId: 'a1' });
    // The retry carries a different agentId: the FIRST record is kept, not
    // rewritten (a same-value overwrite would hide the has() guard).
    c.sink.record({ runId: 'r1', agentId: 'a2' });
    expect(c.drain()).toEqual([{ runId: 'r1', agentId: 'a1' }]);
  });

  it('ignores a dispatch with no runId (nothing to point the bubble at)', () => {
    // Twin of SEAM-2 below (which witnesses the log line); this one also pins
    // that the dropped record does not poison a later valid one.
    const c = createTurnRunDispatchCollector();
    c.sink.record({ runId: '', agentId: 'a1' });
    expect(c.drain()).toEqual([]);
    c.sink.record({ runId: 'r2', agentId: 'a1' });
    expect(c.drain()).toEqual([{ runId: 'r2', agentId: 'a1' }]);
  });
});

describe('buildRunDispatchTurns', () => {
  it('allocates sequential indices from firstIndex and carries the workflow_run reference', () => {
    const turns = buildRunDispatchTurns(CONV, [{ runId: 'r1', agentId: 'a1' }, { runId: 'r2', agentId: 'a2' }], 7);
    expect(turns.map((t) => t.turnIndex)).toEqual([7, 8]);
    expect(turns[0]!.content).toEqual({ kind: 'workflow_run', runId: 'r1', agentId: 'a1' });
    expect(turns[0]!.role).toBe('agent');
    // RFC 0101 — the bubble is attributed to the dispatching agent, not 'assistant'.
    expect(turns[0]!.speakerId).toBe('a1');
  });

  it('THE COLLISION PIN — given the exchange\'s firstIndex, the builder never reuses an index below it', () => {
    // The exchange's arithmetic, re-derived here: user at N, agent at N+1, runs
    // after. This proves the BUILDER half only; the exchange's own call site
    // (conversationExchange.ts ~:737) is uncovered — EXCH-ALLOC-1, see header.
    const nextIndex = 4;
    const agentIndex = nextIndex + 1;
    const runTurns = buildRunDispatchTurns(CONV, [{ runId: 'r1', agentId: 'a1' }, { runId: 'r2', agentId: 'a2' }], agentIndex + 1);
    const all = [nextIndex, agentIndex, ...runTurns.map((t) => t.turnIndex)];
    expect(new Set(all).size).toBe(all.length); // no duplicate index anywhere in the turn
    expect(Math.min(...runTurns.map((t) => t.turnIndex))).toBeGreaterThan(agentIndex);
  });

  it('returns nothing when no run was dispatched', () => {
    expect(buildRunDispatchTurns(CONV, [], 3)).toEqual([]);
  });
});

describe('surfaceDispatchedRun — transport routing', () => {
  // Never touched on these paths: any use at all throws.
  const untouchable: Storage = new Proxy(storage, {
    get(_target, prop) { throw new Error(`storage.${String(prop)} must not be touched on this path`); },
  });

  it('records on the sink when the conversation transport supplied one (no out-of-band write)', async () => {
    const c = createTurnRunDispatchCollector();
    const record = vi.spyOn(c.sink, 'record');
    await surfaceDispatchedRun(
      { tenantId: 't1', conversationId: CONV, onRunDispatched: c.sink },
      untouchable,
      { runId: 'r1', agentId: 'a1' },
      'node-1',
    );
    expect(record).toHaveBeenCalledWith({ runId: 'r1', agentId: 'a1' });
    expect(c.drain()).toEqual([{ runId: 'r1', agentId: 'a1' }]);
  });

  it('no conversation ⇒ no-op (a run outside a chat has no bubble to render)', async () => {
    const c = createTurnRunDispatchCollector();
    await surfaceDispatchedRun({ tenantId: 't1', onRunDispatched: c.sink }, untouchable, { runId: 'r1', agentId: 'a1' }, 'node-1');
    expect(c.drain()).toEqual([]);
  });
});

/**
 * WIRING (gap EXCH-1 from the ADR 0491 delta audit; the repo's own lesson that
 * "daemon-wiring tests beat unit tests").
 *
 * The seam is only as good as the thread that carries it. `AgentToolCallScope` is
 * the ADR 0324 ONE composer — its docblock warns that a new scope field "lands here
 * once and reaches every transport, or reaches none". `onRunDispatched` is such a
 * field: if the passthrough in `createScopedAgentToolProvider` is dropped, every
 * tool silently falls back to the out-of-band append and the original defect
 * returns — with all the unit tests above still green, because each half works.
 * This pins the JOIN.
 */
describe('scope wiring — onRunDispatched reaches the tool (ADR 0324 composer)', () => {
  it('threads the sink from AgentToolCallScope into the BundleScope a tool receives', async () => {
    const collector = createTurnRunDispatchCollector();
    let seen: unknown;
    registerFeatureAgentTool({
      contentTrust: 'trusted',
      effect: 'read', // test probe (ADR 0784)
      def: { name: 'openwop:test.run-dispatch-probe', description: 'probe', inputSchema: { type: 'object' } },
      run: async (_input, scope: { onRunDispatched?: TurnRunDispatchSink }) => {
        seen = scope.onRunDispatched;
        scope.onRunDispatched?.record({ runId: 'wired-run', agentId: 'a1' });
        return { content: '{}' };
      },
    });
    const { executeTool } = createScopedAgentToolProvider({
      tenantId: 't1', runId: 'r1', conversationId: CONV, onRunDispatched: collector.sink,
    });
    await executeTool({ name: 'openwop:test.run-dispatch-probe', input: {} });

    expect(seen, 'the sink must survive the composer → BundleScope hop').toBe(collector.sink);
    expect(collector.drain()).toEqual([{ runId: 'wired-run', agentId: 'a1' }]);
  });

  it('omits the sink when the transport supplies none (voice/agent-runner keep the direct append)', async () => {
    let seenScope: object | undefined;
    registerFeatureAgentTool({
      contentTrust: 'trusted',
      effect: 'read', // test probe (ADR 0784)
      def: { name: 'openwop:test.run-dispatch-probe-2', description: 'probe', inputSchema: { type: 'object' } },
      run: async (_input, scope: { onRunDispatched?: TurnRunDispatchSink }) => {
        seenScope = scope;
        return { content: '{}' };
      },
    });
    const { executeTool } = createScopedAgentToolProvider({ tenantId: 't1', runId: 'r1' });
    await executeTool({ name: 'openwop:test.run-dispatch-probe-2', input: {} });
    expect(seenScope, 'the probe tool must have run').toBeDefined();
    // ABSENT — not present-with-undefined, and not a dangling sink from another turn.
    expect(Object.hasOwn(seenScope!, 'onRunDispatched')).toBe(false);
  });
});

/**
 * ADR 0491 gap CONV-1 — the single-allocator invariant, enforced rather than
 * merely documented. `persistExchangedPair` appends without dedup, so a caller
 * that hands it two turns at one index silently creates the exact artifact this
 * ADR removes. It now refuses.
 */
describe('persistExchangedPair — duplicate-index precondition', () => {
  const t = (turnIndex: number) => buildRunDispatchTurns(CONV, [{ runId: `r${turnIndex}`, agentId: 'a' }], turnIndex)[0]!;

  it('refuses a batch containing two turns at the same index', async () => {
    await expect(persistExchangedPair({
      runId: 'run-1', nodeId: 'gate', conversationId: CONV,
      entries: [[3, t(3)], [3, t(3)]],
    })).rejects.toThrow(/duplicate turnIndex/);
  });

  it('accepts the exchange\'s real shape — user, agent, then run turns, all distinct', async () => {
    const nextIndex = 2;
    const agentIndex = nextIndex + 1;
    const runTurns = buildRunDispatchTurns(CONV, [{ runId: 'r1', agentId: 'a' }], agentIndex + 1);
    const entries: Array<[number, ReturnType<typeof t>]> = [
      [nextIndex, t(nextIndex)], [agentIndex, t(agentIndex)],
      ...runTurns.map((rt) => [rt.turnIndex, rt] as [number, ReturnType<typeof t>]),
    ];
    // This file now wires a sqlite-memory event-log backend (for SEAM-1/HIST-2),
    // but assert only on WHICH error, never on resolve/reject, so the test cannot
    // start passing (or failing) for the unrelated reason of backend wiring.
    const err = await persistExchangedPair({ runId: 'run-accept', nodeId: 'gate', conversationId: CONV, entries })
      .then(() => null, (e: unknown) => e);
    expect(String(err ?? '')).not.toMatch(/duplicate turnIndex/);
  });
});

/**
 * Tracked-gap closures from the ADR 0491 assessments (SEAM-1, SEAM-2, TEN-1,
 * SCHEMA-1, HIST-2). Each pins a guarantee the delta relied on but never asserted.
 */
describe('ADR 0491 tracked-gap closures', () => {
  it('SEAM-1 — the direct and collector paths build an EQUIVALENT turn', async () => {
    // Both legs must produce the same turn shape, or a run surfaced through voice
    // (direct append) would render differently from one surfaced through chat.
    // The DIRECT leg is driven for real: appendRunTurnDirect allocates the next
    // index from the durable log, persists, and the turn is read back.
    const conv = 'conv:seam1';
    const backingRun = 'conv-run-seam1';
    await setConversationRun('t1', conv, backingRun);
    // One existing turn at index 4, so the direct allocator must pick 5.
    const [existing] = buildRunDispatchTurns(conv, [{ runId: 'r-existing', agentId: 'a0' }], 4);
    await persistExchangedPair({ runId: backingRun, nodeId: 'seed', conversationId: conv, entries: [[4, existing!]] });

    const d: TurnRunDispatch = { runId: 'r1', agentId: 'a1', workflowId: 'wf.x', workflowName: 'W' };
    await appendRunTurnDirect(storage, 't1', conv, d, 'node-1');
    __resetTurnsCacheForTests();
    const turns = await loadTurns(storage, backingRun, conv);
    expect(turns.map((t) => t.turnIndex), 'the direct append must have persisted at the next index').toEqual([4, 5]);
    const viaDirect = turns[1]!;

    const [viaCollector] = buildRunDispatchTurns(conv, [d], 5);
    // Compared field-by-field with only the volatile `ts` excluded.
    const strip = (t: ConversationTurn): ConversationTurn => ({ ...t, ts: 0 });
    expect(strip(viaDirect)).toEqual(strip(viaCollector!));
    expect(viaDirect.content).toEqual({ kind: 'workflow_run', runId: 'r1', agentId: 'a1', workflowId: 'wf.x', workflowName: 'W' });
    expect(viaDirect.speakerId).toBe('a1');
  });

  it('SEAM-2 — a dispatch with no runId is dropped LOUDLY, not silently', () => {
    const c = createTurnRunDispatchCollector();
    const lines = logLinesDuring('run_dispatch_recorded_without_run_id', () => {
      c.sink.record({ runId: '', agentId: 'a-loud', workflowId: 'wf.loud' });
    });
    expect(c.drain()).toEqual([]); // still dropped — there is nothing to point at
    // …and the drop is LOGGED, naming who dropped it.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'warn', agentId: 'a-loud', workflowId: 'wf.loud' });
  });

  it('TEN-1 — the sink carries no tenant, so a bubble cannot be aimed cross-tenant', () => {
    // The recorded shape is deliberately narrow: a tool can name a run and an
    // agent, never a tenant or a conversation. The exchange decides BOTH, so the
    // destination is never attacker-chosen; a foreign runId simply fails to
    // dereference against the tenant-scoped run routes.
    const c = createTurnRunDispatchCollector();
    c.sink.record({ runId: 'run-from-another-tenant', agentId: 'a1' });
    const [rec] = c.drain();
    expect(Object.keys(rec!).sort()).toEqual(['agentId', 'runId']);
    expect(rec).not.toHaveProperty('tenantId');
    expect(rec).not.toHaveProperty('conversationId');
    // And the BUILDER ignores any tenant/conversation a non-literal record smuggles
    // in: the turn lands in the conversation the exchange named, and its content
    // carries only the run reference.
    const smuggled = { runId: 'run-x', agentId: 'a1', tenantId: 'tenant-other', conversationId: 'conv:other' };
    const [turn] = buildRunDispatchTurns(CONV, [smuggled], 1);
    expect(turn!.groupId).toBe(CONV);
    expect(turn!.messageId.startsWith(`${CONV}:`)).toBe(true);
    expect(turn!.content).toStrictEqual({ kind: 'workflow_run', runId: 'run-x', agentId: 'a1' });
  });

  it('SCHEMA-1 — a run turn WITHOUT the optional workflow fields is still well-formed', () => {
    // Forward/backward compat: turns written before ADR 0101 Phase 4 carry no
    // workflowId/workflowName. They must be OMITTED, not written as empty strings,
    // so a reader can tell "not provided" from "provided but blank".
    const [t] = buildRunDispatchTurns(CONV, [{ runId: 'r1', agentId: 'a1' }], 1);
    // Strict: a `workflowId: undefined` key is NOT omitted, and toEqual ignores it.
    expect(t!.content).toStrictEqual({ kind: 'workflow_run', runId: 'r1', agentId: 'a1' });
    expect(JSON.stringify(t!.content)).not.toContain('workflowId');
  });

  it('HIST-2 — turns sharing an index keep WRITE order (the historical duplicate rows)', async () => {
    // Rows written before the collision fix share an index with the user turn.
    // Their relative order must be the order they were written, not arbitrary.
    // Written for real (separate batches, so the duplicate-index precondition
    // does not refuse them) and read back through loadTurns.
    const conv = 'conv:hist2';
    const run = 'conv-run-hist2';
    const turnFor = (runId: string, idx: number): ConversationTurn => buildRunDispatchTurns(conv, [{ runId, agentId: 'a' }], idx)[0]!;
    await persistExchangedPair({ runId: run, nodeId: 'n', conversationId: conv, entries: [[4, turnFor('written-first', 4)]] });
    await persistExchangedPair({ runId: run, nodeId: 'n', conversationId: conv, entries: [[4, turnFor('written-second', 4)]] });
    await persistExchangedPair({ runId: run, nodeId: 'n', conversationId: conv, entries: [[3, turnFor('earlier', 3)]] });
    __resetTurnsCacheForTests();
    const turns = await loadTurns(storage, run, conv);
    expect(turns.map((t) => t.content)).toEqual([
      expect.objectContaining({ runId: 'earlier' }),
      expect.objectContaining({ runId: 'written-first' }),
      expect.objectContaining({ runId: 'written-second' }),
    ]);
  });
});
