/**
 * ADR 0553 P3 / ADR 0531 — an MCP-SPECIFIC witness that a replay fires no
 * outbound tool call.
 *
 * WHY THIS FILE EXISTS. The replay side-effect guard is SHARED: `mcpClient.ts`
 * reaches it by passing `dispatcher: webhookEgressDispatcher()` to its two
 * `undiciFetch` call sites, and that getter is where `assertEffectAllowed`
 * fires. Because the mechanism is shared, ADR 0553's replay row was recorded as
 * covered — by tests that drive WEBHOOKS. No leg drove MCP.
 *
 * That is a coverage claim resting on a wiring detail, and the wiring is one
 * line in a call site nobody would think of as replay code. Delete
 * `dispatcher: webhookEgressDispatcher()` from `mcpClient.ts` and every webhook
 * replay test stays green while a replayed run silently re-invokes a remote
 * tool — the exact "green is indistinguishable from the assertion never ran"
 * shape this program keeps finding.
 *
 * So the assertion here is deliberately about MCP and about the SOCKET: the
 * peer records every request it receives, and the replay leg asserts it
 * received NOTHING. A test that only checked for a thrown error would pass
 * against a client that sent the request and then threw.
 *
 * @see spec/v1/replay.md §"Side-effect suppression in replay"
 * @see src/host/webhookEgressGuard.ts — names mcpClient.ts as a caller
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeMcpClient } from '../src/host/mcpClient.js';
import { _resetMcpNegotiation } from '../src/host/mcpClient.js';
import { _resetMcpClientCache } from '../src/host/mcpClientCache.js';
import { MCP_CURRENT_VERSION } from '../src/host/mcpProfile.js';
import {
  runWithEffectContext,
  effectCountForRun,
  ReplayEffectError,
  __resetEffectCountsForTest,
} from '../src/host/runEffectContext.js';
import type { Storage } from '../src/storage/storage.js';

/** Minimal peer: answers any tools/call, and REMEMBERS whether it was reached. */
class RecordingPeer {
  readonly calls: string[] = [];
  private server: Server | null = null;
  private port = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: unknown; method?: string };
        this.calls.push(String(rpc.method));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id ?? null,
          result: rpc.method === 'server/discover'
            ? { resultType: 'complete', supportedVersions: [MCP_CURRENT_VERSION], capabilities: {}, ttlMs: 1000, cacheScope: 'public' }
            : { resultType: 'complete', content: [{ type: 'text', text: 'ok' }], isError: false },
        }));
      });
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => { this.port = (this.server!.address() as AddressInfo).port; resolve(); });
    });
  }

  endpoint(): string { return `http://127.0.0.1:${this.port}`; }
  reset(): void { this.calls.length = 0; }
  async stop(): Promise<void> {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
}

const storage = {} as Storage;
let peer: RecordingPeer;

beforeAll(async () => {
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  peer = new RecordingPeer();
  await peer.start();
});

afterAll(async () => {
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  await peer.stop();
});

afterEach(() => {
  peer.reset();
  _resetMcpNegotiation();
  _resetMcpClientCache();
  __resetEffectCountsForTest();
});

const client = () => makeMcpClient({ storage, tenantId: 'acme', directEndpoint: { url: peer.endpoint() } });

describe('ADR 0531 / ADR 0553 — a replayed run performs no MCP tool call', () => {
  it('LIVE: the call reaches the peer and is tallied as an escaped effect', async () => {
    const runId = 'run-mcp-live';
    const out = await runWithEffectContext(
      { runId, replaying: false, observedEffectKinds: new Set() },
      () => client().invokeTool('seam-peer', 'echo', { text: 'hi' }),
    );

    expect(out.negotiatedVersion).toBe(MCP_CURRENT_VERSION);
    expect(peer.calls).toContain('tools/call');
    // The allow branch tallies the escape against the run whose node performed
    // it. This is the control: it proves the call really did traverse the
    // guarded dispatcher, so the replay leg below is measuring the same path
    // rather than an unrelated failure.
    expect(effectCountForRun(runId)).toBeGreaterThan(0);
  });

  it('REPLAY: the peer receives NOTHING, and the guard refuses the egress', async () => {
    const runId = 'run-mcp-replay';

    let caught: unknown;
    try {
      await runWithEffectContext(
        { runId, replaying: true, observedEffectKinds: new Set() },
        () => client().invokeTool('seam-peer', 'echo', { text: 'hi' }),
      );
    } catch (err) { caught = err; }

    // The TYPE, not just the message. This leg found a live defect: the client
    // caught the guard's throw in `transportError` and re-wrapped it as
    // `McpError{ code: 'mcp_request_failed' }`. The message survived, the type
    // did not — and `executor.ts` surfaces `err.code` from an allowlist that
    // contains BOTH `McpError` and `ReplayEffectError`, so the wrapper shadowed
    // the guard and the node-failure event blamed the peer for a request the
    // peer never received.
    expect(caught).toBeInstanceOf(ReplayEffectError);
    expect((caught as { code?: string }).code).toBe('replay_source_missing');

    // THE assertion. A client that sent the request and then threw would pass a
    // rejects-toThrow check and still have re-invoked a remote tool; only the
    // peer's own record can tell those apart.
    expect(peer.calls).toEqual([]);

    // And nothing escaped, so nothing is tallied — the counter and the socket
    // agree. If they ever disagree, the tally is the one to distrust: it is
    // derived, the socket is observed.
    expect(effectCountForRun(runId)).toBe(0);
  });
});
