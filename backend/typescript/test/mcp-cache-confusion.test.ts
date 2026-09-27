/**
 * ADR 0553 P3 — cache confusion.
 *
 * The ADR names four key components: "server, version, authenticated principal
 * scope and advertised revision". P2 shipped the first three and
 * `mcp-client-current.test.ts` already witnesses them (two principals ⇒ two
 * entries; a scope change ⇒ a miss). This file is about the FOURTH, and about
 * the property it exists to make structural rather than probable:
 *
 *   > a stale entry served after the peer's revision changed → IMPOSSIBLE
 *
 * "Impossible" is a strong word and it is the right one, because the peer's
 * advertised revision is part of the KEY rather than a validator consulted
 * after a hit. A peer that changes its `server/discover` answer changes the key,
 * so the old entry is not stale — it is unreachable. There is nothing to
 * "check and evict", which is what makes this different from a TTL.
 *
 * WHY THE PROTOCOL REVISION WAS NOT ENOUGH. `revision` is the revision the CALL
 * was made under. It does not move when a peer adds a tool, drops a capability,
 * changes its instructions, or is redeployed as a different server at the same
 * origin — all of which change what a run may see. Within `ttlMs`, every one of
 * those was served from the warm entry.
 *
 * AND THE HONEST LIMIT, asserted rather than glossed: a peer that does not
 * implement `server/discover` advertises no revision, so there is nothing to key
 * on — and those results are therefore NOT CACHED AT ALL. Caching them under a
 * placeholder would keep the shape of the guarantee and lose its substance.
 *
 * @see spec/v1/mcp-integration.md §D; RFC 0153 UQ5 / gap G4
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeMcpClient, _resetMcpNegotiation } from '../src/host/mcpClient.js';
import { _mcpClientCacheSize, _resetMcpClientCache } from '../src/host/mcpClientCache.js';
import { MCP_CURRENT_VERSION, MCP_LEGACY_VERSION } from '../src/host/mcpProfile.js';
import type { Storage } from '../src/storage/storage.js';

/** A peer whose self-description is MUTABLE — the whole subject of this file. */
class MutablePeer {
  readonly calls: string[] = [];
  private server: Server | null = null;
  private port = 0;
  /** What `server/discover` reports. Bump any of these to "change the peer". */
  instructions = 'v1';
  supportedVersions: readonly string[] = [MCP_CURRENT_VERSION];
  /** When false, `server/discover` is method-not-found — a peer that does not
   *  self-describe. */
  implementsDiscover = true;
  /** Distinguishes one peer's tool list from another's. */
  toolName = 'echo';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: unknown; method?: string };
        this.calls.push(String(rpc.method));
        if (rpc.method === 'server/discover' && !this.implementsDiscover) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32601, message: 'Method not found' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id ?? null,
          result: rpc.method === 'server/discover'
            ? { resultType: 'complete', supportedVersions: [...this.supportedVersions], capabilities: {}, instructions: this.instructions, ttlMs: 600_000, cacheScope: 'public' }
            : rpc.method === 'tools/list'
              // A LONG ttl on purpose: every miss below must be attributable to
              // the key, never to expiry. A test that let the TTL lapse would
              // pass with the key component removed entirely.
              ? { resultType: 'complete', tools: [{ name: this.toolName }], ttlMs: 600_000, cacheScope: 'private' }
              : { resultType: 'complete', content: [{ type: 'text', text: 'ok' }], isError: false },
        }));
      });
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => { this.port = (this.server!.address() as AddressInfo).port; resolve(); });
    });
  }

  endpoint(): string { return `http://127.0.0.1:${this.port}`; }
  listCalls(): number { return this.calls.filter((c) => c === 'tools/list').length; }
  reset(): void {
    this.calls.length = 0;
    this.instructions = 'v1';
    this.supportedVersions = [MCP_CURRENT_VERSION];
    this.implementsDiscover = true;
    this.toolName = 'echo';
  }
  async stop(): Promise<void> {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
}

const storage = {} as Storage;
let peer: MutablePeer;
const SERVER_ID = 'p3-cache-peer';

beforeAll(async () => {
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  peer = new MutablePeer();
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

const client = (overrides: Partial<Parameters<typeof makeMcpClient>[0]> = {}): ReturnType<typeof makeMcpClient> =>
  makeMcpClient({ storage, tenantId: 'acme', directEndpoint: { url: peer.endpoint() }, ...overrides });

describe('RFC 0153 §D — the outbound cache cannot be confused', () => {
  it('the fixture caches at all (non-vacuity — every miss below must mean something)', async () => {
    const c = client({ actingUserId: 'ada' });
    expect((await c.listTools(SERVER_ID)).tools).toEqual([{ name: 'echo' }]);
    await c.listTools(SERVER_ID);
    expect(peer.listCalls(), 'the second read is a HIT').toBe(1);
    expect(_mcpClientCacheSize()).toBeGreaterThan(0);
  });

  it('SAME server, TWO principals ⇒ two entries and NO cross-read', async () => {
    // The cross-read is what makes this a security property rather than an
    // efficiency one: `grace` must never be shown the list gathered for `ada`.
    // The tool name is switched between the two reads, so a cross-read would be
    // VISIBLE in the returned value and not merely in a call count.
    const ada = await client({ actingUserId: 'ada' }).listTools(SERVER_ID);
    peer.toolName = 'graces-tool';
    const grace = await client({ actingUserId: 'grace' }).listTools(SERVER_ID);
    expect(ada.tools).toEqual([{ name: 'echo' }]);
    expect(grace.tools, "grace MUST NOT be served ada's list").toEqual([{ name: 'graces-tool' }]);
    expect(peer.listCalls()).toBe(2);
  });

  it("a REVISION BUMP in the peer's self-description is a MISS, inside the TTL", async () => {
    // The fourth key component, doing the only job it exists for. `ttlMs` is
    // ten minutes and nothing here waits — so a hit would be a stale serve, and
    // a miss can only come from the key.
    const c = client({ actingUserId: 'ada' });
    expect((await c.listTools(SERVER_ID)).tools).toEqual([{ name: 'echo' }]);
    peer.instructions = 'v2'; // the peer redeployed
    peer.toolName = 'after-bump';
    expect((await c.listTools(SERVER_ID)).tools, 'a changed peer MUST NOT be served the old list').toEqual([{ name: 'after-bump' }]);
    expect(peer.listCalls()).toBe(2);
  });

  it("a change in the peer's SUPPORTED VERSIONS is a miss too", async () => {
    const c = client({ actingUserId: 'ada' });
    await c.listTools(SERVER_ID);
    peer.supportedVersions = [MCP_CURRENT_VERSION, MCP_LEGACY_VERSION];
    peer.toolName = 'after-version-change';
    expect((await c.listTools(SERVER_ID)).tools).toEqual([{ name: 'after-version-change' }]);
    expect(peer.listCalls()).toBe(2);
  });

  it('the STALE SERVE is impossible, not merely unlikely — proven against a peer that changes between reads', async () => {
    // The composite statement of the property. Three reads, one principal, one
    // TTL window: read → peer changes → read → peer changes back → read. Every
    // read reflects the peer AS IT IS, and the third read is a HIT on the first
    // read's entry because the peer's description is byte-identical again —
    // which is the correct behaviour and also proves the key is a function of
    // the description rather than a monotonic counter.
    const c = client({ actingUserId: 'ada' });
    expect((await c.listTools(SERVER_ID)).tools).toEqual([{ name: 'echo' }]);
    peer.instructions = 'v2';
    peer.toolName = 'mid';
    expect((await c.listTools(SERVER_ID)).tools).toEqual([{ name: 'mid' }]);
    peer.instructions = 'v1';
    peer.toolName = 'echo';
    expect((await c.listTools(SERVER_ID)).tools).toEqual([{ name: 'echo' }]);
    expect(peer.listCalls(), 'the third read returns to the first description and hits its entry').toBe(2);
  });

  it('a DIFFERENT TENANT with the same user id is a different entry', async () => {
    await client({ tenantId: 'acme', actingUserId: 'ada' }).listTools(SERVER_ID);
    peer.toolName = 'globex-tool';
    const globex = await client({ tenantId: 'globex', actingUserId: 'ada' }).listTools(SERVER_ID);
    expect(globex.tools).toEqual([{ name: 'globex-tool' }]);
    expect(peer.listCalls()).toBe(2);
  });

  it('a peer that does NOT self-describe is not cached at all — the honest limit', async () => {
    // No `server/discover` ⇒ no advertised revision ⇒ no way to notice a
    // change ⇒ no caching. Every read is a wire read. The alternative — cache
    // under a placeholder key — would look identical in a call-count test for a
    // static peer and be silently wrong for a changing one.
    peer.implementsDiscover = false;
    const c = client({ actingUserId: 'ada' });
    await c.listTools(SERVER_ID);
    await c.listTools(SERVER_ID);
    expect(peer.listCalls(), 'an unvalidatable peer is read every time').toBe(2);
    expect(_mcpClientCacheSize(), 'and leaves nothing behind to serve stale').toBe(0);
  });

  it('an unvalidatable peer still WORKS — refusing it outright would break every peer without server/discover', async () => {
    // The discriminating half. The first cut of this change refused such a peer
    // and reddened three pre-existing legs; shipping it would have broken
    // `ctx.mcp.listTools` against every real server that has not shipped
    // `server/discover` yet, for a guarantee the operator never asked for.
    peer.implementsDiscover = false;
    expect((await client({ actingUserId: 'ada' }).listTools(SERVER_ID)).tools).toEqual([{ name: 'echo' }]);
  });
});
