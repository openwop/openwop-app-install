/**
 * ADR 0104 Phase 2 — the super-admin agent tool-allowlist admin HTTP surface.
 * Drives the real app: super-admin gate on every route, list dispatchable agents,
 * read manifest/override/effective + tool catalog, upsert + clear an override
 * (full-replace), validation, and a 404 for an unknown/invisible agent.
 *
 * Tracker TST-BKW-2. The superadmin gate is witnessed with an AUTHENTICATED
 * non-superadmin (an anonymous cookie session, cookies ON): with cookies off the
 * auth middleware answered 401 before the route's gate ran, so the old case
 * could not fail. Red when `requireSuperadmin` stops gating (403 message), the
 * tool-id / array validation is dropped (exact messages), `effective` stops
 * unioning the ADR 0315 default-on baseline, the default-on list changes, the
 * clear-twice 404 or the unknown-agent 404 goes — each sabotage-witnessed (w65).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

describe('agent-allowlists admin routes (sqlite memory app)', () => {
  let server: http.Server;
  let BASE: string;
  const TOKEN = 'dev-token'; // wildcard bearer ⇒ superadmin
  const ADMIN = '/host/openwop-app/agent-allowlists/admin';

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    // Cookies ON: a bearer-less request becomes an anonymous (non-superadmin)
    // session that REACHES the route, so the superadmin refusal is observable.
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    delete process.env.OPENWOP_SUPERADMIN_TENANTS;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  async function call<T = unknown>(method: string, path: string, body?: unknown, auth = true): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (auth) headers.authorization = `Bearer ${TOKEN}`;
    const res = await fetch(`${BASE}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const raw = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: raw as T };
  }

  it('rejects a non-super-admin caller on every route (403, the superadmin refusal)', async () => {
    const REFUSAL = 'Agent tool-allowlist administration requires a superadmin principal.';
    const enc = encodeURIComponent('core.openwop.agents.supervisor.default');
    const legs: Array<[string, string, unknown]> = [
      ['GET', `${ADMIN}/agents`, undefined],
      ['GET', `${ADMIN}/agents/${enc}`, undefined],
      ['PUT', `${ADMIN}/agents/${enc}`, { toolAllowlist: ['openwop:x'] }],
      ['DELETE', `${ADMIN}/agents/${enc}`, undefined],
    ];
    for (const [method, path, body] of legs) {
      const r = await call<{ error?: string; message?: string }>(method, path, body, false);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.body.message, `${method} ${path}`).toBe(REFUSAL);
    }
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

    const before = await call<{ manifestAllowlist: string[]; override: unknown; effective: string[]; baseline: string[]; toolCatalog: string[] }>('GET', `${ADMIN}/agents/${enc}`);
    expect(before.status).toBe(200);
    expect(before.body.override).toBeNull();
    // ADR 0315 — with no override, `effective` is manifest ∪ the default-on
    // baseline (the same resolver the dispatch path uses), so the panel
    // pre-checks the six default-on tools and a save can't strip them.
    expect(before.body.baseline).toEqual([
      'openwop:runs.diagnose', // ADR 0476 — read-only grounded failure context
      'openwop:kanban.add-todo', 'openwop:documents.draft', 'openwop:email.draft',
      'openwop:notifications.notify-me', 'openwop:tasks.schedule-followup',
      'openwop:tasks.schedule-recurring', // chat-first-port A3
      'openwop:ai.research.web',
      'openwop:walkthroughs.register-draft', // ADR 0374 P3
    ]);
    expect(new Set(before.body.effective)).toEqual(new Set([...target.manifestAllowlist, ...before.body.baseline]));
    for (const id of before.body.baseline) expect(before.body.effective).toContain(id);
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
    const reverted = await call<{ override: unknown; effective: string[]; baseline: string[] }>('GET', `${ADMIN}/agents/${enc}`);
    expect(reverted.body.override).toBeNull();
    // Back to manifest ∪ baseline (clearing the override restores the default-on tools).
    expect(new Set(reverted.body.effective)).toEqual(new Set([...target.manifestAllowlist, ...reverted.body.baseline]));
    expect((await call('DELETE', `${ADMIN}/agents/${enc}`)).status).toBe(404);
  });

  it('validates the override body (bad tool id and non-array → 400)', async () => {
    const list = await call<{ agents: Array<{ agentId: string }> }>('GET', `${ADMIN}/agents`);
    const enc = encodeURIComponent(list.body.agents[0]!.agentId);
    const badId = await call<{ error?: string; message?: string }>('PUT', `${ADMIN}/agents/${enc}`, { toolAllowlist: ['not-a-tool-id'] });
    expect(badId.status).toBe(400);
    expect(badId.body).toMatchObject({ error: 'validation_error', message: 'Invalid tool id `not-a-tool-id` — expected `openwop:<id>`.' });
    // A string is refused by the ARRAY check, not char-by-char by the tool-id check.
    const notArray = await call<{ error?: string; message?: string }>('PUT', `${ADMIN}/agents/${enc}`, { toolAllowlist: 'nope' });
    expect(notArray.status).toBe(400);
    expect(notArray.body).toMatchObject({ error: 'validation_error', message: '`toolAllowlist` MUST be an array of tool ids.' });
  });

  it('404s an unknown agent on read and write (no existence leak)', async () => {
    const enc = encodeURIComponent('does.not.exist.agent');
    expect((await call('GET', `${ADMIN}/agents/${enc}`)).status).toBe(404);
    expect((await call('PUT', `${ADMIN}/agents/${enc}`, { toolAllowlist: ['openwop:x'] })).status).toBe(404);
    expect((await call('DELETE', `${ADMIN}/agents/${enc}`)).status).toBe(404);
  });
});
