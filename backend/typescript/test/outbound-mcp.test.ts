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
import { registerProvider } from '../src/features/connections/providerRegistry.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { setGovernancePolicy, __resetGovernanceStore } from '../src/host/governanceService.js';

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
