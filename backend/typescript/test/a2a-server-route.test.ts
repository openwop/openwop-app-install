/**
 * A7 / RFC 0076 §A — the live A2A SERVER endpoint over HTTP. Boots the real app
 * with OPENWOP_A2A_SERVER_ENABLED=true and exercises POST /v1/host/openwop-app/a2a:
 *   - host.a2a advertises a live server endpoint (honest flip)
 *   - agent/getCard returns a real (registry-synthesized) card, not a dead stub
 *   - message/send routes to a real manifest-agent dispatch → terminal A2A task
 *   - tasks/get is not-found in the synchronous core
 *   - an unknown JSON-RPC method → method-not-found (-32601)
 *   - 404 when the server endpoint is disabled
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/index.js';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';

const PORT = 18272;
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
  // This suite exercises the SYNCHRONOUS core — keep durable Tasks off
  // deterministically (a sibling durable-route suite may set it; env is
  // per-process, so pin it here rather than rely on ordering).
  delete process.env.OPENWOP_A2A_DURABLE_TASKS;
  const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  loadAgentsFromManifest(join(REPO_ROOT, 'packs', 'core.openwop.agents.supervisor'));
  await new Promise<void>((res) => { server = app.listen(PORT, res); });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_A2A_SERVER_ENABLED;
});

const rpc = (method: string, params?: unknown, id: string | number = 1) =>
  fetch(A2A_URL, { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });

describe('A7 / RFC 0076 — live A2A server endpoint', () => {
  it('advertises a live A2A server endpoint (honest host.a2a flip)', async () => {
    const doc = await (await fetch(`${BASE}/.well-known/openwop`, { headers: H })).json() as {
      hostSurfaces?: Array<{ name?: string; note?: string }>;
    };
    const a2a = (doc.hostSurfaces ?? []).find((s) => s.name === 'host.a2a');
    expect(a2a?.note ?? '').toContain('live server endpoint');
  });

  // ADR 0035 / RFC 0100 — the `a2a` capability slot is advertised whenever the
  // host exposes A2A (this suite enables the server). `supported` + a uri
  // `agentCardUrl` are env-independent; the durable sub-flags are asserted in
  // the dedicated a2a-durable-route suite (which controls OPENWOP_A2A_DURABLE_TASKS).
  it('advertises the a2a capability slot when the server is enabled', async () => {
    const doc = await (await fetch(`${BASE}/.well-known/openwop`, { headers: H })).json() as {
      capabilities?: { a2a?: { supported?: boolean; agentCardUrl?: string } };
    };
    const a2a = doc.capabilities?.a2a;
    expect(a2a?.supported).toBe(true);
    expect(typeof a2a?.agentCardUrl).toBe('string');
  });

  it('agent/getCard returns a registry-synthesized card with skills', async () => {
    const res = await rpc('agent/getCard');
    expect(res.status).toBe(200);
    const body = await res.json() as { result?: { name?: string; skills?: Array<{ id?: string }> } };
    expect(body.result?.name).toBe('openwop-reference-host');
    expect(Array.isArray(body.result?.skills)).toBe(true);
    expect((body.result?.skills ?? []).some((s) => s.id === SUPERVISOR)).toBe(true);
  });

  it('message/send routes to a real manifest-agent dispatch → terminal task', async () => {
    const res = await rpc('message/send', {
      agentId: SUPERVISOR,
      message: { parts: [{ kind: 'text', text: 'begin' }] },
    });
    const body = await res.json() as { result?: { kind?: string; status?: { state?: string }; agentId?: string } };
    expect(body.result?.kind).toBe('task');
    expect(body.result?.agentId).toBe(SUPERVISOR);
    expect(['completed', 'input-required', 'failed']).toContain(body.result?.status?.state);
  });

  it('message/send without agentId → invalid params (-32602)', async () => {
    const body = await (await rpc('message/send', { message: { parts: [] } })).json() as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32602);
  });

  it('tasks/get → not found in the synchronous core', async () => {
    const body = await (await rpc('tasks/get', { id: 'a2a:x' })).json() as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32001);
  });

  it('unknown method → method not found (-32601)', async () => {
    const body = await (await rpc('agent/doesNotExist')).json() as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32601);
  });

  it('404s when the server endpoint is disabled', async () => {
    delete process.env.OPENWOP_A2A_SERVER_ENABLED;
    const res = await rpc('agent/getCard');
    expect(res.status).toBe(404);
    process.env.OPENWOP_A2A_SERVER_ENABLED = 'true';
  });
});
