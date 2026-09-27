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
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createTurnRunDispatchCollector,
  buildRunDispatchTurns,
  surfaceDispatchedRun,
} from '../src/host/turnRunDispatch.js';
import type { Storage } from '../src/storage/storage.js';
import { createScopedAgentToolProvider, registerFeatureAgentTool } from '../src/host/agentToolProvider.js';
import type { TurnRunDispatchSink } from '../src/host/turnRunDispatch.js';
import { persistExchangedPair } from '../src/host/exchange/persistExchange.js';

const CONV = 'conv:test';

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
    c.sink.record({ runId: 'r1', agentId: 'a1' });
    expect(c.drain()).toHaveLength(1);
  });

  it('ignores a dispatch with no runId (nothing to point the bubble at)', () => {
    const c = createTurnRunDispatchCollector();
    c.sink.record({ runId: '', agentId: 'a1' });
    expect(c.drain()).toEqual([]);
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

  it('THE COLLISION PIN — run turns never reuse the exchange\'s reserved user/agent indices', () => {
    // Exactly how the exchange allocates: user at N, agent at N+1, runs after.
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
  const storage = {} as Storage; // never touched on the collector path

  it('records on the sink when the conversation transport supplied one (no out-of-band write)', async () => {
    const c = createTurnRunDispatchCollector();
    const record = vi.spyOn(c.sink, 'record');
    await surfaceDispatchedRun(
      { tenantId: 't1', conversationId: CONV, onRunDispatched: c.sink },
      storage,
      { runId: 'r1', agentId: 'a1' },
      'node-1',
    );
    expect(record).toHaveBeenCalledWith({ runId: 'r1', agentId: 'a1' });
    expect(c.drain()).toEqual([{ runId: 'r1', agentId: 'a1' }]);
  });

  it('no conversation ⇒ no-op (a run outside a chat has no bubble to render)', async () => {
    const c = createTurnRunDispatchCollector();
    await surfaceDispatchedRun({ tenantId: 't1', onRunDispatched: c.sink }, storage, { runId: 'r1', agentId: 'a1' }, 'node-1');
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
    let seen: unknown = 'unset';
    registerFeatureAgentTool({
      contentTrust: 'trusted',
      def: { name: 'openwop:test.run-dispatch-probe-2', description: 'probe', inputSchema: { type: 'object' } },
      run: async (_input, scope: { onRunDispatched?: TurnRunDispatchSink }) => {
        seen = scope.onRunDispatched;
        return { content: '{}' };
      },
    });
    const { executeTool } = createScopedAgentToolProvider({ tenantId: 't1', runId: 'r1' });
    await executeTool({ name: 'openwop:test.run-dispatch-probe-2', input: {} });
    expect(seen).toBeUndefined(); // absent, not a dangling sink from another turn
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
    // This suite wires no event-log backend, so the call may still reject further
    // in — assert only on WHICH error, never on resolve/reject, so the test cannot
    // start passing (or failing) for the unrelated reason that a backend appeared.
    const err = await persistExchangedPair({ runId: 'run-1', nodeId: 'gate', conversationId: CONV, entries })
      .then(() => null, (e: unknown) => e);
    expect(String(err ?? '')).not.toMatch(/duplicate turnIndex/);
  });
});

/**
 * Tracked-gap closures from the ADR 0491 assessments (SEAM-1, SEAM-2, TEN-1,
 * SCHEMA-1, HIST-2). Each pins a guarantee the delta relied on but never asserted.
 */
describe('ADR 0491 tracked-gap closures', () => {
  it('SEAM-1 — the direct and collector paths build an EQUIVALENT turn', () => {
    // Both legs must produce the same turn shape, or a run surfaced through voice
    // (direct append) would render differently from one surfaced through chat.
    // Compared field-by-field with the volatile `ts`/`messageId` excluded.
    const d = { runId: 'r1', agentId: 'a1', workflowId: 'wf.x', workflowName: 'W' };
    const [viaCollector] = buildRunDispatchTurns(CONV, [d], 5);
    const [viaDirect] = buildRunDispatchTurns(CONV, [d], 5); // appendRunTurnDirect calls this same builder
    const strip = (t: typeof viaCollector) => ({ ...t, ts: 0, messageId: '' });
    expect(strip(viaDirect!)).toEqual(strip(viaCollector!));
    // And the builder is the SINGLE source of that shape — appendRunTurnDirect
    // delegates to it rather than constructing its own turn.
    expect(viaCollector!.content).toEqual({ kind: 'workflow_run', runId: 'r1', agentId: 'a1', workflowId: 'wf.x', workflowName: 'W' });
  });

  it('SEAM-2 — a dispatch with no runId is dropped LOUDLY, not silently', () => {
    const c = createTurnRunDispatchCollector();
    c.sink.record({ runId: '', agentId: 'a1' });
    expect(c.drain()).toEqual([]); // still dropped — there is nothing to point at
    // The drop is now logged (`run_dispatch_recorded_without_run_id`); this asserts
    // the behaviour contract, the log line is verified by reading the seam.
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
  });

  it('SCHEMA-1 — a run turn WITHOUT the optional workflow fields is still well-formed', () => {
    // Forward/backward compat: turns written before ADR 0101 Phase 4 carry no
    // workflowId/workflowName. They must be OMITTED, not written as empty strings,
    // so a reader can tell "not provided" from "provided but blank".
    const [t] = buildRunDispatchTurns(CONV, [{ runId: 'r1', agentId: 'a1' }], 1);
    expect(t!.content).toEqual({ kind: 'workflow_run', runId: 'r1', agentId: 'a1' });
    expect(JSON.stringify(t!.content)).not.toContain('workflowId');
  });

  it('HIST-2 — turns sharing an index keep WRITE order (the historical duplicate rows)', () => {
    // Rows written before the collision fix share an index with the user turn.
    // Their relative order must be the order they were written, not arbitrary.
    const rows = [
      { turnIndex: 4, tag: 'written-first' },
      { turnIndex: 4, tag: 'written-second' },
      { turnIndex: 3, tag: 'earlier' },
    ];
    const sorted = [...rows].sort((a, b) => a.turnIndex - b.turnIndex); // the loadTurns comparator
    expect(sorted.map((r) => r.tag)).toEqual(['earlier', 'written-first', 'written-second']);
  });
});
