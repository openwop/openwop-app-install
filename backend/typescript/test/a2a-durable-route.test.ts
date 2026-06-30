/**
 * ADR 0035 / RFC 0100 — the durable A2A leg over HTTP. Boots the real app with
 * OPENWOP_A2A_SERVER_ENABLED + OPENWOP_A2A_DURABLE_TASKS and asserts:
 *   - the `a2a` capability slot advertises durableTasks/push = true, streaming
 *     = false (decoupled onto OPENWOP_A2A_STREAMING; advertised only WHEN wired);
 *   - message/send persists a Task that tasks/get returns after "disconnect";
 *   - tasks/resubscribe re-attaches a status-update event.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/index.js';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';

let BASE: string;
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
let A2A_URL: string;
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', '..');
const SUPERVISOR = 'core.openwop.agents.supervisor.default';

let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_A2A_SERVER_ENABLED = 'true';
  process.env.OPENWOP_A2A_DURABLE_TASKS = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  loadAgentsFromManifest(join(REPO_ROOT, 'packs', 'core.openwop.agents.supervisor'));
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; A2A_URL = `${BASE}/v1/host/openwop-app/a2a`; res(); }); });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_A2A_SERVER_ENABLED;
  delete process.env.OPENWOP_A2A_DURABLE_TASKS;
});

const rpc = (method: string, params?: unknown, id: string | number = 1) =>
  fetch(A2A_URL, { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });

describe('ADR 0035 / RFC 0100 — durable A2A server over HTTP', () => {
  it('advertises the a2a slot with durableTasks/push = true, streaming = false (wired)', async () => {
    const doc = await (await fetch(`${BASE}/.well-known/openwop`, { headers: H })).json() as {
      capabilities?: { a2a?: { supported?: boolean; agentCardUrl?: string; streaming?: boolean; pushNotifications?: boolean; durableTasks?: boolean } };
    };
    const a2a = doc.capabilities?.a2a;
    expect(a2a?.supported).toBe(true);
    expect(a2a?.durableTasks).toBe(true);
    expect(a2a?.pushNotifications).toBe(true);
    // `streaming` is decoupled from `durableTasks` onto OPENWOP_A2A_STREAMING
    // (default off) → advertised `false`: conformance 1.34.0 ships no
    // `tasks/resubscribe` gated subtest, so `streaming:true` would be vacuous.
    expect(a2a?.streaming).toBe(false);
    expect(a2a?.agentCardUrl).toMatch(/\/\.well-known\/agent-card\.json$/);
  });

  it('GET /.well-known/agent-card.json serves a public v0.3 AgentCard (no credential)', async () => {
    // The agentCardUrl honesty bar: a plain GET — no Authorization header —
    // resolves to a real A2A v0.3 card (protocolVersion + skills).
    const res = await fetch(`${BASE}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    const card = await res.json() as { protocolVersion?: string; skills?: unknown[]; url?: string };
    expect(card.protocolVersion).toBe('0.3');
    expect(Array.isArray(card.skills)).toBe(true);
  });

  it('mounts the durable seams at the spec-canonical /v1/host/sample/a2a alias', async () => {
    // The 1.34.0 conformance driver hits the literal `sample` namespace; the
    // same handler is mounted there too (mirrors the RFC 0106 transcriber alias).
    const start = await fetch(`${BASE}/v1/host/sample/a2a/tasks/start`, {
      method: 'POST', headers: H, body: JSON.stringify({ scenario: 'paused-at-approval' }),
    });
    expect(start.status).toBe(201);
    const { taskId } = await start.json() as { taskId?: string };
    expect(typeof taskId).toBe('string');
    // The task is readable back through the sample-alias GET, projected input-required.
    const get = await fetch(`${BASE}/v1/host/sample/a2a/tasks/${taskId}`, { headers: H });
    expect(get.status).toBe(200);
    const rec = await get.json() as { state?: string; runId?: string };
    expect(rec.state).toBe('input-required');
    expect(rec.runId).toBe(taskId); // taskId == runId (RFC 0100 §2)
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
