/**
 * ADR 0104 Phase 2 — the super-admin agent tool-allowlist admin HTTP surface.
 * Drives the real app: super-admin gate on every route, list dispatchable agents,
 * read manifest/override/effective + tool catalog, upsert + clear an override
 * (full-replace), validation, and a 404 for an unknown/invisible agent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

describe('agent-allowlists admin routes (sqlite memory app)', () => {
  let server: http.Server;
  let BASE: string;
  const TOKEN = 'dev-token'; // wildcard bearer ⇒ superadmin
  const ADMIN = '/v1/host/openwop-app/agent-allowlists/admin';

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  async function call<T = unknown>(method: string, path: string, body?: unknown, auth = true): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (auth) headers.authorization = `Bearer ${TOKEN}`;
    const res = await fetch(`${BASE}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const raw = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: raw as T };
  }

  it('rejects a non-super-admin caller (no bearer ⇒ not 200)', async () => {
    const r = await call('GET', `${ADMIN}/agents`, undefined, false);
    expect([401, 403]).toContain(r.status);
  });

  it('lists dispatchable agents with their manifest allowlist', async () => {
    const r = await call<{ agents: Array<{ agentId: string; manifestAllowlist: string[]; override: unknown }> }>('GET', `${ADMIN}/agents`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Array.isArray(r.body.agents)).toBe(true);
    expect(r.body.agents.length).toBeGreaterThan(0);
    expect(r.body.agents.every((a) => Array.isArray(a.manifestAllowlist))).toBe(true);
  });

  it('reads one agent (manifest + null override + a non-empty tool catalog) and round-trips an override', async () => {
    const list = await call<{ agents: Array<{ agentId: string; manifestAllowlist: string[] }> }>('GET', `${ADMIN}/agents`);
    const target = list.body.agents[0]!;
    const enc = encodeURIComponent(target.agentId);

    const before = await call<{ manifestAllowlist: string[]; override: unknown; effective: string[]; toolCatalog: string[] }>('GET', `${ADMIN}/agents/${enc}`);
    expect(before.status).toBe(200);
    expect(before.body.override).toBeNull();
    expect(before.body.effective).toEqual(target.manifestAllowlist);
    expect(before.body.toolCatalog.length).toBeGreaterThan(0);
    expect(before.body.toolCatalog.every((t) => t.startsWith('openwop:'))).toBe(true);

    // Upsert a full-replace override.
    const put = await call<{ toolAllowlist: string[]; updatedBy: string }>('PUT', `${ADMIN}/agents/${enc}`, { toolAllowlist: ['openwop:test.granted'], note: 'grant for test' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.toolAllowlist).toEqual(['openwop:test.granted']);

    const after = await call<{ override: { toolAllowlist: string[] } | null; effective: string[] }>('GET', `${ADMIN}/agents/${enc}`);
    expect(after.body.override?.toolAllowlist).toEqual(['openwop:test.granted']);
    expect(after.body.effective).toEqual(['openwop:test.granted']);

    // It also shows up on the list.
    const relist = await call<{ agents: Array<{ agentId: string; override: { toolAllowlist: string[] } | null }> }>('GET', `${ADMIN}/agents`);
    expect(relist.body.agents.find((a) => a.agentId === target.agentId)?.override?.toolAllowlist).toEqual(['openwop:test.granted']);

    // Clear → revert to manifest; clearing again → 404.
    expect((await call('DELETE', `${ADMIN}/agents/${enc}`)).status).toBe(204);
    const reverted = await call<{ override: unknown; effective: string[] }>('GET', `${ADMIN}/agents/${enc}`);
    expect(reverted.body.override).toBeNull();
    expect(reverted.body.effective).toEqual(target.manifestAllowlist);
    expect((await call('DELETE', `${ADMIN}/agents/${enc}`)).status).toBe(404);
  });

  it('validates the override body (bad tool id and non-array → 400)', async () => {
    const list = await call<{ agents: Array<{ agentId: string }> }>('GET', `${ADMIN}/agents`);
    const enc = encodeURIComponent(list.body.agents[0]!.agentId);
    expect((await call('PUT', `${ADMIN}/agents/${enc}`, { toolAllowlist: ['not-a-tool-id'] })).status).toBe(400);
    expect((await call('PUT', `${ADMIN}/agents/${enc}`, { toolAllowlist: 'nope' })).status).toBe(400);
  });

  it('404s an unknown agent on read and write (no existence leak)', async () => {
    const enc = encodeURIComponent('does.not.exist.agent');
    expect((await call('GET', `${ADMIN}/agents/${enc}`)).status).toBe(404);
    expect((await call('PUT', `${ADMIN}/agents/${enc}`, { toolAllowlist: ['openwop:x'] })).status).toBe(404);
    expect((await call('DELETE', `${ADMIN}/agents/${enc}`)).status).toBe(404);
  });
});
