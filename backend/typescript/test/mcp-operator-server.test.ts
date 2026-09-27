/**
 * H21 / ADR 0553 / RFC 0153 — operator-configured outbound MCP server.
 *
 * Proves the operator surface (`OPENWOP_MCP_SERVER_*`) resolves into a curated
 * `reach:'mcp'` Connections provider that travels the EXISTING outbound
 * pipeline, that its credential lane fails closed, and that no other provider's
 * per-user credential gate moved.
 *
 * The server here is a real HTTP JSON-RPC server on 127.0.0.1 — the assertions
 * read the headers it actually received, so "no Authorization header" is a wire
 * observation, not a claim about the code.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { makeMcpClient } from '../src/host/mcpClient.js';
import {
  DEFAULT_OPERATOR_MCP_SERVER_ID,
  operatorMcpConfig,
  operatorMcpServerId,
  registerOperatorMcpServer,
  resolveOperatorMcpCredential,
  isOperatorManagedMcpServer,
  _resetOperatorMcpRegistration,
} from '../src/host/mcpOperatorServer.js';
import { getProvider, registerProvider } from '../src/features/connections/providerRegistry.js';
import { setSecret } from '../src/byok/secretResolver.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { setGovernancePolicy, __resetGovernanceStore } from '../src/host/governanceService.js';

const MCP_ENV_KEYS = [
  'OPENWOP_MCP_SERVER_URL',
  'OPENWOP_MCP_SERVER_ID',
  'OPENWOP_MCP_SERVER_LABEL',
  'OPENWOP_MCP_SERVER_TOKEN_REF',
] as const;

function clearMcpEnv(): void {
  for (const k of MCP_ENV_KEYS) delete process.env[k];
  _resetOperatorMcpRegistration();
}

describe('operator-configured outbound MCP server (H21)', () => {
  let srv: http.Server;
  let storage: Storage;
  let url: string;
  let seen: { authorization?: string; method?: string } = {};

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    // Loopback is only reachable under the private-egress posture — the same
    // gate the conformance boot sets. Nothing here relaxes a production default.
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const app = await createApp({ port: 18971, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await __resetConnectionsStore();
    await __resetGovernanceStore();

    srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const rpc = JSON.parse(raw) as { id: number; method: string };
        seen = { ...(req.headers.authorization !== undefined ? { authorization: req.headers.authorization } : {}), method: rpc.method };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: rpc.method === 'tools/call'
            ? { content: [{ type: 'text', text: 'roundtrip-probe' }], isError: false }
            : {},
        }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

    await storage.insertRun({ runId: 'run-opmcp', workflowId: 'w', tenantId: 'topmcp', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
  });

  afterAll(async () => {
    clearMcpEnv();
    await __resetGovernanceStore();
    await new Promise<void>((r) => srv.close(() => r()));
  });

  afterEach(() => {
    clearMcpEnv();
    seen = {};
  });

  const client = (): ReturnType<typeof makeMcpClient> =>
    makeMcpClient({ storage, tenantId: 'topmcp', runId: 'run-opmcp', actingUserId: 'u1', orgId: 'topmcp' });

  // ── config resolution ─────────────────────────────────────────────────────

  it('is unconfigured by default — no config, no server id', () => {
    expect(operatorMcpConfig()).toBeNull();
    expect(operatorMcpServerId()).toBeNull();
  });

  it('defaults the id + label, strips a trailing slash, and honours overrides', () => {
    process.env.OPENWOP_MCP_SERVER_URL = 'https://mcp.example.com/';
    expect(operatorMcpConfig()).toEqual({
      id: DEFAULT_OPERATOR_MCP_SERVER_ID,
      url: 'https://mcp.example.com',
      label: 'Operator MCP server',
      tokenRef: null,
    });

    process.env.OPENWOP_MCP_SERVER_ID = 'internal-mcp';
    process.env.OPENWOP_MCP_SERVER_LABEL = 'Internal tools';
    process.env.OPENWOP_MCP_SERVER_TOKEN_REF = 'mcp:internal-token';
    expect(operatorMcpConfig()).toEqual({
      id: 'internal-mcp',
      url: 'https://mcp.example.com',
      label: 'Internal tools',
      tokenRef: 'mcp:internal-token',
    });
    expect(operatorMcpServerId()).toBe('internal-mcp');
  });

  it('a whitespace-only URL is unconfigured, not a server at ""', () => {
    process.env.OPENWOP_MCP_SERVER_URL = '   ';
    expect(operatorMcpConfig()).toBeNull();
  });

  // ── provider synthesis ────────────────────────────────────────────────────

  it('registers a curated reach:mcp provider carrying the URL + the operatorManaged marker', () => {
    process.env.OPENWOP_MCP_SERVER_URL = 'https://mcp.example.com';
    process.env.OPENWOP_MCP_SERVER_ID = 'synth-mcp';
    registerOperatorMcpServer();
    const m = getProvider('synth-mcp');
    expect(m?.reach).toBe('mcp');
    expect(m?.mcpServer).toEqual({ url: 'https://mcp.example.com', transport: 'http' });
    expect(m?.operatorManaged).toBe(true);
    expect(isOperatorManagedMcpServer('synth-mcp')).toBe(true);
  });

  it('registers nothing when unconfigured', () => {
    registerOperatorMcpServer();
    expect(getProvider(DEFAULT_OPERATOR_MCP_SERVER_ID)).toBeNull();
  });

  it('no built-in provider carries the operatorManaged marker', () => {
    // The marker is the ONLY thing that skips the per-user credential gate, so a
    // built-in acquiring it would be a silent authorization bypass.
    expect(isOperatorManagedMcpServer('google')).toBe(false);
    expect(isOperatorManagedMcpServer('slack')).toBe(false);
  });

  // ── credential lane ───────────────────────────────────────────────────────

  it('no token ref ⇒ the operator declared the endpoint auth-less (empty secret)', async () => {
    process.env.OPENWOP_MCP_SERVER_URL = 'https://mcp.example.com';
    expect(await resolveOperatorMcpCredential(DEFAULT_OPERATOR_MCP_SERVER_ID)).toBe('');
  });

  it('a token ref that resolves yields the secret; one that does not is fail-closed null', async () => {
    process.env.OPENWOP_MCP_SERVER_URL = 'https://mcp.example.com';
    process.env.OPENWOP_MCP_SERVER_TOKEN_REF = 'mcp:operator-token';
    await setSecret('mcp:operator-token', 'op-secret');
    expect(await resolveOperatorMcpCredential(DEFAULT_OPERATOR_MCP_SERVER_ID)).toBe('op-secret');

    process.env.OPENWOP_MCP_SERVER_TOKEN_REF = 'mcp:never-stored';
    expect(await resolveOperatorMcpCredential(DEFAULT_OPERATOR_MCP_SERVER_ID)).toBeNull();
  });

  it('refuses a serverId that is not the configured one', async () => {
    process.env.OPENWOP_MCP_SERVER_URL = 'https://mcp.example.com';
    expect(await resolveOperatorMcpCredential('some-other-server')).toBeNull();
  });

  // ── end to end through the real client ────────────────────────────────────

  it('invokes the operator server with NO Connection row and NO Authorization header', async () => {
    process.env.OPENWOP_MCP_SERVER_URL = url;
    registerOperatorMcpServer();
    const out = await client().invokeTool(operatorMcpServerId()!, 'echo', { text: 'roundtrip-probe' });
    expect(out.isError).toBe(false);
    expect(out.untrustedContent).toBe(true);
    expect(out.result).toEqual([{ type: 'text', text: 'roundtrip-probe' }]);
    expect(seen.method).toBe('tools/call');
    // A placeholder bearer would be worse than none — assert the header is
    // absent on the wire, not merely empty.
    expect(seen.authorization).toBeUndefined();
    // The stamp still records the use: an operator-managed call is not an
    // unattributed one.
    const meta = (await storage.getRun('run-opmcp'))?.metadata as Record<string, unknown> | undefined;
    expect((meta?.connectionUse as Array<{ provider?: string }> | undefined)?.some((u) => u.provider === DEFAULT_OPERATOR_MCP_SERVER_ID)).toBe(true);
  });

  it('sends the operator bearer when a token ref is configured', async () => {
    process.env.OPENWOP_MCP_SERVER_URL = url;
    process.env.OPENWOP_MCP_SERVER_TOKEN_REF = 'mcp:wire-token';
    await setSecret('mcp:wire-token', 'wire-secret');
    registerOperatorMcpServer();
    await client().invokeTool(operatorMcpServerId()!, 'echo', {});
    expect(seen.authorization).toBe('Bearer wire-secret');
  });

  it('a declared-but-unresolvable token ref fails closed instead of calling unauthenticated', async () => {
    process.env.OPENWOP_MCP_SERVER_URL = url;
    process.env.OPENWOP_MCP_SERVER_TOKEN_REF = 'mcp:absent-token';
    registerOperatorMcpServer();
    await expect(client().invokeTool(operatorMcpServerId()!, 'echo', {})).rejects.toMatchObject({ code: 'mcp_not_connected' });
    expect(seen.method).toBeUndefined(); // never reached the socket
  });

  it('a non-https operator URL is refused unless the private-egress posture is on', async () => {
    // The operator knob must not become a way to put plaintext MCP traffic on a
    // real deploy: `resolveTarget`'s https rule applies to it exactly as it does
    // to a built-in, and the loopback server every test above uses is reachable
    // ONLY because this file opts into the private-egress posture.
    process.env.OPENWOP_MCP_SERVER_URL = url; // http://127.0.0.1:…
    registerOperatorMcpServer();
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'false';
    try {
      await expect(client().invokeTool(operatorMcpServerId()!, 'echo', {})).rejects.toMatchObject({ code: 'insecure_mcp_endpoint' });
      expect(seen.method, 'nothing may reach a plaintext endpoint outside the test posture').toBeUndefined();
    } finally {
      process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    }
  });

  it('governance still gates the operator server', async () => {
    process.env.OPENWOP_MCP_SERVER_URL = url;
    registerOperatorMcpServer();
    await setGovernancePolicy('topmcp', { providerAllowlist: ['something-else'] });
    try {
      await expect(client().invokeTool(operatorMcpServerId()!, 'echo', {})).rejects.toMatchObject({ code: 'connector_not_allowed' });
    } finally {
      // try/finally, not a trailing call: when this leg FAILS the allowlist would
      // otherwise leak into the next test and red it with `connector_not_allowed`,
      // burying the real failure under a second, misleading one. (Observed while
      // sabotage-verifying this exact assertion.)
      await __resetGovernanceStore();
    }
  });

  it('a NON-operator provider still requires a per-user Connection, and still sends ITS token', async () => {
    // The regression this guards: an `operatorManaged` branch written on the
    // wrong condition (e.g. `reach === 'mcp'`) would take every MCP provider
    // down the operator lane. The no-connection half alone does NOT catch that
    // — the operator lane also refuses an id it did not configure — so the
    // connected half is the discriminating assertion: under a wrong condition
    // the per-user bearer never reaches the wire.
    registerProvider({
      id: 'plain-mcp', label: 'Plain MCP', kind: 'bearer', authFlow: 'none', reach: 'mcp',
      scopes: { read: [] }, refreshable: false, defaultScopes: [],
      consumerNodes: ['core.openwop.mcp'], mcpServer: { url, transport: 'http' },
    });
    await expect(client().invokeTool('plain-mcp', 'echo', {})).rejects.toMatchObject({ code: 'mcp_not_connected' });

    await createSecretConnection({ tenantId: 'topmcp', provider: 'plain-mcp', kind: 'bearer', secret: 'per-user-token', scope: 'user', userId: 'u1' });
    await client().invokeTool('plain-mcp', 'echo', {});
    expect(seen.authorization).toBe('Bearer per-user-token');
  });
});
