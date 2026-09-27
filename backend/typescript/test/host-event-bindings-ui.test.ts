/**
 * Host-event bindings admin UI — the PATCH toggle route (ADR 0208 §1,
 * "binding the shipped chains is operator-explicit" open question, closed
 * 2026-07-03: the UI ships as an operator-driven CRUD surface, not a seeder).
 *
 * `crm-events.test.ts` already covers POST/GET/DELETE CRUD + the CRM
 * emission/webhook/trigger wiring; this file adds ONLY the new
 * `PATCH /v1/host/openwop-app/host-events/bindings/:bindingId` route the
 * admin UI's enabled-toggle drives: happy path + cross-tenant 404 + the
 * validation 400 for a non-boolean body.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;
let app: Express;
let workflowId: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
  const wellKnown = (await (await fetch(`${BASE}/.well-known/openwop`)).json()) as { fixtures?: string[] };
  workflowId = wellKnown.fixtures?.[0] ?? 'openwop-app.uppercase';
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res<T = any> { status: number; body: T }
interface Client {
  get: (p: string) => Promise<Res>;
  post: (p: string, b?: unknown) => Promise<Res>;
  patch: (p: string, b?: unknown) => Promise<Res>;
}
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const sc = getSetCookies(res.headers);
    for (const c of sc as string[]) {
      const m = /(__session=[^;]+)/.exec(c);
      if (m) cookie = m[1];
    }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

let n = 0;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function signup(c: Client): Promise<{ userId: string; tenantId: string }> {
  const tenantId = `org:test-${Date.now()}-${n++}`;
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('bindui'), tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { userId: r.body.user.userId, tenantId };
}

const BINDINGS = '/v1/host/openwop-app/host-events/bindings';

describe('host-event bindings — PATCH :bindingId (admin-UI enabled toggle)', () => {
  it('flips enabled, stamps updatedAt, and rejects a non-boolean body', async () => {
    const a = client();
    await signup(a);
    const created = await a.post(BINDINGS, { eventType: 'host.crm.contact.created', workflowId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.enabled).toBe(true);

    const badBody = await a.patch(`${BINDINGS}/${created.body.bindingId}`, { enabled: 'nope' });
    expect(badBody.status).toBe(400);

    const disabled = await a.patch(`${BINDINGS}/${created.body.bindingId}`, { enabled: false });
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);
    expect(disabled.body.enabled).toBe(false);
    expect(disabled.body.bindingId).toBe(created.body.bindingId);
    expect(new Date(disabled.body.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(created.body.updatedAt).getTime());

    const reEnabled = await a.patch(`${BINDINGS}/${created.body.bindingId}`, { enabled: true });
    expect(reEnabled.status).toBe(200);
    expect(reEnabled.body.enabled).toBe(true);
  });

  it('a different tenant cannot toggle another tenant’s binding (404, never leaks existence)', async () => {
    const a = client();
    await signup(a);
    const created = await a.post(BINDINGS, { eventType: 'host.crm.deal.stage-changed', workflowId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const b = client();
    await signup(b);
    const foreignToggle = await b.patch(`${BINDINGS}/${created.body.bindingId}`, { enabled: false });
    expect(foreignToggle.status).toBe(404);

    // Untouched by the foreign attempt.
    const stillEnabled = await a.get(BINDINGS);
    expect(stillEnabled.body.bindings.find((x: { bindingId: string }) => x.bindingId === created.body.bindingId)?.enabled).toBe(true);
  });

  it('an unknown bindingId 404s', async () => {
    const a = client();
    await signup(a);
    const res = await a.patch(`${BINDINGS}/hevb:does-not-exist`, { enabled: false });
    expect(res.status).toBe(404);
  });
});
