/**
 * RFC 0070 end-to-end: the reference workflow-engine host loads a manifest
 * agent and dispatches it over HTTP. Boots the real app via createApp, seeds
 * the AgentRegistry from the on-disk supervisor pack (the same loadAgents path
 * bootstrap uses), then exercises the live routes:
 *   - GET  /host/openwop-app/agents               (registry-backed inventory)
 *   - POST /host/openwop-app/agents/{id}/dispatch (the dispatch floor)
 * and confirms the host advertises capabilities.agents.manifestRuntime.
 *
 * w73 g4: REPO_ROOT used to climb FIVE directories from backend/typescript/test/
 * (two above the repo root), so `loadAgentsFromManifest` read a nonexistent dir
 * and silently returned [] — the "guarantee" below was dead, and the supervisor
 * was present only because boot loaded it. It now climbs three, and the case
 * asserts the root holds a known repo file AND that the load returned the agent.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/index.js';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';

let BASE: string;
const TOKEN = 'dev-token';
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'OpenWOP-Version': '2' };
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const SUPERVISOR = 'core.openwop.agents.supervisor.default';

let server: http.Server;
let loadedIds: string[] = [];

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  // Guarantee a known agent is installed regardless of local-mount config in CI.
  loadedIds = loadAgentsFromManifest(join(REPO_ROOT, 'packs', 'core.openwop.agents.supervisor')).map((a) => a.agentId);
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 120_000);

afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('RFC 0070 — host loads + dispatches a manifest agent over HTTP', () => {
  it('the test really installs the supervisor from the repo packs tree (positive control)', () => {
    expect(existsSync(join(REPO_ROOT, 'packs', 'core.openwop.agents.supervisor', 'pack.json'))).toBe(true);
    expect(existsSync(join(REPO_ROOT, 'backend', 'typescript', 'package.json'))).toBe(true);
    expect(loadedIds).toContain(SUPERVISOR);
  });

  it('advertises capabilities.agents.manifestRuntime', async () => {
    // ADR 0812 P3c-0 — the v2 document: presence of the facet IS the advert
    // (the v1 `capabilities.agents.manifestRuntime.supported` is retired).
    const doc = await (await fetch(`${BASE}/.well-known/openwop`, { headers: H })).json() as {
      agents?: { status?: string; manifestRuntime?: Record<string, unknown> };
    };
    expect(doc?.agents?.status).toBeTypeOf('string');
    // The v2 facet object itself (MEASURED at 9f4cca7d4): handoff validation on.
    expect(doc?.agents?.manifestRuntime).toEqual({ handoffValidation: true });
    expect(doc?.agents?.manifestRuntime?.['supported']).toBeUndefined();
  });

  it('serves the NORMATIVE inventory GET /agents (RFC 0072 §A)', async () => {
    const list = await (await fetch(`${BASE}/agents`, { headers: H })).json() as {
      agents?: Array<{ agentId?: string }>; total?: number;
    };
    expect(Array.isArray(list.agents)).toBe(true);
    expect(list.total).toBe(list.agents?.length);
    expect((list.agents ?? []).some((a) => a.agentId === SUPERVISOR)).toBe(true);
    // GET /agents/{agentId}
    const one = await fetch(`${BASE}/agents/${encodeURIComponent(SUPERVISOR)}`, { headers: H });
    expect(one.status).toBe(200);
    expect(((await one.json()) as { agentId?: string }).agentId).toBe(SUPERVISOR);
    // 404 for unknown
    const missing = await fetch(`${BASE}/agents/core.nope.absent`, { headers: H });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found', message: "agent 'core.nope.absent' is not installed on this host" });
  });

  it('serves the registry-backed inventory including the installed agent', async () => {
    const body = await (await fetch(`${BASE}/host/openwop-app/agents`, { headers: H })).json() as {
      runtime?: { manifestRuntime?: boolean }; agents?: Array<{ agentId?: string }>;
    };
    expect(body.runtime?.manifestRuntime).toBe(true);
    expect((body.agents ?? []).some((a) => a.agentId === SUPERVISOR)).toBe(true);
  });

  it('dispatches the agent end-to-end with attributed events', async () => {
    const res = await fetch(`${BASE}/host/openwop-app/agents/${encodeURIComponent(SUPERVISOR)}/dispatch`, {
      method: 'POST', headers: H, body: JSON.stringify({ task: {}, validateHandoff: false }),
    });
    expect(res.status).toBe(200);
    const r = await res.json() as { status?: string; events?: Array<{ type?: string; agentId?: string }> };
    expect(r.status).toBe('completed');
    expect((r.events ?? []).map((e) => e.type)).toEqual(['agent.reasoned', 'agent.decided']);
    expect((r.events ?? []).every((e) => e.agentId === SUPERVISOR)).toBe(true);
  });

  it('escalates a sub-threshold dispatch (RFC 0002 §F)', async () => {
    const res = await fetch(`${BASE}/host/openwop-app/agents/${encodeURIComponent(SUPERVISOR)}/dispatch`, {
      method: 'POST', headers: H, body: JSON.stringify({ task: {}, validateHandoff: false, simulateConfidence: 0.01, confidenceThreshold: 0.99 }),
    });
    expect(res.status).toBe(200);
    const r = await res.json() as { status?: string; result?: unknown };
    expect(r.status).toBe('escalated');
    expect(r.result).toBeUndefined();
  });

  it('404s an unknown agent', async () => {
    const res = await fetch(`${BASE}/host/openwop-app/agents/core.nope.absent/dispatch`, {
      method: 'POST', headers: H, body: JSON.stringify({ task: {} }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', message: "agent 'core.nope.absent' is not installed on this host" });
  });
});
