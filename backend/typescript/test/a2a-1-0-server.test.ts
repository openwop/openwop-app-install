/**
 * ADR 0552 P2 / RFC 0152 §D — the host AS an A2A 1.0 server, at the wire.
 *
 * The host half of the RFC-named `a2a-1.0-task-roundtrip` scenario, asserted
 * against a real HTTP boot rather than the codec in isolation: `SendMessage`
 * creates a REAL run and `Task.id` IS that run id (RFC 0100), which the
 * conformance leg checks by resolving `GET /v1/runs/{Task.id}` for the same
 * principal. A codec that minted its own task id would pass every unit test and
 * hand a peer an id that resolves to nothing.
 *
 * @see spec/v1/a2a-integration.md §"A2A 1.0 versioned composition" §D.1, §D.4
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';
const PATH = '/v1/host/openwop-app/a2a';

interface ErrorInfo {
  '@type'?: string;
  reason?: string;
  domain?: string;
  metadata?: Record<string, string>;
}

interface Rpc {
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string; data?: ErrorInfo[] };
}

/**
 * ADR 0744 — A2A 1.0.1 §9.5: `error.data` is an `Any[]` carrying ONE
 * `google.rpc.ErrorInfo` in the `a2a-protocol.org` domain. Asserts the whole
 * shape (so a regression to the bare `{ reason }` object reds here) and hands
 * back the reason.
 */
function reasonOf(error: Rpc['error']): string | undefined {
  expect(Array.isArray(error?.data), `error.data must be an Any[] (A2A 1.0.1 §9.5), got ${JSON.stringify(error?.data)}`).toBe(true);
  const info = error!.data!.find((d) => d['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo');
  expect(info?.domain).toBe('a2a-protocol.org');
  return info?.reason;
}

async function rpc10(method: string, params: unknown, id = 1): Promise<Rpc> {
  const res = await fetch(`${BASE}${PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      'A2A-Version': '1.0',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Rpc;
}

function message(text: string, messageId: string): Record<string, unknown> {
  return { messageId, role: 'ROLE_USER', parts: [{ text }] };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_A2A_SERVER_ENABLED = 'true';
  process.env.OPENWOP_A2A_DURABLE_TASKS = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  delete process.env.OPENWOP_A2A_SERVER_ENABLED;
  delete process.env.OPENWOP_A2A_DURABLE_TASKS;
  await new Promise<void>((res) => server.close(() => res()));
});

const STATES_10 = [
  'TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING', 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED',
  'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED',
];

describe('RFC 0152 §D.1 — SendMessage creates a run and returns { task }', () => {
  it('Task.id IS the backing runId, and GET /v1/runs resolves it for the same principal', async () => {
    const sent = await rpc10('SendMessage', {
      message: message('drive a run over a2a 1.0', `m-${Date.now()}`),
      configuration: { returnImmediately: true },
    });
    expect(sent.error).toBeUndefined();
    const task = sent.result?.task as { id?: string; status?: { state?: string }; kind?: unknown; history?: unknown[] };
    expect(task).toBeDefined();
    // 1.0 removed the discriminator; a `kind` here means the 0.3 projection leaked.
    expect(task.kind).toBeUndefined();
    expect(STATES_10).toContain(task.status?.state);

    // THE load-bearing assertion: the id the peer got is a run it can read.
    const snap = await fetch(`${BASE}/v1/runs/${encodeURIComponent(task.id!)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(snap.status, 'Task.id must be the backing runId (RFC 0100)').toBe(200);

    // history[] carries A2A Messages only, in the 1.0 shape.
    for (const m of (task.history ?? []) as Array<{ role?: string; parts?: Array<Record<string, unknown>> }>) {
      expect(['ROLE_USER', 'ROLE_AGENT']).toContain(m.role);
      for (const p of m.parts ?? []) expect(p.kind).toBeUndefined();
    }
  });

  it('is idempotent on (principal, messageId) — a retry returns the FIRST task', async () => {
    // §D.2 / RFC 0150 §A: "a repeated `SendMessage` with the same (peer
    // principal, messageId) MUST NOT create a second run."
    const messageId = `idem-${Date.now()}`;
    const first = await rpc10('SendMessage', { message: message('once', messageId) }, 1);
    const second = await rpc10('SendMessage', { message: message('once', messageId) }, 2);
    const a = (first.result?.task as { id?: string }).id;
    const b = (second.result?.task as { id?: string }).id;
    expect(a).toBeDefined();
    expect(b, 'a retried messageId minted a second run').toBe(a);
  });

  it('requires message.messageId — it is the idempotency seed, not decoration', async () => {
    const sent = await rpc10('SendMessage', { message: { role: 'ROLE_USER', parts: [{ text: 'x' }] } });
    expect(sent.result).toBeUndefined();
    expect(reasonOf(sent.error)).toBe('CONTENT_TYPE_NOT_SUPPORTED');
  });
});

describe('RFC 0152 §D.1/§D.7 — GetTask and CancelTask', () => {
  it('GetTask reads the task back with the same id and a 1.0 state', async () => {
    const sent = await rpc10('SendMessage', { message: message('read me back', `m-get-${Date.now()}`) });
    const id = (sent.result?.task as { id?: string }).id!;
    const got = await rpc10('GetTask', { id }, 2);
    expect(got.error).toBeUndefined();
    expect((got.result as { id?: string }).id).toBe(id);
    expect(STATES_10).toContain((got.result as { status?: { state?: string } }).status?.state);
  });

  it('an unknown id is TASK_NOT_FOUND (-32001), never a different answer', async () => {
    const missing = await rpc10('GetTask', { id: `run_does_not_exist_${Date.now()}` }, 3);
    expect(missing.error?.code).toBe(-32001);
    expect(reasonOf(missing.error)).toBe('TASK_NOT_FOUND');
  });

  it('CancelTask cancels the backing run; a second cancel is TASK_NOT_CANCELABLE', async () => {
    const sent = await rpc10('SendMessage', { message: message('cancel me', `m-cancel-${Date.now()}`) });
    const id = (sent.result?.task as { id?: string }).id!;
    const cancelled = await rpc10('CancelTask', { id }, 4);
    expect(cancelled.error).toBeUndefined();
    expect((cancelled.result as { status?: { state?: string } }).status?.state).toBe('TASK_STATE_CANCELED');
    // The run itself moved, not just the projection.
    const snap = await fetch(`${BASE}/v1/runs/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect((await snap.json() as { status?: string }).status).toBe('cancelled');
    // §D.7 — cancelling a terminal task is an error, not a quiet success. (The
    // REST route answers a repeat cancel with 200 because a human means "make
    // sure"; a peer's repeat is a contract violation upstream names.)
    const again = await rpc10('CancelTask', { id }, 5);
    expect(reasonOf(again.error)).toBe('TASK_NOT_CANCELABLE');
  });

  it('ListTasks returns this tenant\'s tasks, 1.0-shaped', async () => {
    const sent = await rpc10('SendMessage', { message: message('list me', `m-list-${Date.now()}`) });
    const id = (sent.result?.task as { id?: string }).id!;
    const listed = await rpc10('ListTasks', {}, 6);
    expect(listed.error).toBeUndefined();
    const tasks = (listed.result as { tasks?: Array<{ id?: string; kind?: unknown }> }).tasks ?? [];
    expect(tasks.map((t) => t.id)).toContain(id);
    for (const t of tasks) expect(t.kind).toBeUndefined();
  });
});

describe('RFC 0152 §D.1 — operations this host does not implement fail typed', () => {
  it('a 0.3 method name under a 1.0 header is method-not-found, not silently served', async () => {
    const legacy = await rpc10('message/send', { agentId: 'x', message: { parts: [] } }, 7);
    expect(legacy.result).toBeUndefined();
    expect(legacy.error?.code).toBe(-32601);
    expect(legacy.error?.message).toContain('0.3 name');
  });

  it('SubscribeToTask is UNSUPPORTED_OPERATION while capabilities.streaming is false', async () => {
    // The card advertises `streaming` from the same flag, so this is the card's
    // own claim enforced — not a second policy that could disagree with it.
    const sub = await rpc10('SubscribeToTask', { id: 'anything' }, 8);
    expect(reasonOf(sub.error)).toBe('UNSUPPORTED_OPERATION');
  });

  // ADR 0744 H6 — A2A 1.0.1 §3.3.4: with push NOT advertised, every one of the
  // four push-config operations is PushNotificationNotSupportedError (-32003),
  // never -32601 (openwop suite leg `a2a-push-unadvertised-refused`). The flag
  // is read per request, the same one the card's `capabilities.pushNotifications`
  // is derived from, so toggling it here toggles the advertisement too.
  it('unadvertised push: all four push-config methods are -32003 PUSH_NOTIFICATION_NOT_SUPPORTED', async () => {
    const saved = process.env.OPENWOP_A2A_DURABLE_TASKS;
    delete process.env.OPENWOP_A2A_DURABLE_TASKS;
    try {
      const methods: Array<[string, unknown]> = [
        ['CreateTaskPushNotificationConfig', { taskId: 't', url: 'https://example.com/hook' }],
        ['GetTaskPushNotificationConfig', { taskId: 't', id: 'c' }],
        ['ListTaskPushNotificationConfigs', { taskId: 't' }],
        ['DeleteTaskPushNotificationConfig', { taskId: 't', id: 'c' }],
      ];
      for (const [method, params] of methods) {
        const r = await rpc10(method, params, 20);
        expect(r.error?.code, `${method} must be -32003 when push is unadvertised`).toBe(-32003);
        expect(reasonOf(r.error), method).toBe('PUSH_NOTIFICATION_NOT_SUPPORTED');
      }
    } finally {
      if (saved !== undefined) process.env.OPENWOP_A2A_DURABLE_TASKS = saved;
    }
  });

  it('advertised push: Get/List/Delete are typed UNSUPPORTED_OPERATION, never method-not-found', async () => {
    for (const method of ['GetTaskPushNotificationConfig', 'ListTaskPushNotificationConfigs', 'DeleteTaskPushNotificationConfig']) {
      const r = await rpc10(method, { taskId: 't', id: 'c' }, 21);
      expect(r.error?.code, method).not.toBe(-32601);
      expect(reasonOf(r.error), method).toBe('UNSUPPORTED_OPERATION');
    }
  });

  it('GetExtendedAgentCard is EXTENDED_AGENT_CARD_NOT_CONFIGURED', async () => {
    const ext = await rpc10('GetExtendedAgentCard', {}, 9);
    expect(reasonOf(ext.error)).toBe('EXTENDED_AGENT_CARD_NOT_CONFIGURED');
  });

  it('a message INTO a running task is refused, never silently dropped', async () => {
    // §D.2: "the host MUST NOT silently drop the message: it MUST either
    // deliver it through a declared input path or return
    // UnsupportedOperationError." Resuming a HITL gate over A2A is P3.
    const sent = await rpc10('SendMessage', { message: message('open', `m-into-${Date.now()}`) });
    const id = (sent.result?.task as { id?: string }).id!;
    const into = await rpc10('SendMessage', { message: { ...message('more', `m-into2-${Date.now()}`), taskId: id } }, 10);
    expect(into.result).toBeUndefined();
    expect(reasonOf(into.error)).toBe('UNSUPPORTED_OPERATION');
  });
});
