/**
 * ADR 0553 P3 — token audience, both directions.
 *
 * The ADR's Decision § "Versioned codecs" says provider manifests declare "the
 * exact MCP profile and auth audience". P2 shipped neither; this file covers the
 * audience half.
 *
 * THE THREAT IS THE CONFUSED DEPUTY. `resolveTarget` binds a credential and a
 * URL by the same `serverId`, which stops the obvious cross-wiring — but it
 * cannot see what the credential the broker returned was actually MINTED for. A
 * token issued for server A and stored under server B's connection (a
 * misconfiguration, a copied secret, a refresh pointed at the wrong issuer)
 * makes this host spend A's authority at B, and the host is the only party in a
 * position to notice, because only it can see both the token and the manifest.
 *
 * FAIL-CLOSED INCLUDES THE UNREADABLE CASE, and that is the design decision
 * worth stating: a manifest that declares an audience and a token whose audience
 * cannot be read is a REFUSAL. Letting opaque bearers through would have made
 * the guard unable to fail on the commonest credential shape there is, which is
 * indistinguishable from having no guard. Declaring `audience` is opt-in
 * precisely so that this can be strict without breaking connectors that carry
 * opaque tokens today — proven by the unpinned legs below, which still work.
 *
 * INBOUND is asserted, not rebuilt. RFC 0154 workload credentials already reach
 * the MCP mount through `middleware/workloadIdentity.ts`, which refuses an
 * audience mismatch before `routes/mcp.ts` runs. P3's job there is to prove it,
 * because "the mount is covered by a global middleware" is exactly the kind of
 * claim that stops being true when someone adds an exempt path.
 *
 * @see spec/v1/mcp-integration.md §E; host/workloadIdentity.ts §A(3)
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeMcpClient, McpError } from '../src/host/mcpClient.js';
import { _resetMcpClientCache } from '../src/host/mcpClientCache.js';
import { _resetMcpNegotiation } from '../src/host/mcpClient.js';
import { MCP_CURRENT_VERSION } from '../src/host/mcpProfile.js';
import { getProvider, registerProvider } from '../src/features/connections/providerRegistry.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { __resetGovernanceStore } from '../src/host/governanceService.js';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';

/** A JWT-shaped token asserting `aud`. Unsigned — the audience check is a
 *  confused-deputy check, not a verification (the PEER verifies its own
 *  tokens), so a forged token with the wrong `aud` must be refused for exactly
 *  the same reason a genuine one is. */
function jwtWithAudience(aud: string | string[] | undefined): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(aud === undefined ? { sub: 'u1' } : { sub: 'u1', aud })}.sig`;
}

const AUD_A = 'https://mcp-a.example.com';
const AUD_B = 'https://mcp-b.example.com';
const TENANT = 'audtenant';

/** Server ids: A declares an audience, U declares none. */
const SERVER_A = 'p3-aud-a';
const SERVER_U = 'p3-aud-unset';

let storage: Storage;
let server: Server;
let endpoint: string;
let sawAuthorization: string | undefined;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  const app = await createApp({ port: 18975, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await __resetConnectionsStore();
  await __resetGovernanceStore();

  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      sawAuthorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: unknown; method?: string };
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
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  registerProvider({ id: SERVER_A, label: 'A', kind: 'bearer', authFlow: 'none', scopes: { read: [] }, refreshable: false, defaultScopes: [], consumerNodes: ['core.openwop.mcp'], reach: 'mcp', mcpServer: { url: endpoint, transport: 'http', audience: AUD_A } });
  registerProvider({ id: SERVER_U, label: 'U', kind: 'bearer', authFlow: 'none', scopes: { read: [] }, refreshable: false, defaultScopes: [], consumerNodes: ['core.openwop.mcp'], reach: 'mcp', mcpServer: { url: endpoint, transport: 'http' } });
});

afterAll(async () => {
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  await new Promise<void>((r) => server.close(() => r()));
  await __resetGovernanceStore();
});

afterEach(() => {
  sawAuthorization = undefined;
  _resetMcpNegotiation();
  _resetMcpClientCache();
});

const client = (): ReturnType<typeof makeMcpClient> =>
  makeMcpClient({ storage, tenantId: TENANT, actingUserId: 'u1', orgId: TENANT });

/** Point a server id's stored credential at a specific token. */
async function connect(provider: string, secret: string): Promise<void> {
  await __resetConnectionsStore();
  await createSecretConnection({ tenantId: TENANT, provider, kind: 'bearer', secret, scope: 'user', userId: 'u1' });
}

describe('RFC 0153 §E outbound — a manifest-declared audience is verified before the call', () => {
  it('the fixture manifests carry what the legs assume (non-vacuity)', () => {
    expect(getProvider(SERVER_A)?.mcpServer?.audience).toBe(AUD_A);
    expect(getProvider(SERVER_U)?.mcpServer?.audience).toBeUndefined();
  });

  it('a token minted for THIS server is accepted and reaches the wire', async () => {
    await connect(SERVER_A, jwtWithAudience(AUD_A));
    const out = await client().invokeTool(SERVER_A, 'echo', { text: 'hi' });
    expect(out.untrustedContent).toBe(true);
    expect(sawAuthorization, 'the bearer must actually be attached — otherwise the refusal legs prove nothing').toBe(`Bearer ${jwtWithAudience(AUD_A)}`);
  });

  it('CONFUSED DEPUTY: a token minted for server A presented to server B is refused BEFORE the call', async () => {
    // The stored credential for A is a token addressed to B. Nothing about the
    // URL, the connector id, or the governance gate can see that; only the
    // token can.
    await connect(SERVER_A, jwtWithAudience(AUD_B));
    const err = await client().invokeTool(SERVER_A, 'echo', { text: 'hi' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe('mcp_token_audience_mismatch');
    expect((err as McpError).details).toMatchObject({ protocol: 'mcp', reason: 'audience_mismatch' });
    // BEFORE the call: the peer saw nothing at all. A refusal that still leaked
    // the token to the wrong server would be the whole defect.
    expect(sawAuthorization).toBeUndefined();
  });

  it('the refusal names NEITHER the token nor the audience it was actually minted for', async () => {
    // An `aud` claim names a real host; joined to a refusal it tells a prober
    // which OTHER peer this credential is good for, which is the fact an
    // attacker walking a confused deputy is looking for.
    await connect(SERVER_A, jwtWithAudience(AUD_B));
    const err = (await client().invokeTool(SERVER_A, 'echo', {}).catch((e: unknown) => e)) as McpError;
    const rendered = `${err.message} ${JSON.stringify(err.details)}`;
    expect(rendered).not.toContain(AUD_B);
    expect(rendered).not.toContain('sig');
    expect(rendered).not.toContain(jwtWithAudience(AUD_B));
  });

  it('an ARRAY `aud` that CONTAINS this server is accepted (RFC 7519 allows a list)', async () => {
    await connect(SERVER_A, jwtWithAudience([AUD_B, AUD_A]));
    await expect(client().invokeTool(SERVER_A, 'echo', {})).resolves.toMatchObject({ untrustedContent: true });
  });

  it('an ARRAY `aud` that omits this server is refused', async () => {
    await connect(SERVER_A, jwtWithAudience([AUD_B, 'https://third.example.com']));
    await expect(client().invokeTool(SERVER_A, 'echo', {})).rejects.toMatchObject({ code: 'mcp_token_audience_mismatch' });
    expect(sawAuthorization).toBeUndefined();
  });

  it('an OPAQUE bearer against a declaring manifest is refused — the guard is not skippable by token shape', async () => {
    // The leg that decides whether this guard is real. If an unreadable audience
    // were allowed through, every opaque OAuth bearer — which is most of them —
    // would bypass the check, and the guard would pass on exactly the population
    // it exists for.
    await connect(SERVER_A, 'opaque-not-a-jwt');
    const err = (await client().invokeTool(SERVER_A, 'echo', {}).catch((e: unknown) => e)) as McpError;
    expect(err.code).toBe('mcp_token_audience_mismatch');
    expect(err.details).toMatchObject({ reason: 'audience_unreadable' });
    expect(sawAuthorization).toBeUndefined();
  });

  it('a JWT with NO `aud` claim at all against a declaring manifest is refused', async () => {
    await connect(SERVER_A, jwtWithAudience(undefined));
    await expect(client().invokeTool(SERVER_A, 'echo', {})).rejects.toMatchObject({ code: 'mcp_token_audience_mismatch' });
  });

  it('a manifest that declares NO audience is unchanged — an opaque bearer still works', async () => {
    // The discriminating half of the fail-closed decision. Without this, the
    // strictness above could have been shipped as a blanket rule that broke
    // every existing connector, and every test would still be green.
    await connect(SERVER_U, 'opaque-not-a-jwt');
    await expect(client().invokeTool(SERVER_U, 'echo', {})).resolves.toMatchObject({ untrustedContent: true });
    expect(sawAuthorization).toBe('Bearer opaque-not-a-jwt');
  });

  it('the gate covers EVERY method, not just tools/call', async () => {
    // The gate sits at `wireCall`, the single point where a bearer is attached,
    // rather than beside the three resolve sites — so a method added later
    // cannot be added around it. `listTools` reaches the wire through a
    // different path (`server/discover` first), which is why it is the probe.
    await connect(SERVER_A, jwtWithAudience(AUD_B));
    await expect(client().listTools(SERVER_A)).rejects.toMatchObject({ code: 'mcp_token_audience_mismatch' });
    await expect(client().readResource(SERVER_A, 'file:///x')).rejects.toMatchObject({ code: 'mcp_token_audience_mismatch' });
    expect(sawAuthorization).toBeUndefined();
  });
});

describe('RFC 0153 §E inbound — an RFC 0154 workload credential is audience-checked AT THE MOUNT', () => {
  // Driven over HTTP against the real mount, not against the resolver.
  // `workload-identity-resolver.test.ts` already proves the §A(3) decision in
  // isolation; what is unproven — and what stops being true the day someone
  // adds an exempt path or reorders `index.ts` — is that the MCP mount is
  // actually BEHIND it. That is an HTTP fact, so it is asserted over HTTP.
  const HOST_AUDIENCE = 'https://mcp-host.example.com';
  const OTHER_AUDIENCE = 'https://not-this-host.example.com';
  let base: string;
  let mountServer: import('node:http').Server;

  beforeAll(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { configureSecretResolver, setSecret } = await import('../src/byok/secretResolver.js');
    const { HOST_SIGNING_KEY_REF, SUBJECT_SALT_REF } = await import('../src/host/workloadIdentity.js');
    const { openStorage } = await import('../src/storage/index.js');

    process.env.OPENWOP_SESSION_SECRET = 'mcp-audience-test-session-secret';
    process.env.OPENWOP_MCP_SERVER_ENABLED = 'true';
    process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
    process.env.OPENWOP_WORKLOAD_IDENTITY_AUDIENCE = HOST_AUDIENCE;

    const s = await openStorage('memory://');
    configureSecretResolver({ storage: s, dataDir: mkdtempSync(join(tmpdir(), 'mcp-aud-')) });
    await setSecret(HOST_SIGNING_KEY_REF, 'host-workload-signing-key');
    await setSecret(SUBJECT_SALT_REF, 'host-subject-salt');

    const app = await createApp({ port: 18976, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    // Loopback v4 explicitly — see `check-test-ports` / H41.
    mountServer = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => mountServer.once('listening', () => r()));
    base = `http://127.0.0.1:${(mountServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const k of ['OPENWOP_MCP_SERVER_ENABLED', 'OPENWOP_TEST_SEAM_ENABLED', 'OPENWOP_WORKLOAD_IDENTITY_AUDIENCE']) delete process.env[k];
    await new Promise<void>((r) => mountServer.close(() => r()));
  });

  const post = async (headers: Record<string, string>): Promise<number> => {
    const res = await fetch(`${base}/v1/host/openwop-app/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-protocol-version': MCP_CURRENT_VERSION, ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MCP_CURRENT_VERSION, 'io.modelcontextprotocol/clientCapabilities': {} } } }),
    });
    return res.status;
  };

  it('NO workload credential reaches the mount normally (the control — otherwise every leg below is vacuous)', async () => {
    // The test-seam principal stands in for an authenticated caller here; the
    // point of this leg is that the mount ANSWERS, so a 401 below is
    // attributable to the audience check and not to the mount being shut.
    expect(await post({})).toBe(200);
  });

  it('a workload credential minted for ANOTHER audience is refused 401 BEFORE the mount runs', async () => {
    const { mintWorkloadCredential } = await import('../src/host/workloadIdentity.js');
    const token = await mintWorkloadCredential({ subject: 'worker/probe', tenantId: 'default', scopes: ['runs:read'] });
    // The credential was minted while the host answered to HOST_AUDIENCE; the
    // host now answers to a different name, so the SAME credential is addressed
    // elsewhere. That is the inbound confused deputy, reproduced without forging
    // anything — the signature is genuine and the audience is not.
    process.env.OPENWOP_WORKLOAD_IDENTITY_AUDIENCE = OTHER_AUDIENCE;
    try {
      expect(await post({ 'x-openwop-workload-identity': token })).toBe(401);
    } finally {
      process.env.OPENWOP_WORKLOAD_IDENTITY_AUDIENCE = HOST_AUDIENCE;
    }
  });

  it('the same credential under the MATCHING audience is admitted — the guard does not simply refuse everything', async () => {
    const { mintWorkloadCredential } = await import('../src/host/workloadIdentity.js');
    const token = await mintWorkloadCredential({ subject: 'worker/probe', tenantId: 'default', scopes: ['runs:read'] });
    expect(await post({ 'x-openwop-workload-identity': token })).toBe(200);
  });

  it('a GARBAGE workload credential is refused 401, never ignored', async () => {
    // "Presented but uncheckable" must not degrade to "not presented".
    expect(await post({ 'x-openwop-workload-identity': 'not-a-credential' })).toBe(401);
  });
});
