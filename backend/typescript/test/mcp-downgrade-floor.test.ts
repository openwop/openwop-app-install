/**
 * ADR 0553 P3 — no silent downgrade, in BOTH directions.
 *
 * P2 shipped "explicit downgrade": a peer's `-32022` is the only thing that
 * lowers a revision, and the lowered revision is then carried on every later
 * call. That satisfies `mcp-version-no-silent-downgrade` as a wire invariant.
 * P3 is about the two places the invariant was still reachable around:
 *
 *   INBOUND — a request with NO `MCP-Protocol-Version` header was dispatched
 *   into the legacy codec by a hard-coded branch, regardless of whether this
 *   host serves the legacy revision. §B: "a host whose `protocolVersions` does
 *   not include a pre-header revision MUST reject it." Today the branch is
 *   correct BY COINCIDENCE (this host does serve legacy), which is why
 *   `selectMcpCodec` now takes the served set as a parameter — a claim that can
 *   only ever be evaluated against one value is a guard that cannot fail.
 *
 *   OUTBOUND — a provider manifest can now PIN a profile (`mcpServer.profile`),
 *   and a pin is a FLOOR. A peer that answers `-32022` naming only the legacy
 *   revision is refused rather than talked down to. The distinction P2 could not
 *   draw is between EXPLICIT and SANCTIONED: an operator who pinned the current
 *   profile declared this peer speaks MRTR and stateless routing, and a peer
 *   that no longer does is not the peer they configured — however honestly the
 *   host arrives at that conclusion.
 *
 * The second outbound door is the one that is easy to miss: `serverStatus`
 * falls back to a legacy `initialize` handshake when `server/discover` does not
 * answer, and that fallback never consults the negotiation path at all. Pinning
 * `negotiatedCall` alone would have left it wide open.
 *
 * @see spec/v1/mcp-integration.md §B; docs/adr/0553-mcp-2026-secure-versioned-adapter.md
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeMcpClient, McpError, _resetMcpNegotiation } from '../src/host/mcpClient.js';
import { _resetMcpClientCache } from '../src/host/mcpClientCache.js';
import {
  MCP_CURRENT_PROFILE,
  MCP_CURRENT_VERSION,
  MCP_ERR_UNSUPPORTED_VERSION,
  MCP_LEGACY_PROFILE,
  MCP_LEGACY_VERSION,
  selectMcpCodec,
  versionForMcpProfile,
} from '../src/host/mcpProfile.js';
import { getProvider, registerProvider } from '../src/features/connections/providerRegistry.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { __resetGovernanceStore } from '../src/host/governanceService.js';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';

// ─────────────────────────────────────────────────────────────────────────────
// INBOUND
// ─────────────────────────────────────────────────────────────────────────────

describe('RFC 0153 §B inbound — the header-less request is answered from the SERVED set', () => {
  it('a host that serves legacy answers a header-less request under legacy (unchanged)', () => {
    expect(selectMcpCodec(undefined, [MCP_CURRENT_VERSION, MCP_LEGACY_VERSION])).toEqual({
      kind: 'legacy',
      version: MCP_LEGACY_VERSION,
      headerPresent: false,
    });
  });

  it('a CURRENT-ONLY host REFUSES a header-less request instead of serving it legacy', () => {
    // This is the leg the pre-P3 code could not fail: the branch returned
    // `legacy` unconditionally, so on a host that had completed the legacy
    // sunset a header-less peer would still have been dispatched into a codec
    // the host no longer claims to serve. `requested: ''` is the honest value —
    // the peer named no revision at all.
    expect(selectMcpCodec(undefined, [MCP_CURRENT_VERSION])).toEqual({ kind: 'unsupported', requested: '' });
    expect(selectMcpCodec('', [MCP_CURRENT_VERSION])).toEqual({ kind: 'unsupported', requested: '' });
  });

  it('an EXPLICIT legacy header against a current-only host is refused, not downgraded into', () => {
    expect(selectMcpCodec(MCP_LEGACY_VERSION, [MCP_CURRENT_VERSION])).toEqual({
      kind: 'unsupported',
      requested: MCP_LEGACY_VERSION,
    });
  });

  it('an explicit CURRENT header against a legacy-only host is refused — the rule is symmetric', () => {
    // Worth its own leg: a guard that only ever refuses downward would pass
    // while treating "newer" as automatically acceptable, which is the same
    // unserved-revision hazard pointing the other way.
    expect(selectMcpCodec(MCP_CURRENT_VERSION, [MCP_LEGACY_VERSION])).toEqual({
      kind: 'unsupported',
      requested: MCP_CURRENT_VERSION,
    });
  });

  it('two conflicting headers are not a stated revision', () => {
    expect(selectMcpCodec([MCP_CURRENT_VERSION, MCP_LEGACY_VERSION])).toMatchObject({ kind: 'unsupported' });
  });

  it('the profile→version map agrees with the version constants', () => {
    // DERIVED, not restated: a test that hard-coded the dates would agree with a
    // drifted map for as long as the drift existed.
    expect(versionForMcpProfile(MCP_CURRENT_PROFILE)).toBe(MCP_CURRENT_VERSION);
    expect(versionForMcpProfile(MCP_LEGACY_PROFILE)).toBe(MCP_LEGACY_VERSION);
    expect(versionForMcpProfile('mcp-2025-11-25')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OUTBOUND
// ─────────────────────────────────────────────────────────────────────────────

interface Recorded { method: string; revision: string | undefined }

/** A peer that supports ONLY the revisions it is constructed with. */
class RevisionPeer {
  readonly calls: Recorded[] = [];
  private server: Server | null = null;
  private port = 0;
  constructor(private revisions: readonly string[]) {}

  setRevisions(next: readonly string[]): void { this.revisions = next; }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: unknown; method?: string };
        const revision = req.headers['mcp-protocol-version'];
        this.calls.push({ method: String(rpc.method), revision: typeof revision === 'string' ? revision : undefined });
        const send = (status: number, payload: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (typeof revision === 'string' && !this.revisions.includes(revision)) {
          send(400, { jsonrpc: '2.0', id: rpc.id ?? null, error: { code: MCP_ERR_UNSUPPORTED_VERSION, message: 'unsupported', data: { supported: [...this.revisions], requested: revision } } });
          return;
        }
        // A REAL legacy-only peer does not implement `server/discover` at all —
        // `server/discover` is a 2026-07-28 method. Answering it regardless of
        // the revision would make this fixture a peer that cannot exist, and
        // (measured) it hid the `serverStatus` legacy-fallback leg entirely: the
        // probe succeeded on discovery and never reached `initialize`.
        if (rpc.method === 'server/discover' && !this.revisions.includes(MCP_CURRENT_VERSION)) {
          send(404, { jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32601, message: 'Method not found' } });
          return;
        }
        const result = rpc.method === 'server/discover'
          ? { resultType: 'complete', supportedVersions: [...this.revisions], capabilities: {}, ttlMs: 1000, cacheScope: 'public' }
          : rpc.method === 'tools/list'
            ? { resultType: 'complete', tools: [{ name: 'echo' }], ttlMs: 60_000, cacheScope: 'private' }
            : rpc.method === 'initialize'
              ? { protocolVersion: MCP_LEGACY_VERSION, serverInfo: { name: 'legacy-peer', version: '1' } }
              : { resultType: 'complete', content: [{ type: 'text', text: 'ok' }], isError: false };
        send(200, { jsonrpc: '2.0', id: rpc.id ?? null, result });
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

let storage: Storage;
let peer: RevisionPeer;

const PINNED_ID = 'p3-pinned-mcp';
const UNPINNED_ID = 'p3-unpinned-mcp';
const TENANT = 'p3tenant';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  // A real boot: `resolveConnectionCredential` and the governance gate both
  // read host-ext persistence, so the pinned lane has to travel the production
  // resolution path rather than a `directEndpoint` bypass — the pin lives on the
  // MANIFEST, which the bypass never consults.
  const app = await createApp({ port: 18974, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  peer = new RevisionPeer([MCP_CURRENT_VERSION, MCP_LEGACY_VERSION]);
  await peer.start();
  await __resetConnectionsStore();
  await __resetGovernanceStore();
  // Two manifests at ONE origin — deliberately. The negotiated-revision map is
  // process-global and keyed by ORIGIN, so this is the shape that proves a pin
  // is not quietly overwritten by a downgrade agreed for its unpinned neighbour.
  registerProvider({
    id: PINNED_ID,
    label: 'Pinned MCP peer',
    kind: 'bearer',
    authFlow: 'none', scopes: { read: [] }, refreshable: false, defaultScopes: [], consumerNodes: ['core.openwop.mcp'],
    reach: 'mcp',
    mcpServer: { url: peer.endpoint(), transport: 'http', profile: MCP_CURRENT_PROFILE },
  });
  registerProvider({
    id: UNPINNED_ID,
    label: 'Unpinned MCP peer',
    kind: 'bearer',
    authFlow: 'none', scopes: { read: [] }, refreshable: false, defaultScopes: [], consumerNodes: ['core.openwop.mcp'],
    reach: 'mcp',
    mcpServer: { url: peer.endpoint(), transport: 'http' },
  });
  for (const provider of [PINNED_ID, UNPINNED_ID]) {
    await createSecretConnection({ tenantId: TENANT, provider, kind: 'bearer', secret: 'opaque-token', scope: 'user', userId: 'u1' });
  }
});

afterAll(async () => {
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  await peer.stop();
  await __resetGovernanceStore();
});

afterEach(() => {
  peer.reset();
  peer.setRevisions([MCP_CURRENT_VERSION, MCP_LEGACY_VERSION]);
  _resetMcpNegotiation();
  _resetMcpClientCache();
});

const client = (): ReturnType<typeof makeMcpClient> =>
  makeMcpClient({ storage, tenantId: TENANT, actingUserId: 'u1', orgId: TENANT });

describe('RFC 0153 §B outbound — a manifest pin is a downgrade FLOOR', () => {
  it('the manifest actually carries the pin (the fixture is not vacuous)', () => {
    expect(getProvider(PINNED_ID)?.mcpServer?.profile).toBe(MCP_CURRENT_PROFILE);
    expect(getProvider(UNPINNED_ID)?.mcpServer?.profile).toBeUndefined();
  });

  it('a PINNED server talking to a legacy-only peer FAILS CLOSED — never a legacy fallback', async () => {
    peer.setRevisions([MCP_LEGACY_VERSION]);
    const err = await client().invokeTool(PINNED_ID, 'echo', { text: 'hi' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe('interop_version_unsupported');
    expect((err as McpError).details).toMatchObject({
      protocol: 'mcp',
      requested: MCP_CURRENT_VERSION,
      supported: [MCP_LEGACY_VERSION],
    });
    // THE LOAD-BEARING WIRE ASSERTION: exactly one request left this host, under
    // the pinned revision. A re-issue under `2025-06-18` would be the downgrade,
    // and it would be invisible to an assertion that only read the thrown error.
    expect(peer.calls).toHaveLength(1);
    expect(peer.calls[0]!.revision).toBe(MCP_CURRENT_VERSION);
  });

  it('an UNPINNED server against the same peer still downgrades EXPLICITLY (P2 behaviour intact)', async () => {
    // The discriminating half. Without it the test above would pass on a client
    // that had simply stopped downgrading at all, which would break every
    // connector pointed at a legacy peer — a fix worse than the defect.
    peer.setRevisions([MCP_LEGACY_VERSION]);
    const out = await client().invokeTool(UNPINNED_ID, 'echo', { text: 'hi' });
    expect(out.negotiatedVersion).toBe(MCP_LEGACY_VERSION);
    expect(peer.calls.map((c) => c.revision)).toEqual([MCP_CURRENT_VERSION, MCP_LEGACY_VERSION]);
  });

  it("a neighbour's agreed downgrade does NOT become the pinned server's opening revision", async () => {
    // Both manifests point at one origin, and `negotiated` is keyed by origin.
    // The unpinned call agrees on legacy; the pinned call must still OPEN at the
    // current revision rather than inheriting it.
    peer.setRevisions([MCP_LEGACY_VERSION]);
    await client().invokeTool(UNPINNED_ID, 'echo', { text: 'hi' });
    peer.reset();
    await expect(client().invokeTool(PINNED_ID, 'echo', { text: 'hi' })).rejects.toMatchObject({ code: 'interop_version_unsupported' });
    expect(peer.calls.map((c) => c.revision)).toEqual([MCP_CURRENT_VERSION]);
  });

  it('a PINNED server whose peer answers server/discover normally works — the pin is not a blanket refusal', async () => {
    const out = await client().invokeTool(PINNED_ID, 'echo', { text: 'hi' });
    expect(out.negotiatedVersion).toBe(MCP_CURRENT_VERSION);
    expect(out.untrustedContent).toBe(true);
  });

  it('serverStatus does NOT reach the legacy `initialize` handshake for a PINNED server', async () => {
    // The second door. `callAtRevision` is `serverStatus`'s legacy fallback and
    // never goes through `negotiatedCall`, so the floor has to be enforced there
    // too. The peer here answers `server/discover` with a list that does not
    // include the current revision, which is exactly the state that triggers the
    // fallback.
    peer.setRevisions([MCP_LEGACY_VERSION]);
    const status = await client().serverStatus(PINNED_ID);
    expect(status.available).toBe(false);
    expect(peer.calls.some((c) => c.method === 'initialize'), 'a pinned current-profile server must never be probed with the legacy handshake').toBe(false);
  });

  it('serverStatus DOES fall back to `initialize` for an UNPINNED server', async () => {
    // Again the discriminating half: without it, the assertion above passes on a
    // client that lost the legacy probe entirely.
    peer.setRevisions([MCP_LEGACY_VERSION]);
    const status = await client().serverStatus(UNPINNED_ID);
    expect(status.available).toBe(true);
    expect(status.protocolVersion).toBe(MCP_LEGACY_VERSION);
    expect(peer.calls.some((c) => c.method === 'initialize')).toBe(true);
  });

  it("a PINNED server whose peer's self-description omits the pinned revision is refused before tools reach a run", async () => {
    // §B's "validates the peer's self-description before exposing tools to a
    // run". The peer here ACCEPTS the current-revision header (so negotiation
    // sees nothing wrong) but does not LIST it — the gap between "accepted our
    // header" and "says it speaks this".
    peer.setRevisions([MCP_CURRENT_VERSION]);
    const original = getProvider(PINNED_ID)!;
    registerProvider({ ...original, mcpServer: { ...original.mcpServer!, url: peer.endpoint() } });
    // Re-point the peer's ADVERTISED set without changing what it accepts.
    const lyingPeer = new RevisionPeer([MCP_LEGACY_VERSION]);
    await lyingPeer.start();
    registerProvider({ ...original, mcpServer: { url: lyingPeer.endpoint(), transport: 'http', profile: MCP_CURRENT_PROFILE } });
    try {
      // `tools/list` is where a peer's tools would reach a run.
      await expect(client().listTools(PINNED_ID)).rejects.toMatchObject({ code: 'interop_version_unsupported' });
    } finally {
      registerProvider(original);
      await lyingPeer.stop();
    }
  });

  it('an UNKNOWN profile name in a manifest is a hard failure, not an ignored field', async () => {
    // A typo'd or newer profile name must not silently leave the call running at
    // the preferred revision while the manifest says otherwise — that is a
    // silent downgrade authored in configuration rather than in code.
    const original = getProvider(UNPINNED_ID)!;
    registerProvider({ ...original, mcpServer: { url: peer.endpoint(), transport: 'http', profile: 'mcp-2099-01-01' } });
    try {
      await expect(client().invokeTool(UNPINNED_ID, 'echo', {})).rejects.toMatchObject({ code: 'server_not_found' });
      expect(peer.calls, 'nothing may leave the host on an unresolvable pin').toHaveLength(0);
    } finally {
      registerProvider(original);
    }
  });
});
