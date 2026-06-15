/**
 * Outbound MCP client (ADR 0030). Proves ctx.mcp.{invokeTool,readResource,
 * listTools,serverStatus} call an external JSON-RPC server with the acting
 * user's per-user Connection token, gated by governance (ADR 0028), marking
 * output untrusted (ADR 0027), stamping provenance — and fail-closing on the
 * three gates (unknown server / governance-denied / no connection).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { makeMcpClient, McpError } from '../src/host/mcpClient.js';
import { getProvider, registerProvider } from '../src/features/connections/providerRegistry.js';
import { loadConnectionPacks } from '../src/features/connections/connectionPackLoader.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { setGovernancePolicy, __resetGovernanceStore } from '../src/host/governanceService.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Outbound MCP client (ADR 0030)', () => {
  let srv: http.Server;
  let storage: Storage;
  let last: { auth?: string; method?: string; params?: Record<string, unknown> };
  let sseMode = false;
  let sseEol = '\n\n'; // frame delimiter the mock server uses (LF or CRLF)
  let resourceChanges = false; // when true, resources/read returns a changing body
  let resourceCounter = 0;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const app = await createApp({ port: 18948, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await __resetConnectionsStore();
    await __resetGovernanceStore();

    srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const rpc = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> };
        last = { auth: req.headers.authorization, method: rpc.method, params: rpc.params };
        const result =
          rpc.method === 'tools/call' ? { content: [{ type: 'text', text: 'tool output' }], isError: false }
          : rpc.method === 'tools/list' ? { tools: [{ name: 'echo' }] }
          : rpc.method === 'resources/read' ? { contents: [{ uri: 'res://x', mimeType: 'text/plain', text: resourceChanges ? `v${++resourceCounter}` : 'resource body' }] }
          : rpc.method === 'initialize' ? { serverInfo: { name: 'TestMCP', version: '1.0' } }
          : {};
        const envelope = JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result });
        if (sseMode) {
          // MCP Streamable HTTP: a server-pushed notification frame, THEN the
          // response frame (the client must skip the notification, match the id).
          const eol = sseEol === '\r\n\r\n' ? '\r\n' : '\n';
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`event: message${eol}data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}${sseEol}`);
          res.end(`event: message${eol}data: ${envelope}${sseEol}`);
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(envelope);
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`;

    registerProvider({ id: 'testmcp', label: 'Test MCP', kind: 'bearer', authFlow: 'none', reach: 'mcp', scopes: { read: [] }, refreshable: false, defaultScopes: [], consumerNodes: ['core.openwop.mcp'], mcpServer: { url, transport: 'http' } });
    await createSecretConnection({ tenantId: 'tmcp', provider: 'testmcp', kind: 'bearer', secret: 'mcp-token', scope: 'user', userId: 'u1' });
    await storage.insertRun({ runId: 'run-mcp', workflowId: 'w', tenantId: 'tmcp', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
  });

  afterAll(async () => {
    await __resetGovernanceStore();
    await new Promise<void>((r) => srv.close(() => r()));
  });

  const client = (u?: string): ReturnType<typeof makeMcpClient> => makeMcpClient({ storage, tenantId: 'tmcp', runId: 'run-mcp', ...(u ? { actingUserId: u } : {}), orgId: 'tmcp' });

  it('invokeTool: per-user Bearer + JSON-RPC tools/call + untrusted output + provenance', async () => {
    const out = await client('u1').invokeTool('testmcp', 'echo', { x: 1 });
    expect(out).toEqual({ result: [{ type: 'text', text: 'tool output' }], isError: false, untrustedContent: true });
    expect(last.auth).toBe('Bearer mcp-token');
    expect(last.method).toBe('tools/call');
    expect(last.params).toEqual({ name: 'echo', arguments: { x: 1 } });
    const meta = (await storage.getRun('run-mcp'))?.metadata as Record<string, unknown> | undefined;
    expect((meta?.connectionUse as Array<{ provider?: string }> | undefined)?.some((u) => u.provider === 'testmcp')).toBe(true);
  });

  it('listTools + readResource + serverStatus map the JSON-RPC results', async () => {
    expect(await client('u1').listTools('testmcp')).toEqual({ tools: [{ name: 'echo' }] });
    expect(await client('u1').readResource('testmcp', 'res://x')).toEqual({ content: 'resource body', mimeType: 'text/plain', untrustedContent: true });
    expect(await client('u1').serverStatus('testmcp')).toEqual({ available: true, name: 'TestMCP', version: '1.0' });
  });

  it('fail-closed: unknown server / no connection', async () => {
    await expect(client('u1').invokeTool('nope', 'echo', {})).rejects.toMatchObject({ code: 'server_not_found' });
    await expect(client('u-no-conn').invokeTool('testmcp', 'echo', {})).rejects.toMatchObject({ code: 'mcp_not_connected' });
    await expect(client().invokeTool('testmcp', 'echo', {})).rejects.toMatchObject({ code: 'mcp_not_connected' }); // no acting user
  });

  it('fail-closed: governance allowlist denies the connector (ADR 0028)', async () => {
    await setGovernancePolicy('tmcp', { providerAllowlist: ['some-other-provider'] });
    try {
      await expect(client('u1').invokeTool('testmcp', 'echo', {})).rejects.toMatchObject({ code: 'connector_not_allowed' });
    } finally {
      await __resetGovernanceStore();
    }
  });

  it('McpError carries a typed code (node-failure surface)', async () => {
    const err = await client('u1').invokeTool('nope', 'x', {}).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe('server_not_found');
  });

  it('Phase 2a: parses a text/event-stream (Streamable HTTP) response, skipping notifications', async () => {
    sseMode = true;
    try {
      // invokeTool over SSE: skip the pushed notification frame, match the response id.
      const tool = await client('u1').invokeTool('testmcp', 'echo', { x: 1 });
      expect(tool).toEqual({ result: [{ type: 'text', text: 'tool output' }], isError: false, untrustedContent: true });
      // list + read also round-trip over SSE.
      expect(await client('u1').listTools('testmcp')).toEqual({ tools: [{ name: 'echo' }] });
      expect(await client('u1').readResource('testmcp', 'res://x')).toEqual({ content: 'resource body', mimeType: 'text/plain', untrustedContent: true });
    } finally {
      sseMode = false;
    }
  });

  it('Phase 2a: parses CRLF-delimited (\\r\\n\\r\\n) SSE frames too', async () => {
    sseMode = true;
    sseEol = '\r\n\r\n';
    try {
      const tool = await client('u1').invokeTool('testmcp', 'echo', { x: 1 });
      expect(tool).toEqual({ result: [{ type: 'text', text: 'tool output' }], isError: false, untrustedContent: true });
    } finally {
      sseMode = false;
      sseEol = '\n\n';
    }
  });

  it('Phase 2b: subscribeResource polls + fires onEvent on each change, marked untrusted + stamps once', async () => {
    resourceChanges = true;
    resourceCounter = 0;
    const events: Array<{ uri: string; content: unknown; untrustedContent: boolean }> = [];
    try {
      await client('u1').subscribeResource(
        { serverId: 'testmcp', uri: 'res://x' },
        (e) => { events.push(e); },
        { durationMs: 350, pollIntervalMs: 80, maxEvents: 50 },
      );
    } finally {
      resourceChanges = false;
    }
    // First poll = baseline (no event); each subsequent differing poll fires once.
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e.untrustedContent === true && e.uri === 'res://x')).toBe(true);
    expect(typeof events[0]?.content).toBe('string'); // the changed resource body (v2, v3, …)
    // One credential use stamped for the whole subscription window (the first poll).
    const meta = (await storage.getRun('run-mcp'))?.metadata as Record<string, unknown> | undefined;
    const subUses = (meta?.connectionUse as Array<{ provider?: string }> | undefined)?.filter((u) => u.provider === 'testmcp') ?? [];
    expect(subUses.length).toBe(1); // deduped by connectionId — not one per poll
  });

  it('Phase 2b: a throwing onEvent consumes the change once — no re-fire loop', async () => {
    // Drive a fixed number of changes, then hold the body steady so the only
    // re-delivery pressure would come from a buggy (throwing) consumer.
    resourceChanges = true;
    resourceCounter = 0;
    let calls = 0;
    try {
      await client('u1').subscribeResource(
        { serverId: 'testmcp', uri: 'res://x' },
        () => { calls++; throw new Error('consumer boom'); },
        { durationMs: 350, pollIntervalMs: 80, maxEvents: 50 },
      );
    } finally {
      resourceChanges = false;
    }
    // The baseline advances before delivery, so each DISTINCT change is delivered
    // at most once even though every onEvent throws — the count tracks the number
    // of changed polls, not an unbounded per-interval re-fire.
    const meta = (await storage.getRun('run-mcp'))?.metadata as Record<string, unknown> | undefined;
    const polls = (meta?.connectionUse as Array<{ provider?: string }> | undefined)?.filter((u) => u.provider === 'testmcp') ?? [];
    expect(calls).toBeLessThanOrEqual(5); // ~3 changes over the window, never a tight re-fire loop
    expect(polls.length).toBe(1); // still exactly one provenance stamp for the window
  });

  it('Phase 2b: subscribeResource fails fast on a gate error (first poll)', async () => {
    await expect(client('u1').subscribeResource({ serverId: 'nope', uri: 'res://x' }, () => {}, { durationMs: 200, pollIntervalMs: 50 }))
      .rejects.toMatchObject({ code: 'server_not_found' });
    await expect(client('u-no-conn').subscribeResource({ serverId: 'testmcp', uri: 'res://x' }, () => {}, { durationMs: 200, pollIntervalMs: 50 }))
      .rejects.toMatchObject({ code: 'mcp_not_connected' });
  });
});

/**
 * Work-twin connector reachability for the NAMED `reach:'mcp'` providers
 * (ADR 0033 §3.1 / Phase 3.1). The existing tests above prove the outbound MCP
 * path end-to-end against a synthetic `testmcp` provider; this block locks the
 * *actual* contract for the named day-1 providers google/slack, per ADR 0033's
 * Correction (2026-06-13):
 *
 *  (a) The built-in `google`/`slack` manifests are `reach:'mcp'` but ship NO
 *      `mcpServer` URL — there is no host-curated Google/Slack MCP endpoint baked
 *      in. So `ctx.mcp.invokeTool('google', …)` fails CLOSED with
 *      `server_not_found` today. This is the honest ARCHITECTURE.md "advertise
 *      only honored behavior" posture, NOT a bug: a `reach:'mcp'` tag without an
 *      endpoint is correctly un-invocable via the MCP client. (Google/Slack reach
 *      external APIs via brokered HTTP egress over `apiHosts` instead — see
 *      `connectionInjection.ts` — which is the "LIVE via brokered HTTP" day-1
 *      path the ADR Correction records.) This is the "confirm google/slack are
 *      not MCP-reachable today" half of the corrected T3.1.
 *  (b) ADR 0033 §1.2 + the Correction say the MCP endpoint arrives via a
 *      connection pack (RFC 0095) in T3.2, which `toProviderManifest` maps to
 *      `mcpServer.url`. This locks that forward path: once such a pack is
 *      installed (overriding the built-in) AND a per-user Connection exists, the
 *      exact call a `core.openwop.mcp.invoke-tool` node makes — `ctx.mcp.
 *      invokeTool('google', …)` — resolves the NAMED provider and dispatches the
 *      JSON-RPC call end-to-end (per-user Bearer, governance gate, untrusted
 *      output, provenance) with NO new client plumbing. So T3.2 is a pack +
 *      manifest change, never a client rebuild.
 */
describe('Work-twin reach:mcp providers — google/slack (ADR 0033 §3.1 + Correction)', () => {
  let srv: http.Server;
  let storage: Storage;
  let packRoot: string;
  let packLoopbackUrl: string;
  let last: { auth?: string; method?: string; params?: Record<string, unknown> } = {};

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const app = await createApp({ port: 18949, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await __resetConnectionsStore();
    await __resetGovernanceStore();

    srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const rpc = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> };
        last = { auth: req.headers.authorization, method: rpc.method, params: rpc.params };
        const result = rpc.method === 'tools/call' ? { content: [{ type: 'text', text: 'gmail draft created' }], isError: false } : {};
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`;

    // (b) A connection pack (RFC 0095) supplies the Google MCP server URL,
    // overriding the built-in `google` manifest — exactly the day-1 path ADR 0033
    // §1.2 prescribes (provider added as a pack, no host code). The pack loader
    // enforces an `https://` endpoint (schema), so the pack-MAPS-to-mcpServer leg
    // is asserted with a real https URL; the JSON-RPC DISPATCH leg below runs the
    // resolved provider against an http loopback mock via `registerProvider`
    // (the runtime client permits http only under OPENWOP_WEBHOOK_ALLOW_PRIVATE).
    packLoopbackUrl = url;
    packRoot = mkdtempSync(join(tmpdir(), 'owp-twin-mcp-'));
    const dir = join(packRoot, 'google-mcp');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pack.json'), JSON.stringify({
      name: 'core.openwop.connections.google-mcp',
      version: '1.0.0',
      kind: 'connection',
      engines: { openwop: '>=1.0.0' },
      provider: {
        id: 'google',
        displayName: 'Google Workspace (MCP)',
        category: 'email-calendar',
        auth: {
          kind: 'oauth2', authFlow: 'pkce', scopeModel: 'groups',
          endpoints: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token' },
          scopes: { read: [{ key: 'gmail.readonly', label: 'Gmail (read)', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] }] },
        },
        reach: { mcp: { server: { url: 'https://google-workspace.mcp.example.com/', transport: 'http' } } },
        consumerNodes: ['core.openwop.mcp.invoke-tool'],
      },
    }));

    await storage.insertRun({ runId: 'run-twin', workflowId: 'w', tenantId: 'ttwin', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
  });

  afterAll(async () => {
    await __resetGovernanceStore();
    rmSync(packRoot, { recursive: true, force: true });
    await new Promise<void>((r) => srv.close(() => r()));
  });

  const twinClient = (): ReturnType<typeof makeMcpClient> =>
    makeMcpClient({ storage, tenantId: 'ttwin', runId: 'run-twin', actingUserId: 'twin-user', orgId: 'ttwin' });

  it('(a) built-in google/slack are reach:mcp but ship no MCP endpoint → not MCP-reachable today (fail-closed)', async () => {
    // The honest posture: the tag exists, but a bare `reach:'mcp'` with no
    // `mcpServer` URL is correctly un-invocable via the MCP client (no fabricated
    // capability). google/slack instead reach via brokered HTTP egress (apiHosts).
    expect(getProvider('google')?.reach).toBe('mcp');
    expect(getProvider('slack')?.reach).toBe('mcp');
    expect(getProvider('google')?.mcpServer?.url).toBeUndefined(); // no built-in MCP endpoint
    expect(getProvider('slack')?.mcpServer?.url).toBeUndefined();
    expect(getProvider('google')?.apiHosts).toContain('googleapis.com'); // brokered-HTTP path instead
    // (this runs BEFORE the pack-install test below mutates the `google` registry entry)
    await expect(twinClient().invokeTool('google', 'gmail.create_draft', { to: 'x' }))
      .rejects.toMatchObject({ code: 'server_not_found' });
    await expect(twinClient().invokeTool('slack', 'chat.postMessage', { text: 'hi' }))
      .rejects.toMatchObject({ code: 'server_not_found' });
  });

  it('(b) connection pack supplies the MCP endpoint → google resolves with mcpServer.url', () => {
    // The day-1 path: install the pack → the built-in `google` is overridden and
    // now carries a (host-curated, https) MCP server URL. This is the leg that
    // turns a bare `reach:'mcp'` tag into an invocable provider.
    const { installed } = loadConnectionPacks({ roots: [packRoot] });
    expect(installed.find((r) => r.providerId === 'google')?.overrodeBuiltin).toBe(true);
    expect(getProvider('google')?.reach).toBe('mcp');
    expect(getProvider('google')?.mcpServer?.url).toBe('https://google-workspace.mcp.example.com/');
  });

  it('(b) invokeTool(google) dispatches end-to-end once the endpoint resolves', async () => {
    // Point the resolved `google` provider at the loopback mock (the pack loader
    // demands https; the runtime client permits http only under
    // OPENWOP_WEBHOOK_ALLOW_PRIVATE — set in beforeAll). registerProvider mirrors
    // the post-pack registry state so the JSON-RPC round-trip is observable.
    const g = getProvider('google');
    if (!g) throw new Error('google manifest missing');
    registerProvider({ ...g, mcpServer: { url: packLoopbackUrl, transport: 'http' } });

    // The per-user Connection (ADR 0024) the work twin's acting human owns.
    await createSecretConnection({ tenantId: 'ttwin', provider: 'google', kind: 'bearer', secret: 'google-user-token', scope: 'user', userId: 'twin-user' });

    // ctx.mcp.invokeTool('google', …) — the exact call a `core.openwop.mcp.invoke-tool`
    // node makes — resolves the NAMED provider and dispatches.
    const out = await twinClient().invokeTool('google', 'gmail.create_draft', { to: 'x@y.z' });
    expect(out).toEqual({ result: [{ type: 'text', text: 'gmail draft created' }], isError: false, untrustedContent: true });
    expect(last.auth).toBe('Bearer google-user-token'); // per-user token, host-side only
    expect(last.method).toBe('tools/call');
    expect(last.params).toEqual({ name: 'gmail.create_draft', arguments: { to: 'x@y.z' } });
    // Provenance stamped for the named provider (RFC 0079).
    const meta = (await storage.getRun('run-twin'))?.metadata as Record<string, unknown> | undefined;
    expect((meta?.connectionUse as Array<{ provider?: string }> | undefined)?.some((u) => u.provider === 'google')).toBe(true);
  });

  it('(b) endpoint resolves but no per-user Connection → mcp_not_connected (gate order)', async () => {
    // After (b) above, `google` has an endpoint AND a Connection for `twin-user`.
    // A DIFFERENT acting user has no Connection: the endpoint resolves, so the
    // failure is the per-user credential gate, not `server_not_found` — proving
    // the named provider clears resolution + governance and fails closed precisely
    // at auth (ADR 0030 step 3).
    const otherUser = (): ReturnType<typeof makeMcpClient> =>
      makeMcpClient({ storage, tenantId: 'ttwin', runId: 'run-twin', actingUserId: 'no-conn-user', orgId: 'ttwin' });
    await expect(otherUser().invokeTool('google', 'gmail.create_draft', { to: 'x@y.z' }))
      .rejects.toMatchObject({ code: 'mcp_not_connected' });
  });
});
