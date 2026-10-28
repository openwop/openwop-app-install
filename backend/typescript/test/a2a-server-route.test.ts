/**
 * A7 / RFC 0076 §A — the live A2A SERVER endpoint over HTTP. Boots the real app
 * with OPENWOP_A2A_SERVER_ENABLED=true and exercises the ROUTE (the handler's
 * own mechanism is `a2a-server.test.ts`):
 *   - agent/getCard returns a real (registry-synthesized) card, not a dead stub
 *   - message/send routes to a real manifest-agent dispatch → terminal A2A task
 *   - JSON-RPC errors ride an HTTP 200 transport with the request id echoed
 *   - with durable Tasks off the route serves the SYNCHRONOUS core: a task the
 *     peer just opened is still not-found on tasks/get
 *   - 404 when the server endpoint is disabled
 * (ADR 0812 P3c-0 deleted the two v1-discovery advertisement legs.)
 *
 * Tracker TST-BG1-9. Red when (probe-witnessed, wave 58): the disabled-endpoint
 * 404 is removed; the 0.3 card's skills drop pack agents; the missing-agentId
 * code changes; the route passes `durableTasks: true` to the 0.3 codec.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/index.js';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';

let BASE: string;
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
let A2A_URL: string;
// test/ → backend/typescript → backend → repo root. (Wave 58: this used FIVE
// `..`, which resolved outside the repo, so the load below was a silent no-op.)
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
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
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  loadAgentsFromManifest(join(REPO_ROOT, 'packs', 'core.openwop.agents.supervisor'));
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; A2A_URL = `${BASE}/host/openwop-app/a2a`; res(); }); });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_A2A_SERVER_ENABLED;
});

interface RpcBody {
  id?: string | number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

const rpc = (method: string, params?: unknown, id: string | number = 1) =>
  fetch(A2A_URL, { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });

describe('A7 / RFC 0076 — live A2A server endpoint', () => {
  // ADR 0812 P3c-0: the two discovery legs ("advertises a live A2A server
  // endpoint" via `hostSurfaces[host.a2a]`, and the `capabilities.a2a` slot) were
  // deleted — both read v1-document facets the v2 discovery document does not
  // carry. The live endpoint itself is exercised by every leg below.

  it('agent/getCard returns a registry-synthesized card with skills', async () => {
    const res = await rpc('agent/getCard');
    expect(res.status).toBe(200);
    const body = await res.json() as { result?: { name?: string; skills?: Array<{ id?: string }> } };
    expect(body.result?.name).toBe('openwop-reference-host');
    expect(Array.isArray(body.result?.skills)).toBe(true);
    expect((body.result?.skills ?? []).some((s) => s.id === SUPERVISOR)).toBe(true);
  });

  it('message/send routes to a real manifest-agent dispatch → terminal task', async () => {
    // Fixture guard: the dispatch below needs this agent registered.
    expect(getAgentRegistry().has(SUPERVISOR), `${SUPERVISOR} is not registered`).toBe(true);
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
    // The route's transport contract: a JSON-RPC error is HTTP 200 with the id echoed.
    const res = await rpc('message/send', { message: { parts: [] } }, 41);
    expect(res.status).toBe(200);
    const body = await res.json() as RpcBody;
    expect(body.id).toBe(41);
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.message).toBe('params.agentId is required');
  });

  it('tasks/get → not found in the synchronous core', async () => {
    // Open a task FIRST, then ask for that same id: the synchronous core keeps no
    // store, so it is still not-found. A route that wired durable Tasks on would
    // answer it (a missing id alone could not tell the two apart).
    const sent = await (await rpc('message/send', { agentId: SUPERVISOR, message: { parts: [{ kind: 'text', text: 'begin' }] } })).json() as RpcBody;
    const opened = (sent.result as { id?: string } | undefined)?.id;
    expect(opened).toBe(`a2a:${SUPERVISOR}`);
    const body = await (await rpc('tasks/get', { id: opened })).json() as RpcBody;
    expect(body.result).toBeUndefined();
    expect(body.error?.code).toBe(-32001);
    expect(body.error?.message).toContain('synchronous server keeps no task store');
  });

  it('unknown method → method not found (-32601)', async () => {
    const res = await rpc('agent/doesNotExist', undefined, 43);
    expect(res.status).toBe(200);
    const body = await res.json() as RpcBody;
    expect(body.id).toBe(43);
    expect(body.error?.code).toBe(-32601);
    expect(body.error?.message).toBe('method not found: agent/doesNotExist');
  });

  it('404s when the server endpoint is disabled', async () => {
    delete process.env.OPENWOP_A2A_SERVER_ENABLED;
    try {
      const res = await rpc('agent/getCard');
      expect(res.status).toBe(404);
      expect((await res.json() as { error?: string }).error).toBe('not_found');
    } finally {
      process.env.OPENWOP_A2A_SERVER_ENABLED = 'true';
    }
  });
});
