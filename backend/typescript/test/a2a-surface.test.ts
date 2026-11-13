/**
 * `ctx.a2a` host surface (RFC 0076 §A `host.a2a`) — black-box against a mock
 * A2A 0.3 peer. Proves the client does real JSON-RPC-over-HTTP, normalizes the
 * wire's lowercase-hyphen `TaskState` to the pack's UPPERCASE_UNDERSCORE
 * vocabulary, parses the SSE stream, and surfaces remote JSON-RPC errors.
 *
 * The mock peer is a raw node:http server so the test exercises the real fetch
 * transport (not a stub) — `spec/v1/a2a-integration.md` is the contract. The
 * peer's card is 0.3-only, so the client negotiates the ADR 0552 P2 downgrade
 * and speaks 0.3 method names.
 *
 * ADR 1045 D3 (CHAN-P6-3): the surface has NO workflow-side server methods, so
 * the pack's emit/push nodes fail typed and card publish reports nothing published.
 *
 * Tracker TST-BG1-11. Red when (probe-witnessed, waves 58 and 107):
 * `normalizeResult` stops upper-casing state, stops turning `-` into `_`, or stops
 * mapping a `tasks` list; the agent-card path list loses the 0.3 path; the
 * extended-card follow-up is skipped; a remote error is mis-coded; SSE events are
 * not forwarded; card discovery failure loses `a2a_transport_error`; push-config
 * create drops `pushNotificationConfig`; any one of `emitStatus`, `emitArtifact`,
 * `pushSend` or `publishAgentCard` is put back on `createA2aSurface`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createA2aSurface } from '../src/host/a2aSurface.js';

const AGENT_CARD = {
  name: 'Mock A2A Agent',
  description: 'test peer',
  version: '0.3.0',
  protocolVersion: '0.3.0',
  capabilities: { streaming: true },
};

function task(state: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'task-1', contextId: 'ctx-1', status: { state }, kind: 'task', ...extra };
}

async function readBody(req: IncomingMessage): Promise<{ method: string; id: unknown; params: unknown }> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res: ServerResponse, id: unknown, result: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

function sendRpcError(res: ServerResponse, id: unknown, message: string): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }));
}

let server: Server;
let baseUrl: string;
/** The params the peer received on its last push-config set (what the client SENT). */
let lastPushParams: unknown;
/** The escape hatch's value before this file set it, restored in afterAll. */
let priorAllowPrivate: string | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    // Agent-card discovery (A2A 0.3 path, then the legacy fallback path).
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(AGENT_CARD));
      return;
    }
    if (req.method === 'GET' && req.url === '/.well-known/agent.json') {
      res.writeHead(404).end();
      return;
    }
    // JSON-RPC endpoint.
    if (req.method === 'POST') {
      void readBody(req).then((body) => {
        switch (body.method) {
          case 'message/send':
            return sendJson(res, body.id, task('completed', { history: [body.params] }));
          case 'tasks/get': {
            const id = (body.params as { id?: string } | undefined)?.id;
            if (id === 'boom') return sendRpcError(res, body.id, 'deliberate failure');
            return sendJson(res, body.id, task('input-required'));
          }
          case 'tasks/cancel':
            return sendJson(res, body.id, task('canceled'));
          case 'tasks/list':
            return sendJson(res, body.id, { tasks: [task('working'), task('completed')] });
          case 'tasks/pushNotificationConfig/set':
            lastPushParams = body.params;
            return sendJson(res, body.id, { taskId: 'task-1', pushNotificationConfigId: 'cfg-1' });
          case 'message/stream': {
            // SSE: a non-terminal status update, then a terminal task.
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            const frame = (result: unknown): string => `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`;
            res.write(frame({ taskId: 'task-1', kind: 'status-update', status: { state: 'working' }, final: false }));
            res.write(frame(task('completed')));
            res.end();
            return;
          }
          case 'agent/getAuthenticatedExtendedCard':
            return sendJson(res, body.id, { ...AGENT_CARD, name: 'Mock A2A Agent (extended)' });
          case 'boom':
            return sendRpcError(res, body.id, 'deliberate failure');
          default:
            return sendRpcError(res, body.id, `unknown method ${body.method}`);
        }
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The A2A client egress is now SSRF-guarded (2026-07 vuln-scan M1); permit the
  // loopback test server via the documented dev/test escape.
  priorAllowPrivate = process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
});

afterAll(async () => {
  if (priorAllowPrivate === undefined) delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  else process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = priorAllowPrivate;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('category: host.a2a discovery', () => {
  it('fetches the A2A 0.3 agent card', async () => {
    const a2a = createA2aSurface({ tenantId: 't1' });
    const card = (await a2a.discoverAgent(baseUrl)) as { name: string };
    expect(card.name).toBe('Mock A2A Agent');
  });

  it('upgrades to the authenticated extended card when requested', async () => {
    const a2a = createA2aSurface({ tenantId: 't1' });
    const card = (await a2a.discoverAgent(baseUrl, { extended: true })) as { name: string };
    expect(card.name).toBe('Mock A2A Agent (extended)');
  });
});

describe('category: host.a2a task lifecycle (state normalization)', () => {
  it('sendMessage normalizes wire `completed` → COMPLETED', async () => {
    const a2a = createA2aSurface({ tenantId: 't1' });
    const result = (await a2a.sendMessage({ baseUrl, message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }] } })) as { status: { state: string } };
    expect(result.status.state).toBe('COMPLETED');
  });

  it('getTask normalizes wire `input-required` → INPUT_REQUIRED', async () => {
    const a2a = createA2aSurface({ tenantId: 't1' });
    const result = (await a2a.getTask({ baseUrl, taskId: 'task-1' })) as { status: { state: string } };
    expect(result.status.state).toBe('INPUT_REQUIRED');
  });

  it('cancelTask normalizes wire `canceled` → CANCELED', async () => {
    const a2a = createA2aSurface({ tenantId: 't1' });
    const result = (await a2a.cancelTask({ baseUrl, taskId: 'task-1' })) as { status: { state: string } };
    expect(result.status.state).toBe('CANCELED');
  });

  it('listTasks returns the task list (each state normalized)', async () => {
    const a2a = createA2aSurface({ tenantId: 't1' });
    const result = (await a2a.listTasks({ baseUrl })) as { tasks: Array<{ status: { state: string } }> };
    expect(result.tasks.map((t) => t.status.state)).toEqual(['WORKING', 'COMPLETED']);
  });
});

describe('category: host.a2a streaming', () => {
  it('sendAndStream forwards each SSE event and returns the terminal task', async () => {
    const a2a = createA2aSurface({ tenantId: 't1' });
    const seen: string[] = [];
    const terminal = (await a2a.sendAndStream(
      { baseUrl, message: { role: 'user', parts: [{ kind: 'text', text: 'stream' }] } },
      (ev) => { seen.push(((ev as { status?: { state?: string } }).status?.state) ?? '?'); },
    )) as { status: { state: string } };
    // working (non-terminal) then COMPLETED (terminal) — both normalized.
    expect(seen).toEqual(['WORKING', 'COMPLETED']);
    expect(terminal.status.state).toBe('COMPLETED');
  });
});

describe('category: host.a2a push-notification config', () => {
  it('pushConfig.create round-trips a config id', async () => {
    lastPushParams = undefined;
    const a2a = createA2aSurface({ tenantId: 't1' });
    const result = (await a2a.pushConfig.create({ baseUrl, taskId: 'task-1', pushNotificationConfig: { url: 'https://cb.example/hook' } })) as { pushNotificationConfigId: string };
    expect(result.pushNotificationConfigId).toBe('cfg-1');
    expect(lastPushParams).toEqual({ taskId: 'task-1', pushNotificationConfig: { url: 'https://cb.example/hook' } });
  });
});

describe('category: host.a2a error surfacing', () => {
  it('surfaces a remote JSON-RPC error as an a2a_remote_error', async () => {
    const a2a = createA2aSurface({ tenantId: 't1' });
    await expect(a2a.getTask({ baseUrl, taskId: 'boom' })).rejects.toMatchObject({ code: 'a2a_remote_error' });
  });

  it('throws a transport error when the agent card is unreachable', async () => {
    const a2a = createA2aSurface({ tenantId: 't1' });
    await expect(a2a.discoverAgent('http://127.0.0.1:1/')).rejects.toMatchObject({ code: 'a2a_transport_error' });
  });
});

// ADR 1045 D3 (CHAN-P6-3) — the four workflow-side server methods were stubs
// that reported success for actions they did not take (publishAgentCard kept the
// card in process memory, emitStatus/emitArtifact were no-ops, pushSend always
// answered delivered:false). They are withdrawn. This drives the REAL pack nodes
// against the real surface: each emit/push node must now fail TYPED
// (`host_capability_missing`) rather than succeed, and card publish must say it
// published nothing. Sabotage-witnessed 2026-11-03, and again per method in wave
// 107: restoring any ONE of the four stubs on `createA2aSurface` reds its own
// assertion (the node resolves with status success / published:true).
describe('ADR 1045 D3 — host.a2a has no workflow-side server methods', () => {
  const PACK = new URL('../../../packs/core.openwop.a2a/index.mjs', import.meta.url).href;
  const ctxFor = (inputs: Record<string, unknown>) => ({
    a2a: createA2aSurface({ tenantId: 't1' }),
    inputs,
    config: {},
  });

  it('emit-status, emit-artifact and push-send fail with host_capability_missing', async () => {
    const pack = await import(PACK) as Record<string, (ctx: unknown) => Promise<unknown>>;
    // Exact message, not just the code: the pack's `ensure()` refusal ("host does not
    // expose ctx.a2a") shares `host_capability_missing`. That the REAL surface is what
    // is consulted is the per-method probes' job (`w107g2-a2a-stub-*`).
    await expect(pack.emitStatus!(ctxFor({ taskId: 'task-1', status: 'working' }))).rejects.toMatchObject({ code: 'host_capability_missing', message: 'host does not implement ctx.a2a.emitStatus' });
    await expect(pack.emitArtifact!(ctxFor({ taskId: 'task-1', artifact: {} }))).rejects.toMatchObject({ code: 'host_capability_missing', message: 'host does not implement ctx.a2a.emitArtifact' });
    await expect(pack.pushSend!(ctxFor({ configId: 'cfg-1', event: {} }))).rejects.toMatchObject({ code: 'host_capability_missing', message: 'host does not implement ctx.a2a.pushSend' });
  });

  it('agent-card-publish reports published:false (the surface has no publishAgentCard)', async () => {
    const pack = await import(PACK) as Record<string, (ctx: unknown) => Promise<{ status: string; outputs: { card: unknown; published: boolean } }>>;
    const out = await pack.agentCardPublish!(ctxFor({ card: AGENT_CARD }));
    expect(out.outputs.published).toBe(false);
    expect(out.outputs.card).toEqual(AGENT_CARD);
  });
});
