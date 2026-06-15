/**
 * ADR 0035 / RFC 0100 — the durable A2A leg over HTTP. Boots the real app with
 * OPENWOP_A2A_SERVER_ENABLED + OPENWOP_A2A_DURABLE_TASKS and asserts:
 *   - the `a2a` capability slot advertises durableTasks/streaming/push = true
 *     (the capability is advertised only WHEN wired);
 *   - message/send persists a Task that tasks/get returns after "disconnect";
 *   - tasks/resubscribe re-attaches a status-update event.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/index.js';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';

const PORT = 18273;
const BASE = `http://127.0.0.1:${PORT}`;
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
const A2A_URL = `${BASE}/v1/host/openwop-app/a2a`;
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', '..');
const SUPERVISOR = 'core.openwop.agents.supervisor.default';

let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_A2A_SERVER_ENABLED = 'true';
  process.env.OPENWOP_A2A_DURABLE_TASKS = 'true';
  const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  loadAgentsFromManifest(join(REPO_ROOT, 'packs', 'core.openwop.agents.supervisor'));
  await new Promise<void>((res) => { server = app.listen(PORT, res); });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_A2A_SERVER_ENABLED;
  delete process.env.OPENWOP_A2A_DURABLE_TASKS;
});

const rpc = (method: string, params?: unknown, id: string | number = 1) =>
  fetch(A2A_URL, { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });

describe('ADR 0035 / RFC 0100 — durable A2A server over HTTP', () => {
  it('advertises the a2a slot with durableTasks/streaming/push = true (wired)', async () => {
    const doc = await (await fetch(`${BASE}/.well-known/openwop`, { headers: H })).json() as {
      capabilities?: { a2a?: { supported?: boolean; agentCardUrl?: string; streaming?: boolean; pushNotifications?: boolean; durableTasks?: boolean } };
    };
    const a2a = doc.capabilities?.a2a;
    expect(a2a?.supported).toBe(true);
    expect(a2a?.durableTasks).toBe(true);
    expect(a2a?.streaming).toBe(true);
    expect(a2a?.pushNotifications).toBe(true);
    expect(a2a?.agentCardUrl).toMatch(/\/v1\/host\/openwop-app\/a2a$/);
  });

  it('message/send persists a Task; tasks/get returns it after disconnect', async () => {
    const sendBody = await (await rpc('message/send', { agentId: SUPERVISOR, message: { parts: [{ kind: 'text', text: 'begin' }] } })).json() as {
      result?: { kind?: string; id?: string };
    };
    expect(sendBody.result?.kind).toBe('task');
    const taskId = sendBody.result?.id as string;
    expect(taskId).toBe(`a2a:${SUPERVISOR}`);

    // "Disconnect" then query later — durable tasks/get returns the live state.
    const getBody = await (await rpc('tasks/get', { id: taskId })).json() as {
      result?: { kind?: string; id?: string; status?: { state?: string } };
    };
    expect(getBody.result?.kind).toBe('task');
    expect(getBody.result?.id).toBe(taskId);
    expect(['completed', 'input-required', 'failed']).toContain(getBody.result?.status?.state);
  });

  it('tasks/resubscribe re-attaches a status-update event', async () => {
    await rpc('message/send', { agentId: SUPERVISOR, message: { parts: [{ kind: 'text', text: 'begin' }] } });
    const body = await (await rpc('tasks/resubscribe', { id: `a2a:${SUPERVISOR}` })).json() as {
      result?: { kind?: string; taskId?: string };
    };
    expect(body.result?.kind).toBe('status-update');
    expect(body.result?.taskId).toBe(`a2a:${SUPERVISOR}`);
  });
});
