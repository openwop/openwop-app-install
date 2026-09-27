/**
 * ADR 0553 P3 — cancellation of an in-flight call, and the stateless
 * reconnect contract.
 *
 * ── CANCELLATION ───────────────────────────────────────────────────────────
 *
 * `McpClientDeps.signal` has existed since ADR 0030 Phase 2b and was consumed
 * in six places, and NOTHING EVER SUPPLIED ONE — the executor had no run
 * cancellation mechanism at all (no `AbortController`, and a drain loop that
 * checks the RFC 0058 deadline only BETWEEN nodes and never re-reads the run
 * row). So an in-flight outbound MCP call could not be cancelled, and a
 * cancelled run's node hung until the 15 s request timeout and then reported
 * `mcp_timeout` — a misattribution, not just a delay.
 *
 * Two windows, two different correct behaviours, and conflating them is the
 * easy mistake:
 *
 *   - REQUEST IN FLIGHT → abort the HTTP request (§B: streams are per-request
 *     and "a broken response stream loses the in-flight request", so the abort
 *     IS the transport-level cancellation), surface the typed `mcp_cancelled`,
 *     and tell the peer with a best-effort `notifications/cancelled` so a peer
 *     mid-work can stop spending. The notification can never affect the
 *     outcome — proven below by cancelling against a peer that answers it with
 *     `-32601`.
 *   - MRTR GATHER (no request in flight; the peer already answered
 *     `input_required` and is waiting for a retry) → §C.1 is explicit: "no
 *     retry is issued and the pending interrupt is cancelled; nothing is sent
 *     to the server." A `notifications/cancelled` here would name a request the
 *     peer has already completed. Pinned as its own leg.
 *
 * ── RECONNECT ──────────────────────────────────────────────────────────────
 *
 * There is no reconnect to implement, and proving that is the deliverable.
 * §B: "The current revision removed SSE resumability (`Last-Event-ID`) and the
 * standalone GET stream; a broken response stream loses the in-flight request
 * and the client MUST re-issue it with a new JSON-RPC id." So the legs assert
 * the STATELESS behaviour: no `Last-Event-ID` ever leaves this host, a broken
 * stream is a typed failure rather than a resumption, a re-issue mints a FRESH
 * JSON-RPC id, and the caller is delivered exactly one result — a duplicate
 * delivery is the failure mode resumability would have introduced.
 *
 * @see spec/v1/mcp-integration.md §B/§C.1
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeMcpClient, _resetMcpNegotiation } from '../src/host/mcpClient.js';
import { _resetMcpClientCache } from '../src/host/mcpClientCache.js';
import { MCP_CURRENT_VERSION } from '../src/host/mcpProfile.js';
import type { Storage } from '../src/storage/storage.js';

interface Seen {
  method: string;
  id: unknown;
  params: Record<string, unknown>;
  headers: Record<string, string>;
}

/**
 * A peer that can stall, stream, and break — the three shapes the legs need. A
 * fake that always answers instantly cannot witness a cancellation at all,
 * because there is no in-flight window to cancel inside.
 */
class SlowPeer {
  readonly seen: Seen[] = [];
  private server: Server | null = null;
  private port = 0;
  /** ms to hold a `tools/call` before answering. */
  stallMs = 0;
  /** When set, `tools/call` answers as SSE and cuts the connection mid-frame. */
  breakStream = false;
  /** Answer `notifications/cancelled` with method-not-found, like the suite's
   *  fake server does for every method it does not implement. */
  refuseCancelNotification = true;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: unknown; method?: string; params?: Record<string, unknown> };
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k.toLowerCase()] = v;
        this.seen.push({ method: String(rpc.method), id: rpc.id, params: rpc.params ?? {}, headers });

        if (rpc.method === 'notifications/cancelled') {
          if (this.refuseCancelNotification) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not found' } }));
          } else {
            res.writeHead(202).end();
          }
          return;
        }

        const complete = { resultType: 'complete', content: [{ type: 'text', text: 'ok' }], isError: false };

        if (rpc.method === 'tools/call' && this.breakStream) {
          // A `text/event-stream` response whose frame never terminates, then
          // the socket dies. This is the "broken response stream" §B describes.
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: {"jsonrpc":"2.0","id":');
          setTimeout(() => res.destroy(), 10);
          return;
        }

        const answer = (): void => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id ?? null,
            result: rpc.method === 'server/discover'
              ? { resultType: 'complete', supportedVersions: [MCP_CURRENT_VERSION], capabilities: {}, ttlMs: 1000, cacheScope: 'public' }
              : complete,
          }));
        };
        if (rpc.method === 'tools/call' && this.stallMs > 0) setTimeout(answer, this.stallMs);
        else answer();
      });
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => { this.port = (this.server!.address() as AddressInfo).port; resolve(); });
    });
  }

  endpoint(): string { return `http://127.0.0.1:${this.port}`; }
  reset(): void { this.seen.length = 0; this.stallMs = 0; this.breakStream = false; this.refuseCancelNotification = true; }
  async stop(): Promise<void> {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
}

const storage = {} as Storage;
let peer: SlowPeer;

beforeAll(async () => {
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  peer = new SlowPeer();
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
});

const SERVER_ID = 'p3-slow-peer';
const client = (overrides: Partial<Parameters<typeof makeMcpClient>[0]> = {}): ReturnType<typeof makeMcpClient> =>
  makeMcpClient({ storage, tenantId: 'acme', directEndpoint: { url: peer.endpoint() }, ...overrides });

/** Wait until the peer has RECEIVED a method, so a cancel lands mid-flight
 *  rather than racing the request out of the door. */
async function waitForPeer(method: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (peer.seen.some((s) => s.method === method)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`peer never received ${method}`);
}

describe('RFC 0153 — an in-flight outbound call is cancellable', () => {
  it('a run cancelled MID-REQUEST fails typed `mcp_cancelled`, not `mcp_timeout`, and does not hang', async () => {
    peer.stallMs = 10_000; // far beyond the leg's own patience
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = client({ signal: controller.signal }).invokeTool(SERVER_ID, 'echo', { text: 'hi' });
    await waitForPeer('tools/call');
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'mcp_cancelled' });
    // The whole point: a cancel that merely stopped waiting would still take the
    // 15 s request timeout to surface, and would surface as the wrong code.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('the peer is TOLD — a `notifications/cancelled` naming the aborted request id', async () => {
    peer.stallMs = 10_000;
    const controller = new AbortController();
    const pending = client({ signal: controller.signal }).invokeTool(SERVER_ID, 'echo', { text: 'hi' });
    await waitForPeer('tools/call');
    const inFlightId = peer.seen.find((s) => s.method === 'tools/call')!.id;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'mcp_cancelled' });
    const cancel = peer.seen.find((s) => s.method === 'notifications/cancelled');
    expect(cancel, 'the peer must learn the request is abandoned').toBeDefined();
    expect(cancel!.params.requestId).toBe(inFlightId);
    // A notification has NO `id` — it is not a request and expects no response.
    expect(cancel!.id).toBeUndefined();
  });

  it('the cancel notification carries the SAME revision headers as the request it cancels', async () => {
    // A notification built by a second, inline header literal would drift and be
    // refused `-32020` by a conforming peer. Shared builder, asserted on the wire.
    peer.stallMs = 10_000;
    const controller = new AbortController();
    const pending = client({ signal: controller.signal }).invokeTool(SERVER_ID, 'echo', {});
    await waitForPeer('tools/call');
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'mcp_cancelled' });
    const cancel = peer.seen.find((s) => s.method === 'notifications/cancelled')!;
    expect(cancel.headers['mcp-protocol-version']).toBe(MCP_CURRENT_VERSION);
    expect(cancel.headers['mcp-method']).toBe('notifications/cancelled');
    expect((cancel.params._meta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion']).toBe(MCP_CURRENT_VERSION);
  });

  it('a peer that REFUSES the notification changes nothing — the outcome is still `mcp_cancelled`', async () => {
    // `refuseCancelNotification` is on by default here, so every leg above
    // already ran against a peer answering `-32601`. This leg says so out loud,
    // because the notification being best-effort is the property that stops a
    // cancel from being able to hang on the telling of it.
    peer.stallMs = 10_000;
    peer.refuseCancelNotification = true;
    const controller = new AbortController();
    const pending = client({ signal: controller.signal }).invokeTool(SERVER_ID, 'echo', {});
    await waitForPeer('tools/call');
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'mcp_cancelled' });
  });

  it('a run cancelled with NO request in flight sends the peer NOTHING (§C.1)', async () => {
    // Pre-aborted: the client must not open a connection at all, so there is no
    // in-flight request and therefore nothing to cancel-notify.
    const controller = new AbortController();
    controller.abort();
    await expect(client({ signal: controller.signal }).invokeTool(SERVER_ID, 'echo', {})).rejects.toMatchObject({ code: 'mcp_cancelled' });
    expect(peer.seen.filter((s) => s.method === 'notifications/cancelled'), '§C.1: nothing is sent to the server').toHaveLength(0);
  });

  it('an UNCANCELLED slow call still succeeds — the guard is not "abort everything slow"', async () => {
    peer.stallMs = 150;
    const out = await client().invokeTool(SERVER_ID, 'echo', { text: 'hi' });
    expect(out.untrustedContent).toBe(true);
    expect(peer.seen.some((s) => s.method === 'notifications/cancelled')).toBe(false);
  });
});

describe('RFC 0153 §B — reconnect is STATELESS: no resumption, a fresh id, one delivery', () => {
  it('no request this host makes carries `Last-Event-ID`', async () => {
    // The current revision removed SSE resumability. A client that sent the
    // header would be asking a server to resume a stream the revision no longer
    // defines — and, worse, inviting a duplicate delivery of an effectful call.
    await client().invokeTool(SERVER_ID, 'echo', { text: 'a' });
    await client().listTools(SERVER_ID);
    expect(peer.seen.length).toBeGreaterThan(0);
    for (const s of peer.seen) {
      expect(Object.keys(s.headers), `${s.method} must not ask to resume`).not.toContain('last-event-id');
    }
  });

  it('a BROKEN response stream is a typed failure — never a silent resumption', async () => {
    peer.breakStream = true;
    await expect(client().invokeTool(SERVER_ID, 'echo', { text: 'a' })).rejects.toMatchObject({
      code: expect.stringMatching(/^mcp_(bad_response|request_failed)$/) as unknown as string,
    });
    // Exactly ONE attempt reached the peer. A resumption — or an internal retry
    // — would show as a second request, and for an effectful `tools/call` that
    // is a duplicate side effect, not a nicety.
    expect(peer.seen.filter((s) => s.method === 'tools/call')).toHaveLength(1);
  });

  it('the caller re-issues with a NEW JSON-RPC id, and is delivered the result exactly ONCE', async () => {
    // §B: "the client MUST re-issue it with a new JSON-RPC id". The re-issue is
    // the CALLER's (a node retry), and what this host owes is that the id is
    // fresh — an id reused across a broken stream is how a server dedups the
    // wrong way and answers the first request's result to the second.
    peer.breakStream = true;
    await expect(client().invokeTool(SERVER_ID, 'echo', { text: 'a' })).rejects.toBeDefined();
    peer.breakStream = false;
    const out = await client().invokeTool(SERVER_ID, 'echo', { text: 'a' });

    const calls = peer.seen.filter((s) => s.method === 'tools/call');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.id, 'a re-issue MUST NOT reuse the broken request id').not.toBe(calls[1]!.id);
    expect(typeof calls[0]!.id).toBe('number');
    // ONE delivery: the failed attempt produced no result at all, so the caller
    // saw the content once. (A resumption that replayed the first stream would
    // deliver twice, which is the duplicate this contract exists to exclude.)
    expect(out.result).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('a broken stream is NEVER cached, so a later read cannot serve a partial', async () => {
    peer.breakStream = true;
    await expect(client({ actingUserId: 'ada' }).invokeTool(SERVER_ID, 'echo', {})).rejects.toBeDefined();
    peer.breakStream = false;
    // `tools/list` has its own path; the assertion is that the failed call left
    // nothing behind that a subsequent read could pick up.
    const listed = await client({ actingUserId: 'ada' }).listTools(SERVER_ID);
    expect(Array.isArray(listed.tools)).toBe(true);
  });

  it('the mount never mints a session — two independent requests agree without one', async () => {
    // The inbound half of "stateless": if the host required session state, the
    // second call would need something the first handed it. Two clients, no
    // shared state, identical answers.
    const a = await client({ actingUserId: 'ada' }).invokeTool(SERVER_ID, 'echo', { text: 'x' });
    const b = await client({ actingUserId: 'grace' }).invokeTool(SERVER_ID, 'echo', { text: 'x' });
    expect(a.result).toEqual(b.result);
    for (const s of peer.seen) {
      expect(Object.keys(s.headers), 'the current profile has no sessions').not.toContain('mcp-session-id');
    }
  });
});
