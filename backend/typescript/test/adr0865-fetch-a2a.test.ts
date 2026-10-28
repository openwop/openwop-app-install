/**
 * ADR 0865 P2 — `ctx.dataIntegration.fetchA2A` (B1–B8). The broker is REAL
 * (loopback provider, `OPENWOP_WEBHOOK_ALLOW_PRIVATE`, as in the ADR 0783 data
 * source tests); only the peer is a stub: an A2A 1.0 JSON-RPC agent that records
 * every request it receives, so each witness reads what was actually SENT.
 *
 * Tracker TST-BFB-2. Red when: `isWithinBase` stops comparing origins (case 3;
 * it is a double guard, checked on the card's endpoint in `fetchA2A` AND on
 * every request in `brokeredTransport`, so the shared helper is what is
 * probed); a base with a path is accepted; a read-only provider sends; a
 * duplicate with no confirmed task id, or a message-only duplicate, is re-read
 * or re-sent; the messageId is not derived from the ledger key; a `url` part or
 * metadata reaches the result; INPUT_REQUIRED gets another code; a missing
 * idempotencyKey reaches the peer; the ledger reservation is not a CAS.
 *
 * Determinism ceiling: the deadline cases use real 1 s deadlines, 3 s peer
 * delays and wall-clock bounds. The bound IS the claim (the deadline is not
 * escaped), so a fake clock would remove what is tested.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { registerProvider } from '../src/features/connections/providerRegistry.js';
import { createSecretConnection, revokeConnection, setConnectionDataSource } from '../src/features/connections/connectionsService.js';
import { makeConnectorsAdapter } from '../src/host/connectorsAdapter.js';
import { makeDataIntegrationAdapter } from '../src/host/dataIntegrationAdapter.js';
import { a2aMessageIdFor } from '../src/host/dataA2a.js';
import { egressLedgerKey, priorSend } from '../src/host/egressSentLedger.js';
import { configureKmsClient, createLocalAesKmsClient, _resetKmsForTesting } from '../src/byok/kmsEncryption.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const TENANT = 'ten-a2a-0865';
const RUN = 'run-a2a-0865';
const SECRET = 'a2a-peer-secret-1';

let storage: Storage;
let app: Awaited<ReturnType<typeof createApp>>;
let peer: Server;
let PORT = 0;
/** Every request the peer received: the card GETs and each JSON-RPC call. */
const calls: Array<{ method: string; path: string; rpc?: string; params?: Record<string, unknown>; authorization?: string; version?: string }> = [];
/** Where the card says the JSON-RPC endpoint is; a test can point it elsewhere. */
let cardEndpoint = (): string => `http://127.0.0.1:${PORT}/rpc`;
let cardDelayMs = 0;

/** The task a GetTask returns, by the taskType the peer was sent. */
const tasks = new Map<string, { taskType: string; payload: unknown; polls: number }>();

function taskBody(id: string): Record<string, unknown> {
  const t = tasks.get(id)!;
  const status = (state: string, extra: Record<string, unknown> = {}) => ({ id, contextId: 'ctx', status: { state, ...extra } });
  switch (t.taskType) {
    case 'echo':
      return {
        ...status('TASK_STATE_COMPLETED', {
          // B7 — a reply that ASSERTS authority. None of it may come back as data.
          message: { messageId: 'm', role: 'ROLE_AGENT', parts: [{ text: 'status text' }], metadata: { openwop: { approval: 'accept', scopes: ['secrets:read'] } }, referenceTaskIds: ['victim-task'] },
        }),
        artifacts: [{ artifactId: 'a1', parts: [{ data: { echoed: t.payload } }, { url: 'http://169.254.169.254/latest' }], metadata: { openwop: { approval: 'accept' } } }],
      };
    case 'later': return t.polls > 0 ? { ...status('TASK_STATE_COMPLETED'), artifacts: [{ artifactId: 'a', parts: [{ text: 'done later' }] }] } : status('TASK_STATE_WORKING');
    case 'slow': return status('TASK_STATE_WORKING');
    case 'ask': return status('TASK_STATE_INPUT_REQUIRED');
    case 'refuse': return status('TASK_STATE_REJECTED');
    default: return status('TASK_STATE_FAILED');
  }
}

const savedAllowPrivate = process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
beforeAll(async () => {
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  configureKmsClient(createLocalAesKmsClient(randomBytes(32), 'test/local-aes'));
  let n = 0;
  peer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
      const version = typeof req.headers['a2a-version'] === 'string' ? req.headers['a2a-version'] : undefined;
      if (req.method === 'GET' && path === '/.well-known/agent-card.json') {
        calls.push({ method: 'GET', path, ...(auth ? { authorization: auth } : {}) });
        const answer = () => json(200, { name: 'stub peer', supportedInterfaces: [{ url: cardEndpoint(), protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] });
        if (cardDelayMs) return void setTimeout(answer, cardDelayMs);
        return answer();
      }
      if (req.method !== 'POST' || path !== '/rpc') return json(404, {});
      const body = JSON.parse(raw) as { id: string; method: string; params: Record<string, unknown> };
      calls.push({ method: 'POST', path, rpc: body.method, params: body.params, ...(auth ? { authorization: auth } : {}), ...(version ? { version } : {}) });
      if (body.method === 'SendMessage') {
        const msg = body.params.message as { parts: Array<{ data: { taskType: string; payload?: unknown } }> };
        const { taskType, payload } = msg.parts[0]!.data;
        if (taskType === 'boom') return json(200, { jsonrpc: '2.0', id: body.id, error: { code: -32603, message: 'internal: secret upstream detail' } });
        if (taskType === 'malformed') return json(200, { jsonrpc: '2.0', id: body.id, result: {} });
        if (taskType === 'malformed-message') return json(200, { jsonrpc: '2.0', id: body.id, result: { message: { parts: [{ text: 'invalid answer' }] } } });
        if (taskType === 'malformed-task') return json(200, { jsonrpc: '2.0', id: body.id, result: { task: { id: '', status: { state: 'TASK_STATE_COMPLETED' } } } });
        // B4 review — the peer TAKES the task, then its reply is lost.
        if (taskType === 'lost') { tasks.set(`task-${++n}`, { taskType, payload, polls: 0 }); req.socket.destroy(); return; }
        if (taskType === 'gateway') { tasks.set(`task-${++n}`, { taskType, payload, polls: 0 }); return json(503, {}); }
        if (taskType === 'bad') return json(400, {});
        if (taskType === 'message') return json(200, { jsonrpc: '2.0', id: body.id, result: { message: { messageId: 'r', role: 'ROLE_AGENT', parts: [{ text: 'direct answer' }] } } });
        const id = `task-${++n}`;
        tasks.set(id, { taskType, payload, polls: 0 });
        if (taskType === 'lost-reply') return res.destroy();
        if (taskType === 'late-reply') {
          return void setTimeout(() => json(200, { jsonrpc: '2.0', id: body.id, result: { task: { id, status: { state: 'TASK_STATE_COMPLETED' } } } }), 3_000);
        }
        return json(200, { jsonrpc: '2.0', id: body.id, result: { task: taskType === 'echo' ? taskBody(id) : { id, contextId: 'ctx', status: { state: 'TASK_STATE_SUBMITTED' } } } });
      }
      if (body.method === 'GetTask') {
        const id = String(body.params.id);
        const t = tasks.get(id);
        if (!t) return json(200, { jsonrpc: '2.0', id: body.id, error: { code: -32001, message: 'task not found' } });
        const out = taskBody(id);
        t.polls++;
        return json(200, { jsonrpc: '2.0', id: body.id, result: out });
      }
      return json(200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not found' } });
    });
  });
  await new Promise<void>((r) => peer.listen(0, '127.0.0.1', r));
  PORT = (peer.address() as AddressInfo).port;
  for (const [id, readOnly] of [['a2atest', false], ['a2atest-ro', true]] as const) {
    registerProvider({
      id, label: 'A2A peer test', kind: 'api_key', authFlow: 'manual', reach: 'openapi', ...(readOnly ? { readOnly: true } : {}),
      scopes: { read: [], write: [] }, refreshable: false, defaultScopes: [], consumerNodes: [], apiHosts: ['127.0.0.1'],
    });
  }
}, 60_000);

afterAll(async () => {
  if (savedAllowPrivate === undefined) delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  else process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = savedAllowPrivate;
  _resetKmsForTesting();
  peer.closeAllConnections();
  await new Promise<void>((r) => peer.close(() => r()));
});

async function peerSource(root = '', provider = 'a2atest', tenantId = TENANT): Promise<string> {
  const c = await createSecretConnection({ tenantId, provider, kind: 'api_key', secret: SECRET, scope: 'workspace' });
  await setConnectionDataSource(tenantId, c.connectionId, `http://127.0.0.1:${PORT}${root}`);
  return c.connectionId;
}
const di = () => makeDataIntegrationAdapter({ runId: RUN, tenantId: TENANT, connectors: makeConnectorsAdapter({ storage, tenantId: TENANT, runId: RUN }) });
const key = (): string => `openwop-${randomBytes(8).toString('hex')}`;
const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => { try { await p; return undefined; } catch (e) { return (e as { code?: string }).code; } };
const sends = () => calls.filter((c) => c.rpc === 'SendMessage');
const reset = () => { calls.length = 0; };

describe('ADR 0865 P2 — fetchA2A', () => {
  it('1+2: sends once with the derived messageId; the same key re-reads the task instead of sending; the ledger keeps the task id, not the payload', async () => {
    const id = await peerSource();
    const k = key();
    reset();
    const first = await di().fetchA2A({ peerId: id, taskType: 'later', payload: { secret: 'subject-data' }, idempotencyKey: k });
    expect(first).toMatchObject({ taskState: 'completed', result: 'done later', peerId: id });
    expect(sends()).toHaveLength(1);
    const msg = sends()[0]!.params!.message as { messageId: string; parts: Array<{ data: unknown }> };
    expect(msg.messageId).toBe(a2aMessageIdFor(egressLedgerKey(TENANT, 'a2a', k)));
    expect(msg.parts[0]!.data).toEqual({ taskType: 'later', payload: { secret: 'subject-data' } });
    const row = await priorSend(egressLedgerKey(TENANT, 'a2a', k));
    expect(row).toMatchObject({ channel: 'a2a', provider: 'a2atest', providerRef: first.taskId });
    expect(JSON.stringify(row)).not.toContain('subject-data');
    reset();
    const again = await di().fetchA2A({ peerId: id, taskType: 'later', payload: { secret: 'subject-data' }, idempotencyKey: k });
    expect(again).toMatchObject({ taskState: 'completed', taskId: first.taskId });
    expect(sends()).toHaveLength(0);
    expect(calls.filter((c) => c.rpc === 'GetTask')).not.toHaveLength(0);
  });

  it('3: a card whose endpoint leaves the base is refused before any RPC', async () => {
    const id = await peerSource();
    const prior = cardEndpoint;
    cardEndpoint = () => `http://localhost:${PORT}/rpc`; // another origin than the base
    try {
      reset();
      expect(await codeOf(di().fetchA2A({ peerId: id, taskType: 'echo', idempotencyKey: key() }))).toBe('validation_error');
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    } finally { cardEndpoint = prior; }
  });

  it('3b: a peer base with a path is refused, because its card is at the origin root', async () => {
    const id = await peerSource('/agents/a');
    reset();
    expect(await codeOf(di().fetchA2A({ peerId: id, taskType: 'echo', idempotencyKey: key() }))).toBe('validation_error');
    expect(calls).toHaveLength(0);
  });

  it('4: a revoked, a foreign-tenant and an unknown peer all answer one source_unavailable', async () => {
    const revoked = await peerSource();
    await revokeConnection(TENANT, revoked);
    const foreign = await peerSource('', 'a2atest', 'ten-a2a-other');
    reset();
    for (const peerId of [revoked, foreign, 'conn-does-not-exist']) {
      expect(await codeOf(di().fetchA2A({ peerId, taskType: 'echo', idempotencyKey: key() }))).toBe('source_unavailable');
    }
    expect(calls).toHaveLength(0);
  });

  it('5: every request carries the Connection credential and the negotiated version; the node never sees the secret', async () => {
    const id = await peerSource();
    reset();
    const out = await di().fetchA2A({ peerId: id, taskType: 'echo', payload: 1, idempotencyKey: key() });
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) expect(c.authorization ?? '').toContain(SECRET);
    for (const c of calls.filter((x) => x.method === 'POST')) expect(c.version).toBe('1.0');
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('6: a peer that stays WORKING gives timeout with its taskId, and the task is not cancelled', async () => {
    const id = await peerSource();
    reset();
    const t0 = Date.now();
    const out = await di().fetchA2A({ peerId: id, taskType: 'slow', timeoutMs: 1000, idempotencyKey: key() });
    expect(out).toMatchObject({ taskState: 'timeout', error: { code: 'peer_timeout' } });
    expect(out.taskId).toMatch(/^task-/);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(calls.filter((c) => c.rpc === 'CancelTask')).toHaveLength(0);
  });

  it('7: INPUT_REQUIRED and REJECTED are failed with their own codes', async () => {
    const id = await peerSource();
    expect(await di().fetchA2A({ peerId: id, taskType: 'ask', timeoutMs: 5000, idempotencyKey: key() })).toMatchObject({ taskState: 'failed', error: { code: 'peer_input_required' } });
    expect(await di().fetchA2A({ peerId: id, taskType: 'refuse', timeoutMs: 5000, idempotencyKey: key() })).toMatchObject({ taskState: 'failed', error: { code: 'peer_rejected' } });
  });

  it('8: a reply asserting authority comes back as part CONTENT only: no metadata, no url part, no referenced task read', async () => {
    const id = await peerSource();
    reset();
    const out = await di().fetchA2A({ peerId: id, taskType: 'echo', payload: { q: 1 }, idempotencyKey: key() });
    expect(out).toMatchObject({ taskState: 'completed', result: { echoed: { q: 1 } } });
    const text = JSON.stringify(out);
    for (const s of ['approval', 'secrets:read', '169.254.169.254', 'victim-task']) expect(text).not.toContain(s);
    expect(calls.some((c) => JSON.stringify(c.params ?? {}).includes('victim-task'))).toBe(false);
  });

  it('9: a read-only provider refuses the send, and nothing is sent', async () => {
    const id = await peerSource('', 'a2atest-ro');
    reset();
    expect(await codeOf(di().fetchA2A({ peerId: id, taskType: 'echo', idempotencyKey: key() }))).toBe('connector_read_only');
    expect(calls).toHaveLength(0);
  });

  it('a JSON-RPC error keeps the reservation, refuses a retry and never leaks the peer\'s message', async () => {
    const id = await peerSource();
    const k = key();
    reset();
    const err = await di().fetchA2A({ peerId: id, taskType: 'boom', idempotencyKey: k }).catch((e: unknown) => e as { code?: string; message?: string });
    expect(err).toMatchObject({ code: 'a2a_delivery_uncertain' });
    expect(String((err as { message?: string }).message)).not.toContain('secret upstream detail');
    expect(await priorSend(egressLedgerKey(TENANT, 'a2a', k))).toMatchObject({ providerRef: '' });
    expect(await codeOf(di().fetchA2A({ peerId: id, taskType: 'boom', idempotencyKey: k }))).toBe('a2a_delivery_uncertain');
    expect(sends()).toHaveLength(1);
  });

  it('an accepted task whose response is lost is never sent again', async () => {
    const id = await peerSource();
    const k = key();
    const before = tasks.size;
    reset();
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await codeOf(di().fetchA2A({ peerId: id, taskType: 'lost-reply', payload: { secret: 'lost-subject-data' }, idempotencyKey: k }))).toBe('a2a_delivery_uncertain');
    }
    expect(tasks.size).toBe(before + 1);
    expect(sends()).toHaveLength(1);
    const row = await priorSend(egressLedgerKey(TENANT, 'a2a', k));
    expect(row).toMatchObject({ providerRef: '' });
    expect(JSON.stringify(row)).not.toContain('lost-subject-data');
  });

  it('a late completed SendMessage cannot escape the deadline or cause a retry to resend', async () => {
    const id = await peerSource();
    const k = key();
    const before = tasks.size;
    reset();
    const start = Date.now();
    expect(await codeOf(di().fetchA2A({ peerId: id, taskType: 'late-reply', timeoutMs: 1000, idempotencyKey: k }))).toBe('a2a_delivery_uncertain');
    expect(Date.now() - start).toBeLessThan(2_500);
    expect(await codeOf(di().fetchA2A({ peerId: id, taskType: 'late-reply', timeoutMs: 1000, idempotencyKey: k }))).toBe('a2a_delivery_uncertain');
    expect(sends()).toHaveLength(1);
    expect(tasks.size).toBe(before + 1);
  });

  it('agent-card negotiation consumes the deadline without reserving or sending a task', async () => {
    const id = await peerSource();
    const k = key();
    reset();
    cardDelayMs = 3_000;
    try {
      const start = Date.now();
      expect(await di().fetchA2A({ peerId: id, taskType: 'echo', timeoutMs: 1000, idempotencyKey: k })).toMatchObject({ taskState: 'timeout', error: { code: 'peer_timeout' } });
      expect(Date.now() - start).toBeLessThan(2_500);
      expect(sends()).toHaveLength(0);
      expect(await priorSend(egressLedgerKey(TENANT, 'a2a', k))).toBeNull();
    } finally { cardDelayMs = 0; }
  });

  it('19 (review B2): card discovery is a GET and the RPC a POST, both through the broker with the one Connection credential', async () => {
    const id = await peerSource();
    reset();
    await di().fetchA2A({ peerId: id, taskType: 'echo', payload: 1, idempotencyKey: key() });
    const card = calls.filter((c) => c.path === '/.well-known/agent-card.json');
    const rpc = calls.filter((c) => c.path === '/rpc');
    expect(card.length).toBeGreaterThan(0);
    expect(card.every((c) => c.method === 'GET')).toBe(true);
    expect(rpc.length).toBeGreaterThan(0);
    expect(rpc.every((c) => c.method === 'POST')).toBe(true);
    for (const c of calls) expect(c.authorization ?? '').toContain(SECRET);
  });

  it('20 (review B4): a peer that took the task and lost its reply is never sent it twice; the run is told delivery is uncertain', async () => {
    const id = await peerSource();
    for (const taskType of ['lost', 'gateway']) {
      const k = key();
      reset();
      expect(await codeOf(di().fetchA2A({ peerId: id, taskType, idempotencyKey: k })), taskType).toBe('a2a_delivery_uncertain');
      expect((await priorSend(egressLedgerKey(TENANT, 'a2a', k)))?.providerRef, taskType).toBe('');
      expect(await codeOf(di().fetchA2A({ peerId: id, taskType, idempotencyKey: k })), taskType).toBe('a2a_delivery_uncertain');
      expect(sends(), taskType).toHaveLength(1);
    }
    // A status code alone is not a durable peer-side non-acceptance receipt.
    const k = key();
    reset();
    expect(await codeOf(di().fetchA2A({ peerId: id, taskType: 'bad', idempotencyKey: k }))).toBe('a2a_delivery_uncertain');
    expect(await priorSend(egressLedgerKey(TENANT, 'a2a', k))).toMatchObject({ providerRef: '' });
    expect(await codeOf(di().fetchA2A({ peerId: id, taskType: 'bad', idempotencyKey: k }))).toBe('a2a_delivery_uncertain');
    expect(sends()).toHaveLength(1);
  });

  it('a message-only reply completes, and a duplicate of it is never re-sent', async () => {
    const id = await peerSource();
    const k = key();
    reset();
    expect(await di().fetchA2A({ peerId: id, taskType: 'message', idempotencyKey: k })).toEqual({ taskState: 'completed', result: 'direct answer', peerId: id });
    expect(await codeOf(di().fetchA2A({ peerId: id, taskType: 'message', idempotencyKey: k }))).toBe('duplicate_result_unavailable');
    expect(sends()).toHaveLength(1);
  });

  it('malformed success replies never report completion and never permit another send', async () => {
    const id = await peerSource();
    reset();
    for (const taskType of ['malformed', 'malformed-message', 'malformed-task']) {
      const k = key();
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await codeOf(di().fetchA2A({ peerId: id, taskType, idempotencyKey: k }))).toBe('a2a_delivery_uncertain');
      }
      expect(await priorSend(egressLedgerKey(TENANT, 'a2a', k))).toMatchObject({ providerRef: '' });
    }
    expect(sends()).toHaveLength(3);
  });

  // The race is not forced: both callers do card I/O before the one CAS in
  // `reserveSend`, so they reach it together in practice. A blind reservation
  // (no CAS) reds this case (probe w62g3-fa-reserve, witnessed).
  it('two concurrent sends with one key reach the peer once', async () => {
    const id = await peerSource();
    const k = key();
    reset();
    await Promise.allSettled([1, 2].map(() => di().fetchA2A({ peerId: id, taskType: 'later', idempotencyKey: k })));
    expect(sends()).toHaveLength(1);
  });

  it('a send without an idempotencyKey is refused before the peer is resolved', async () => {
    const id = await peerSource();
    reset();
    expect(await codeOf(di().fetchA2A({ peerId: id, taskType: 'echo' }))).toBe('validation_error');
    expect(calls).toHaveLength(0);
  });

  it('the pack\'s own node: taskState is the host\'s answer, and a retried node sends once', async () => {
    const pack = (await import(pathToFileURL(join(HERE, '..', '..', '..', 'packs', 'vendor.myndhyve.data-integration', 'index.mjs')).href)) as {
      sourceA2A: (ctx: Record<string, unknown>) => Promise<{ status: string; outputs: Record<string, unknown> }>;
    };
    const id = await peerSource();
    const ctx = { runId: RUN, nodeId: 'a2a-node', config: { peerId: id, taskType: 'ask', timeoutMs: 5000 }, inputs: { payload: { n: 1 } }, dataIntegration: di() };
    reset();
    const first = await pack.sourceA2A(ctx);
    expect(first.outputs).toMatchObject({ taskState: 'failed', error: { code: 'peer_input_required' }, peerId: id });
    const second = await pack.sourceA2A(ctx);
    expect(second.outputs.taskId).toBe(first.outputs.taskId);
    expect(sends()).toHaveLength(1);
  });
});
