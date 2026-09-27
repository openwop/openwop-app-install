/**
 * H57 (AP-07) — the outbound MCP cache keys on AUTHORIZATION, and the
 * invalidator is wired from the REAL seams (ADR 0553 correction; RFC 0153 §D
 * / G4).
 *
 * What the A+ audit MEASURED before this file existed:
 *   - `scopeFingerprint` was `sha256([tenant, org, user, serverId])` — the same
 *     four facts already in the key, restated. It carried NO authorization
 *     material: not the principal's roles/scopes, not which Connection the
 *     call rode, not whether that Connection had been rotated. So a cached
 *     `private` tools list built for a principal kept serving after their
 *     roles changed or their Connection was revoked/re-consented — for the
 *     whole `ttlMs`, which is exactly the substitution §D forbids ("the TTL is
 *     a freshness hint about the server's data, not about the caller's
 *     rights").
 *   - `invalidateMcpCacheForPrincipal` had ZERO production callers. The
 *     docblocks in `mcpClientCache.ts` and `mcpClient.ts` said it was "called
 *     on an authorization-scope change"; the only caller was a test that
 *     invoked it directly, which proves the function works and nothing about
 *     the seam.
 *
 * Every leg here goes through the REAL seam — `updateMember`, `deleteMember`,
 * `revokeConnection`, `upsertOAuthConnection` — never the invalidator, and the
 * peer is a real socket, so "hit the wire" is a recorded request, not a belief.
 *
 * TWO MECHANISMS, TWO KINDS OF LEG, and both are needed:
 *
 *   1. The KEY re-derives the principal's scopes and the Connection's
 *      provenance from the store on EVERY read. That is what protects a
 *      SECOND INSTANCE (Cloud Run runs several): a member row edited over
 *      there is a different key over here on the next read, with no signal
 *      exchanged. The "another instance wrote the row" legs below write the
 *      row raw — bypassing every service and therefore every invalidator —
 *      and assert the next read misses anyway.
 *   2. The INVALIDATOR drops the principal's entries EAGERLY on the same
 *      instance, so the stale entry is gone rather than merely unreachable.
 *      The seam legs assert `_mcpClientCacheSize()` goes to 0 — an assertion
 *      the key alone cannot satisfy, which is what makes "remove the
 *      `updateMember` call" a sabotage that goes RED.
 *
 * KNOWN BOUND, stated rather than implied: the eager invalidator is
 * process-local, exactly like the ADR 0553 P3 run-cancellation signal
 * (`executor/runLifecycle.ts`). That is a bound on the OPTIMISATION, not on the
 * security property — the two "another instance" legs below assert the
 * user-visible outcome (a changed authorization context is a MISS) with no
 * in-process signal at all, because the KEY carries it. A multi-process
 * harness that exercises two live instances is AP-18's.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { makeMcpClient } from '../src/host/mcpClient.js';
import { _mcpClientCacheSize, _resetMcpClientCache } from '../src/host/mcpClientCache.js';
import { MCP_CURRENT_VERSION, MCP_LEGACY_VERSION } from '../src/host/mcpProfile.js';
import { registerProvider } from '../src/features/connections/providerRegistry.js';
import {
  __resetConnectionsStore,
  createSecretConnection,
  getConnection,
  revokeConnection,
  upsertOAuthConnection,
  type Connection,
} from '../src/features/connections/connectionsService.js';
import { __resetGovernanceStore } from '../src/host/governanceService.js';
import {
  __resetAccessStores,
  createMember,
  deleteMember,
  updateMember,
  type OrgMember,
} from '../src/host/accessControlService.js';
import { setSecret } from '../src/byok/secretResolver.js';

// A flat-path tenant id (not `user:`/`ws:`): the vitest lane has no KMS, and
// the KMS envelope is orthogonal to what this file measures.
const T = 'h57-authz';
const PROVIDER = 'h57mcp';

interface Recorded { method: string; auth?: string }

/** A current-revision peer whose `tools/list` is `private` with a long TTL — the
 *  exact shape under which a stale authorization context would be served warm. */
class Peer {
  readonly calls: Recorded[] = [];
  private server: http.Server | null = null;
  url = '';
  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const rpc = JSON.parse(raw) as { id?: unknown; method?: string };
        this.calls.push({ method: String(rpc.method), ...(typeof req.headers.authorization === 'string' ? { auth: req.headers.authorization } : {}) });
        const result = rpc.method === 'server/discover'
          ? { resultType: 'complete', supportedVersions: [MCP_CURRENT_VERSION, MCP_LEGACY_VERSION], capabilities: {}, ttlMs: 1000, cacheScope: 'public' }
          : rpc.method === 'tools/list'
            ? { resultType: 'complete', tools: [{ name: 'echo' }], ttlMs: 60_000, cacheScope: 'private' }
            : { resultType: 'complete' };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? null, result }));
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}/mcp`;
  }
  lists(): Recorded[] { return this.calls.filter((c) => c.method === 'tools/list'); }
  reset(): void { this.calls.length = 0; }
  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((r) => this.server!.close(() => r()));
  }
}

let storage: Storage;
const peer = new Peer();

const client = (actingUserId: string) => makeMcpClient({ storage, tenantId: T, actingUserId, orgId: T });

/** Row keys the way `DurableCollection` writes them — used ONLY to simulate a
 *  write made by ANOTHER INSTANCE (no service, no invalidator). */
const memberRowKey = (memberId: string): string => `hostext:access-members:${memberId}`;
const connectionRowKey = (connectionId: string): string => `hostext:connections:connection:${connectionId}`;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  const app = await createApp({ port: 18997, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await peer.start();
  registerProvider({
    id: PROVIDER, label: 'H57 MCP', kind: 'bearer', authFlow: 'none', reach: 'mcp',
    scopes: { read: [] }, refreshable: false, defaultScopes: [], consumerNodes: ['core.openwop.mcp'],
    mcpServer: { url: peer.url, transport: 'http' },
  });
});

afterAll(async () => {
  await peer.stop();
  await __resetGovernanceStore();
});

afterEach(async () => {
  peer.reset();
  _resetMcpClientCache();
  await __resetConnectionsStore();
  await __resetAccessStores();
});

/** Grant: an editor member with a user-scoped bearer Connection. Returns both
 *  rows so a leg can revoke/rotate/re-role them through the real seams. */
async function grant(subject: string, roles: string[] = ['editor'], secret = `tok-${subject}`): Promise<{ member: OrgMember; connection: Connection }> {
  const member = await createMember({ orgId: T, tenantId: T, displayName: subject, subject, roles });
  const connection = await createSecretConnection({ tenantId: T, provider: PROVIDER, kind: 'bearer', secret, scope: 'user', userId: subject });
  return { member, connection };
}

/** Warm the cache for a principal and PROVE it is warm: two reads, one wire call. */
async function warm(subject: string): Promise<void> {
  await client(subject).listTools(PROVIDER);
  await client(subject).listTools(PROVIDER);
  expect(peer.lists(), 'precondition: the second read must be a cache HIT').toHaveLength(1);
  expect(_mcpClientCacheSize()).toBe(1);
}

describe('H57 — member seams (accessControlService) invalidate the outbound MCP cache', () => {
  it('a role change via updateMember DROPS the entry and the next listTools hits the wire', async () => {
    const { member } = await grant('ada', ['editor']);
    await warm('ada');
    // The REAL seam — never the invalidator.
    await updateMember(member.memberId, { roles: ['viewer'] });
    expect(_mcpClientCacheSize(), 'the invalidator must have dropped the stale entry').toBe(0);
    await client('ada').listTools(PROVIDER);
    expect(peer.lists(), 'the TTL had not lapsed; the rights changed').toHaveLength(2);
  });

  it('removing the member via deleteMember DROPS the entry and the next listTools hits the wire', async () => {
    // A second, unrelated principal proves the drop is scoped to the member.
    await grant('grace', ['editor']);
    const { member } = await grant('ada', ['editor']);
    await warm('ada');
    await client('grace').listTools(PROVIDER);
    expect(_mcpClientCacheSize()).toBe(2);
    await deleteMember(member.memberId);
    expect(_mcpClientCacheSize(), "only ada's entry is dropped; grace's survives").toBe(1);
    peer.reset();
    await client('ada').listTools(PROVIDER); // ada still owns her user Connection — self-authorized
    expect(peer.lists()).toHaveLength(1);
    await client('grace').listTools(PROVIDER);
    expect(peer.lists(), "grace's read is still a hit").toHaveLength(1);
  });

  it('a role change written by ANOTHER INSTANCE (raw row write, no invalidator) is a MISS on the next read — the KEY carries the scopes', async () => {
    const { member } = await grant('ada', ['editor']);
    await warm('ada');
    // Simulate a peer instance: the row changes under us and no in-process
    // signal fires. This is the cross-instance reality on Cloud Run.
    const raw = await storage.kvGet(memberRowKey(member.memberId));
    expect(raw).not.toBeNull();
    const row = JSON.parse(raw!) as OrgMember;
    await storage.kvSet(memberRowKey(member.memberId), JSON.stringify({ ...row, roles: ['viewer'], updatedAt: new Date().toISOString() }));
    expect(_mcpClientCacheSize(), 'honest: nothing dropped it — the invalidator is process-local').toBe(1);
    await client('ada').listTools(PROVIDER);
    expect(peer.lists(), 'a changed authorization context is a different KEY, so the warm entry is unreachable').toHaveLength(2);
  });

  it('a different principal with different roles is never served the first one\'s private list', async () => {
    await grant('ada', ['owner']);
    await grant('grace', ['viewer']);
    await client('ada').listTools(PROVIDER);
    await client('grace').listTools(PROVIDER);
    expect(peer.lists()).toHaveLength(2);
    expect(peer.lists().map((c) => c.auth)).toEqual(['Bearer tok-ada', 'Bearer tok-grace']);
  });
});

describe('H57 — Connection seams (connectionsService) invalidate the outbound MCP cache', () => {
  it('revokeConnection DROPS the principal\'s entry; the next read cannot ride the dead credential', async () => {
    const { connection } = await grant('ada');
    await warm('ada');
    await revokeConnection(T, connection.connectionId);
    expect(_mcpClientCacheSize(), 'the invalidator must have dropped the stale entry').toBe(0);
    // No fallback Connection exists, so the read fails closed — it does NOT
    // answer from the warm list gathered under the revoked credential.
    await expect(client('ada').listTools(PROVIDER)).rejects.toMatchObject({ code: 'mcp_not_connected' });
    expect(peer.lists()).toHaveLength(1);
  });

  it('a re-consent (rotation) via upsertOAuthConnection DROPS the entry and the next read carries the NEW bearer', async () => {
    await createMember({ orgId: T, tenantId: T, displayName: 'ada', subject: 'ada', roles: ['editor'] });
    const first = await upsertOAuthConnection({ tenantId: T, provider: PROVIDER, userId: 'ada', tokens: { accessToken: 't1', tokenType: 'bearer', scopes: ['read'] } });
    await warm('ada');
    expect(peer.lists()[0]!.auth).toBe('Bearer t1');
    // Re-consent lands on the SAME row (the ADR 0024 identity tuple) — same
    // connectionId, new material. Without a provenance component in the key
    // this is indistinguishable from the entry already cached.
    const second = await upsertOAuthConnection({ tenantId: T, provider: PROVIDER, userId: 'ada', tokens: { accessToken: 't2', tokenType: 'bearer', scopes: ['read'] } });
    expect(second.connectionId).toBe(first.connectionId);
    expect(_mcpClientCacheSize(), 'the invalidator must have dropped the stale entry').toBe(0);
    await client('ada').listTools(PROVIDER);
    expect(peer.lists()).toHaveLength(2);
    expect(peer.lists()[1]!.auth).toBe('Bearer t2');
  });

  it('a rotation written by ANOTHER INSTANCE (raw row write, no invalidator) is a MISS on the next read — the KEY carries the credential provenance', async () => {
    await createMember({ orgId: T, tenantId: T, displayName: 'ada', subject: 'ada', roles: ['editor'] });
    const conn = await upsertOAuthConnection({ tenantId: T, provider: PROVIDER, userId: 'ada', tokens: { accessToken: 't1', tokenType: 'bearer', scopes: ['read'] } });
    await warm('ada');
    // The peer instance re-consented: new token material under the same ref,
    // and the row's `updatedAt` moved. No signal reaches this process.
    await setSecret(`connection:${conn.connectionId}`, JSON.stringify({ accessToken: 't2', tokenType: 'bearer', scopes: ['read'] }), { tenantId: T });
    const raw = await storage.kvGet(connectionRowKey(conn.connectionId));
    expect(raw).not.toBeNull();
    const row = JSON.parse(raw!) as Connection;
    await storage.kvSet(connectionRowKey(conn.connectionId), JSON.stringify({ ...row, updatedAt: new Date(Date.now() + 1000).toISOString() }));
    expect((await getConnection(T, conn.connectionId))?.updatedAt).not.toBe(row.updatedAt);
    expect(_mcpClientCacheSize(), 'honest: nothing dropped it — the invalidator is process-local').toBe(1);
    await client('ada').listTools(PROVIDER);
    expect(peer.lists(), 'a rotated Connection is a different KEY, so the warm entry is unreachable').toHaveLength(2);
    expect(peer.lists()[1]!.auth).toBe('Bearer t2');
  });
});
