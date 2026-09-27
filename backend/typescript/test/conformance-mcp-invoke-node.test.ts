/**
 * H21 — `core.conformance.mcp-invoke`, the MCP invoke bridge the
 * `conformance-mcp-tool-roundtrip` fixture resolves to.
 *
 * H47 — the loader rewrite that used to put the fixture on this bridge is
 * DELETED (the corpus renamed the fixture's node to the reserved id at suite
 * 1.136.0). The second describe block below is what replaced its coverage.
 *
 * Black-box against a raw `node:http` JSON-RPC server so the bridge exercises
 * the REAL outbound client (`makeMcpClient` — provider resolution, the ADR 0028
 * governance gate, the H21 operator credential, the RFC 0093 egress dispatcher,
 * the ADR 0027 untrusted marking) rather than a stub. A stub returning canned
 * content would satisfy the conformance scenario's event-log assertion while
 * proving nothing about the trust boundary that scenario measures.
 *
 * Why this exists at host tier when the conformance suite covers it: the suite
 * covers it only while the fake server is running, and the server being
 * unstarted is exactly how this leg went unmeasured — `conformance/run.ts` never
 * set `OPENWOP_MCP_FAKE_SERVER`, so `getMcpFakeServer()` was null and the
 * host-mediated leg soft-skipped `blocked` every run. A leg that returns early
 * is not a leg that passes.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { NodeContext } from '../src/executor/types.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { makeMcpClient } from '../src/host/mcpClient.js';
import {
  CONFORMANCE_MCP_INVOKE_TYPE_ID,
  registerConformanceMcpInvokeNode,
} from '../src/bootstrap/conformanceMcpInvokeNode.js';
import { CONFORMANCE_A2A_INVOKE_TYPE_ID } from '../src/bootstrap/conformanceA2aInvokeNode.js';
import {
  registerOperatorMcpServer,
  _resetOperatorMcpRegistration,
} from '../src/host/mcpOperatorServer.js';
import { __resetConnectionsStore } from '../src/features/connections/connectionsService.js';
import { __resetGovernanceStore } from '../src/host/governanceService.js';

const ROUNDTRIP_FIXTURE = 'conformance-mcp-tool-roundtrip';

let server: Server;
let storage: Storage;
let baseUrl: string;
let lastCall: { method?: string; name?: unknown; args?: unknown } = {};

async function readBody(req: IncomingMessage): Promise<{ id: unknown; method: string; params?: Record<string, unknown> }> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = 'true';

  server = createServer((req, res) => {
    void readBody(req).then((body) => {
      lastCall = { method: body.method, name: body.params?.name, args: body.params?.arguments };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: body.method === 'tools/call'
          ? { content: [{ type: 'text', text: String((body.params?.arguments as { text?: string } | undefined)?.text ?? '') }], isError: false }
          : {},
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const app = await createApp({ port: 18973, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await __resetConnectionsStore();
  await __resetGovernanceStore();
  await storage.insertRun({ runId: 'run-mcpbridge', workflowId: 'w', tenantId: 'tmcpb', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
});

afterAll(async () => {
  delete process.env.OPENWOP_MCP_SERVER_URL;
  _resetOperatorMcpRegistration();
  await new Promise<void>((r) => server.close(() => r()));
});

afterEach(() => {
  lastCall = {};
});

/** A NodeContext carrying the REAL outbound client. */
function ctxWith(config: Record<string, unknown>): NodeContext {
  return {
    runId: 'run-mcpbridge',
    nodeId: 'mcp-call',
    tenantId: 'tmcpb',
    config,
    inputs: {},
    mcp: makeMcpClient({ storage, tenantId: 'tmcpb', runId: 'run-mcpbridge', actingUserId: 'u1', orgId: 'tmcpb' }),
  } as unknown as NodeContext;
}

async function runBridge(config: Record<string, unknown>): Promise<{ status: string; outputs?: Record<string, unknown>; error?: { code?: string } }> {
  registerConformanceMcpInvokeNode();
  const mod = getNodeRegistry().get(CONFORMANCE_MCP_INVOKE_TYPE_ID);
  expect(mod, 'the bridge node must be registered when conformance nodes are enabled').toBeTruthy();
  return (await mod!.execute(ctxWith(config))) as { status: string; outputs?: Record<string, unknown>; error?: { code?: string } };
}

describe('core.conformance.mcp-invoke (H21)', () => {
  it('invokes the OPERATOR-configured server and returns the untrusted-marked result', async () => {
    process.env.OPENWOP_MCP_SERVER_URL = baseUrl;
    _resetOperatorMcpRegistration();
    registerOperatorMcpServer();

    const out = await runBridge({ mcp: { tool: 'echo', arguments: { text: 'roundtrip-probe' } } });

    // Reached the wire — the assertion the conformance scenario makes, made
    // here against a server whose received frame we can read.
    expect(lastCall.method).toBe('tools/call');
    expect(lastCall.name).toBe('echo');
    expect(lastCall.args).toEqual({ text: 'roundtrip-probe' });

    expect(out.status).toBe('success');
    expect(out.outputs?.tool).toBe('echo');
    expect(out.outputs?.isError).toBe(false);
    expect(out.outputs?.result).toEqual([{ type: 'text', text: 'roundtrip-probe' }]);
    // The marker must travel INTO the node outputs — that is what puts it in the
    // run's event log, where an observer attributes the content to the server.
    expect(out.outputs?.untrustedContent).toBe(true);
  });

  it('fails TYPED when no MCP server is configured — never success-with-empty', async () => {
    delete process.env.OPENWOP_MCP_SERVER_URL;
    _resetOperatorMcpRegistration();
    const out = await runBridge({ mcp: { tool: 'echo', arguments: {} } });
    expect(out.status).toBe('failure');
    expect(out.error?.code).toBe('mcp_server_not_configured');
    expect(lastCall.method, 'nothing may reach a server when none is configured').toBeUndefined();
  });

  it('fails TYPED when the node declares no tool', async () => {
    process.env.OPENWOP_MCP_SERVER_URL = baseUrl;
    _resetOperatorMcpRegistration();
    registerOperatorMcpServer();
    const out = await runBridge({ mcp: {} });
    expect(out.status).toBe('failure');
    expect(out.error?.code).toBe('mcp_tool_not_configured');
  });
});

/**
 * H47 — what replaced the loader rewrite.
 *
 * The rewrite is gone (the corpus renamed the fixture's node to the reserved id
 * at suite 1.136.0 / openwop#1060 S33, and the pin moved to `^1.136.0`). With no
 * rewrite in front of the loader, the fixture reaches the bridge only if the
 * VENDORED copy carries the reserved id — so the vendored copy is now the whole
 * mechanism, and these are its guards.
 *
 * The trap this closes: the npm pin and the vendored fixture set are TWO
 * independent inputs. `conformance-fixtures/` is synced from the corpus by
 * `scripts/sync-fixtures.sh`, NOT from `node_modules`, and the host reads only
 * the vendored dir. Bumping the pin alone would leave the host loading the old
 * spelling while every version string said 1.136.0 — a deletion that looks
 * justified and is not.
 */
describe('the roundtrip fixtures reach their bridges without a loader rewrite (H47)', () => {
  it('the loaded MCP fixture declares the bridge typeId, not core.ai.callPrompt', async () => {
    // Read through the REAL catalog path a run takes, not a private map.
    const { createHostAdapterSuite } = await import('../src/host/index.js');
    const suite = createHostAdapterSuite({ storage });
    const resolved = await suite.workflowCatalog.getWorkflow(ROUNDTRIP_FIXTURE);
    expect(resolved, `${ROUNDTRIP_FIXTURE} must be loadable — the whole leg is vacuous otherwise`).toBeTruthy();
    const typeIds = (resolved!.definition.nodes ?? []).map((n) => n.typeId);
    expect(typeIds).toContain(CONFORMANCE_MCP_INVOKE_TYPE_ID);
    expect(typeIds, 'the prompt-library node would fail prompt_not_found on this fixture').not.toContain('core.ai.callPrompt');
  });

  it('the loaded A2A fixture declares the reserved typeId, not the deleted core.a2a.invoke alias', async () => {
    const { createHostAdapterSuite } = await import('../src/host/index.js');
    const suite = createHostAdapterSuite({ storage });
    const resolved = await suite.workflowCatalog.getWorkflow('conformance-a2a-task-roundtrip');
    expect(resolved, 'conformance-a2a-task-roundtrip must be loadable').toBeTruthy();
    const typeIds = (resolved!.definition.nodes ?? []).map((n) => n.typeId);
    expect(typeIds).toContain(CONFORMANCE_A2A_INVOKE_TYPE_ID);
    // The alias registration is deleted, so this spelling would now resolve to
    // nothing and fail at dispatch on a fixture the host still advertises.
    expect(typeIds, 'the legacy alias is deleted — this spelling resolves to no node').not.toContain('core.a2a.invoke');
  });

  it('no vendored fixture carries core.ai.callPrompt WITH config.mcp — nothing rewrites it any more', async () => {
    // While the rewrite existed this shape was handled. It is not any more: such
    // a node resolves to the `vendor.myndhyve.ai` prompt-library node, which
    // requires `config.promptId`, ignores `config.mcp` and fails
    // `prompt_not_found` — advertise-and-spuriously-fail, restored. If a future
    // re-vendor reintroduces the shape, this red is the correct outcome.
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(import.meta.dirname, '..', '..', '..', 'conformance-fixtures');
    const docs = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as { id?: string; nodes?: Array<{ typeId?: string; config?: Record<string, unknown> }> });
    expect(docs.length, 'fixture corpus empty — every assertion here would be vacuous').toBeGreaterThan(10);

    const mcpShapedCallPrompt = docs.filter((doc) =>
      (doc.nodes ?? []).some(
        (n) =>
          n.typeId === 'core.ai.callPrompt' &&
          typeof (n.config?.mcp as { tool?: unknown } | undefined)?.tool === 'string',
      ),
    );
    expect(mcpShapedCallPrompt.map((d) => d.id)).toEqual([]);

    // NON-VACUITY: `core.ai.callPrompt` must still appear in the corpus at all,
    // otherwise the filter above is trivially empty for the wrong reason.
    // `conformance-stream-text` is the plain prompt-library user.
    const plainCallPrompt = docs.filter((doc) => (doc.nodes ?? []).some((n) => n.typeId === 'core.ai.callPrompt'));
    expect(
      plainCallPrompt.map((d) => d.id),
      'no core.ai.callPrompt fixture left in the corpus — the filter above is now vacuous',
    ).toContain('conformance-stream-text');
  });

  it('the vendored roundtrip fixtures are byte-identical to the PINNED suite package', async () => {
    // The pin and the vendored dir are independent inputs; this is the only
    // place they are compared. Scoped to the two fixtures whose typeIds this
    // change deleted host code for — the rest of the vendored set has known,
    // separately-tracked drift and is not H47's subject.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const vendored = join(import.meta.dirname, '..', '..', '..', 'conformance-fixtures');
    const pinned = join(import.meta.dirname, '..', 'node_modules', '@openwop', 'openwop-conformance', 'fixtures');
    for (const f of ['conformance-mcp-tool-roundtrip.json', 'conformance-a2a-task-roundtrip.json']) {
      expect(
        readFileSync(join(vendored, f), 'utf8'),
        `${f}: the vendored copy the HOST loads has drifted from the pinned suite — re-vendor it`,
      ).toBe(readFileSync(join(pinned, f), 'utf8'));
    }
  });
});
