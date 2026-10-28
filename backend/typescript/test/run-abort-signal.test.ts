/**
 * ADR 0553 P3 — the run's cancellation signal, and the wiring that makes it
 * reach an in-flight outbound call.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `mcp-cancel-reconnect.test.ts`. That file
 * drives `makeMcpClient` with an `AbortController` it constructs itself, which
 * proves the CLIENT honours a signal — and would go on passing if the executor
 * never supplied one, which is exactly the state the code was in before P3
 * (`McpClientDeps.signal` had existed since ADR 0030 Phase 2b, was consumed in
 * six places, and NOTHING EVER PASSED ONE). A client test cannot tell "wired"
 * from "wireable". So the second half of this file runs a REAL workflow through
 * `executeRun`, cancels it through the real cancel recipe, and reads the node's
 * outcome — the only arrangement in which a broken wiring can go red.
 *
 * Breaks it (round-1 probes, witnessed): the terminal listener aborting only one
 * segment (8fw2g2-ras-all), the controller not released (ras-release), a re-arm
 * reusing the old controller (ras-fresh), the past-deadline/future-deadline
 * timers (ras-past / ras-future), the MCP deps `signal` dropped (ras-wire) and
 * the executor never arming (ras-arm).
 *
 * The seam cases run on FAKE timers (`vi.useFakeTimers()` fakes `Date.now` and
 * `setTimeout`, both of which `armRunAbort` reads), so each deadline is checked
 * 1 ms either side of the boundary with no real-clock sleep. The e2e cancel is
 * fired by the PEER when the `tools/call` request arrives, so it lands in flight
 * by construction rather than by a 250 ms guess.
 *
 * DOUBLE GUARD on "a run cancelled mid-flight STAYS cancelled": the finalize
 * re-read in `executor.ts` (`recordedStatus` … `isTerminalRunStatus`) AND the
 * RFC 0194 closed run log (`cancelRunAndCascade` appends `run.cancelled`, so the
 * node's own `node.completed` append throws `RunLogClosedError` and
 * `executeRun` returns the recorded status). Removing the finalize guard alone
 * stays green on the real cancel recipe (round-1 8fw2g2-ras-finalize VACUOUS).
 * The case 'the finalize re-read alone keeps a terminal row…' flips the row
 * WITHOUT closing the log, so only the finalize guard stands
 * (8fw2g2-ras-finalize-r2).
 *
 * @see spec/v1/mcp-integration.md §C.1; src/executor/runLifecycle.ts
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { armRunAbort, notifyRunTerminal, runAbortSignal, _resetRunLifecycle } from '../src/executor/runLifecycle.js';
import { executeRun } from '../src/executor/executor.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { setRuntimeCapabilities } from '../src/executor/runtimeCapabilities.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { configureSecretResolver } from '../src/byok/secretResolver.js';
import { cancelRunAndCascade } from '../src/host/runCancel.js';
import { registerProvider } from '../src/features/connections/providerRegistry.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import type { NodeModule, WorkflowDefinition } from '../src/executor/types.js';

describe('armRunAbort / runAbortSignal — the seam', () => {
  beforeEach(() => {
    _resetRunLifecycle();
    vi.useFakeTimers({ now: Date.UTC(2026, 0, 15, 12, 0, 0) });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('a run reaching terminal aborts its signal', () => {
    const signal = armRunAbort('run-1');
    expect(signal.aborted).toBe(false);
    notifyRunTerminal('run-1', 'cancelled');
    expect(signal.aborted).toBe(true);
  });

  it('every node of a run shares ONE cancellation fact — the armed signal is what readers get', () => {
    const a = armRunAbort('run-2');
    expect(runAbortSignal('run-2')).toBe(a);
    expect(runAbortSignal('run-2')).toBe(runAbortSignal('run-2'));
  });

  it('ADR 0772 D1.4 — a re-arm (a resumed segment) gets a FRESH signal; the old segment keeps its own deadline', () => {
    // This test used to pin `armRunAbort` as idempotent. That was the defect
    // (`RRWF-2`): the first segment's deadline survived a suspend and every
    // resumed node was handed an already-aborted signal.
    const first = armRunAbort('run-2b', Date.now() + 30);
    const second = armRunAbort('run-2b', Date.now() + 60_000);
    expect(second).not.toBe(first);
    expect(runAbortSignal('run-2b')).toBe(second);
    vi.advanceTimersByTime(29);
    expect(first.aborted, '1 ms before its deadline').toBe(false);
    vi.advanceTimersByTime(2);
    // The old segment's own deadline still cuts ITS nodes (the unfenced resume
    // path can leave some in flight) — and never reaches the new segment.
    expect(first.aborted).toBe(true);
    expect(second.aborted, 'the new segment must not inherit the old deadline').toBe(false);
    notifyRunTerminal('run-2b', 'completed');
    expect(second.aborted).toBe(true);
    expect(runAbortSignal('run-2b')).toBeUndefined();
  });

  it('terminal aborts EVERY live segment controller through one listener (no per-segment accumulation)', () => {
    const a = armRunAbort('run-2c', Date.now() + 60_000);
    const b = armRunAbort('run-2c', Date.now() + 60_000);
    const c = armRunAbort('run-2c', Date.now() + 60_000);
    notifyRunTerminal('run-2c', 'cancelled');
    expect([a.aborted, b.aborted, c.aborted]).toEqual([true, true, true]);
  });

  it('aborts on ANY terminal status, not only `cancelled`', () => {
    // A `completed` or `failed` run should have nothing in flight; aborting is a
    // no-op in the normal case and stops a leak in the abnormal one (a
    // `subscribeResource` window can outlive its run by minutes).
    const signal = armRunAbort('run-3');
    notifyRunTerminal('run-3', 'failed');
    expect(signal.aborted).toBe(true);
  });

  it('a deadline already in the past aborts immediately, not on the next tick', () => {
    const signal = armRunAbort('run-4', Date.now() - 1_000);
    expect(signal.aborted).toBe(true);
  });

  it('a future deadline aborts when it passes', () => {
    const signal = armRunAbort('run-5', Date.now() + 40);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(39);
    expect(signal.aborted, '1 ms before the deadline').toBe(false);
    vi.advanceTimersByTime(2);
    expect(signal.aborted).toBe(true);
  });

  it('`runAbortSignal` READS without arming — a stray read cannot create a controller nobody fires', () => {
    expect(runAbortSignal('never-armed')).toBeUndefined();
    armRunAbort('run-6');
    expect(runAbortSignal('run-6')).toBeDefined();
  });

  it('the controller is released when the run reaches terminal', () => {
    armRunAbort('run-7');
    notifyRunTerminal('run-7', 'completed');
    expect(runAbortSignal('run-7'), 'a terminal run must not retain a controller').toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// END-TO-END: a REAL run, cancelled mid-node, with a REAL outbound MCP call
// ─────────────────────────────────────────────────────────────────────────────

const SERVER_ID = 'p3-e2e-mcp';
let storage: Storage;
let peer: Server;
let peerUrl: string;
let sawCancelNotification = false;
/** Fired by the peer when a `tools/call` arrives — the in-flight window. */
let onToolCall: (() => void) | undefined;

beforeAll(async () => {
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  peer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: unknown; method?: string };
      if (rpc.method === 'notifications/cancelled') {
        sawCancelNotification = true;
        res.writeHead(202).end();
        return;
      }
      if (rpc.method === 'tools/call' && onToolCall) {
        const fire = onToolCall;
        onToolCall = undefined;
        fire();
      }
      // A tool that never answers within the run's lifetime — the in-flight
      // window a cancel has to be able to reach into.
      setTimeout(() => {
        if (res.writableEnded) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? null, result: { resultType: 'complete', content: [], isError: false } }));
      }, 10_000);
    });
  });
  await new Promise<void>((r) => peer.listen(0, '127.0.0.1', r));
  peerUrl = `http://127.0.0.1:${(peer.address() as AddressInfo).port}`;

  registerProvider({
    id: SERVER_ID,
    label: 'E2E MCP peer',
    kind: 'bearer',
    authFlow: 'none',
    scopes: { read: [] },
    refreshable: false,
    defaultScopes: [],
    consumerNodes: ['core.openwop.mcp'],
    reach: 'mcp',
    mcpServer: { url: peerUrl, transport: 'http' },
  });
});

afterAll(async () => {
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  await new Promise<void>((r) => peer.close(() => r()));
});

describe('ADR 0553 P3 — cancelling a REAL run cancels its in-flight MCP call', () => {
  beforeEach(async () => {
    _resetRunLifecycle();
    sawCancelNotification = false;
    onToolCall = undefined;
    storage = await openStorage('memory://');
    initHostExtPersistence(storage);
    initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'p3-surfaces-')) });
    setEventLogBackend(storage);
    setSuspendBackend(storage);
    setRuntimeCapabilities([]);
    configureSecretResolver({ storage, dataDir: mkdtempSync(join(tmpdir(), 'p3-e2e-')) });
    await __resetConnectionsStore();
    await createSecretConnection({ tenantId: 'e2e', provider: SERVER_ID, kind: 'bearer', secret: 'tok', scope: 'user', userId: 'u1' });
  });

  it('the node fails typed `mcp_cancelled` and the peer is told — end to end, no hand-built signal', async () => {
    let observedError: { code?: string } | undefined;
    const stall: NodeModule = {
      typeId: 'test.p3.mcp-stall',
      version: '1.0.0',
      async execute(ctx) {
        if (!ctx.mcp?.invokeTool) throw new Error('the executor wired no MCP surface');
        try {
          await ctx.mcp.invokeTool(SERVER_ID, 'stalls', {});
        } catch (err) {
          observedError = typeof err === 'object' && err !== null && 'code' in err ? { code: String(err.code) } : {};
          throw err;
        }
        // A REAL `NodeOutcome`. The first draft returned a bare `{}` and the
        // executor's outcome switch fell through to its suspended branch,
        // crashing on `out.interrupt.data` — which is how sabotages S18/S19
        // first went "red" for the wrong reason. A malformed fixture is a
        // fixture that can only be trusted on the happy path.
        return { status: 'success' as const, outputs: {} };
      },
    };
    getNodeRegistry().register(stall);

    const now = new Date().toISOString();
    const run: RunRecord = {
      runId: 'run-p3-e2e', workflowId: 'wf.p3', tenantId: 'e2e', status: 'pending',
      inputs: null, metadata: { actingUserId: 'u1' }, configurable: {}, createdAt: now, updatedAt: now,
    };
    await storage.insertRun(run);
    const definition: WorkflowDefinition = { workflowId: 'wf.p3', nodes: [{ nodeId: 'n1', typeId: 'test.p3.mcp-stall' }] };

    // Cancel through the REAL recipe (`POST /v1/runs/:id/cancel` calls this),
    // fired by the peer the moment the `tools/call` request ARRIVES — so the
    // cancel lands while the node is inside its outbound request, by construction.
    let cancelFired = false;
    onToolCall = () => {
      cancelFired = true;
      void storage.getRun(run.runId).then((r) => (r ? cancelRunAndCascade(storage, r, 'test') : undefined));
    };

    // The run's own terminal bookkeeping is NOT the gate here, and wrapping it
    // is what makes this test able to fail for the right reason. With the
    // wiring removed the node's tool call simply succeeds late, the run takes a
    // different path through `executeRunBody`, and (measured, sabotages S18/S19)
    // that path threw an unrelated `TypeError` — a RED that would have been
    // recorded as proof while proving nothing. What this leg is about is the
    // NODE's outcome, so that is what is asserted, and it is captured inside the
    // node where no later executor behaviour can mask it.
    const outcome = await executeRun(storage, run, definition).catch((err: unknown) => ({ status: 'threw', err }));
    expect(cancelFired, 'the tools/call reached the peer, so the cancel landed in flight').toBe(true);

    // The node did NOT hang out to the 15 s MCP request timeout, and the failure
    // is attributed to the cancellation rather than misreported as a slow peer.
    expect(observedError?.code, 'the in-flight call must observe the run cancellation').toBe('mcp_cancelled');
    expect(sawCancelNotification, 'the peer must be told its request is abandoned').toBe(true);
    expect(outcome.status, 'a node that failed cancelled must not complete the run').not.toBe('completed');
  }, 20_000);

  it('a run cancelled mid-flight STAYS cancelled when its last node then finishes', async () => {
    // ADR 0553 P3 / ADR 0554 P2 — the defect the W6 witness above depends on.
    //
    // `finalizeRun` wrote `status: 'completed'` unconditionally from the
    // in-memory record captured at run START, so a cancel that landed on the ROW
    // mid-drain was accepted, audited, cascaded to children — and then silently
    // undone the instant the last node returned. Every earlier assertion about
    // cancellation is only as durable as this one: a `cancelled` run that
    // reports `completed` a second later has not been cancelled.
    //
    // No MCP here on purpose. The node succeeds normally; the ONLY thing under
    // test is whether the terminal write respects a status the row already
    // holds.
    getNodeRegistry().register({
      typeId: 'test.p3.cancel-then-finish',
      version: '1.0.0',
      async execute() {
        // Cancel the row from UNDER the executor, exactly as the HTTP route
        // does, while this node is still the run's live work.
        const row = await storage.getRun('run-p3-flip');
        if (row) await cancelRunAndCascade(storage, row, 'test');
        return { status: 'success' as const, outputs: {} };
      },
    });

    const now = new Date().toISOString();
    const run: RunRecord = {
      runId: 'run-p3-flip', workflowId: 'wf.p3.flip', tenantId: 'e2e', status: 'pending',
      inputs: null, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
    };
    await storage.insertRun(run);

    const result = await executeRun(storage, run, {
      workflowId: 'wf.p3.flip',
      nodes: [{ nodeId: 'n1', typeId: 'test.p3.cancel-then-finish' }],
    });

    // BOTH halves. The returned disposition and the DURABLE ROW have to agree —
    // asserting only the return value would pass while the row said
    // `completed`, and the row is what every later reader sees.
    expect(result.status, 'the executor must report the status the run actually reached').toBe('cancelled');
    const stored = await storage.getRun('run-p3-flip');
    expect(stored?.status, 'the durable row must not be flipped back to completed').toBe('cancelled');

    // And the EVENT STREAM must not claim completion either — the guard sits
    // above the `run.completed` append precisely so a cancelled run's log does
    // not carry a completion it never had.
    const types = (await storage.listEvents('run-p3-flip')).map((e) => e.type);
    expect(types, 'a cancelled run must not emit run.completed').not.toContain('run.completed');
    expect(types).toContain('run.cancelled');
  }, 20_000);

  it('the finalize re-read alone keeps a terminal row: a status written UNDER the executor without closing the log is not overwritten', async () => {
    // The case above has two guards (header): the RFC 0194 closed log stops it
    // before finalize is reached. Here another writer flips the ROW only (no
    // `run.cancelled` append, so the log stays open), which leaves the finalize
    // re-read as the one thing between this run and a `completed` overwrite.
    getNodeRegistry().register({
      typeId: 'test.p3.row-flip-then-finish',
      version: '1.0.0',
      async execute() {
        await storage.updateRun('run-p3-rowonly', { status: 'cancelled' });
        return { status: 'success' as const, outputs: {} };
      },
    });
    const now = new Date().toISOString();
    const run: RunRecord = {
      runId: 'run-p3-rowonly', workflowId: 'wf.p3.rowonly', tenantId: 'e2e', status: 'pending',
      inputs: null, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
    };
    await storage.insertRun(run);

    const result = await executeRun(storage, run, {
      workflowId: 'wf.p3.rowonly',
      nodes: [{ nodeId: 'n1', typeId: 'test.p3.row-flip-then-finish' }],
    });

    const types = (await storage.listEvents('run-p3-rowonly')).map((e) => e.type);
    // Non-vacuity: the log really was left open (the node's completion landed).
    expect(types).toContain('node.completed');
    expect(types).not.toContain('run.cancelled');
    expect(result.status).toBe('cancelled');
    expect((await storage.getRun('run-p3-rowonly'))?.status).toBe('cancelled');
    expect(types, 'finalize must not append a completion for a run whose row is terminal').not.toContain('run.completed');
  }, 20_000);
});
