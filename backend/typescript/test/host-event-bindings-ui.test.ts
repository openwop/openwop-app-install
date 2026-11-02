/**
 * Host-event bindings admin UI — the PATCH toggle route (ADR 0208 §1,
 * "binding the shipped chains is operator-explicit" open question, closed
 * 2026-07-03: the UI ships as an operator-driven CRUD surface, not a seeder).
 *
 * `crm-events.test.ts` already covers POST/GET/DELETE CRUD + the CRM
 * emission/webhook/trigger wiring; this file adds ONLY the new
 * `PATCH /host/openwop-app/host-events/bindings/:bindingId` route the
 * admin UI's enabled-toggle drives: happy path + cross-tenant 404 + the
 * validation 400 for a non-boolean body.
 *
 * Tracker TST-DFC-2. Red when (w71g1, witnessed): the tenant check on the toggle is
 * dropped (a real binding in tenant A, toggled by a signed-in tenant B); the boolean
 * validation is dropped; the toggle stops writing `enabled`; the toggle stops
 * re-stamping `updatedAt` (Date is faked 5 s forward, so the new stamp is exact).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HostEventBinding } from '../src/host/hostEventDispatcher.js';
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

interface Res { status: number; body: unknown }
interface ErrorBody { error: string; message: string }
interface LoginBody { user: { userId: string } }
interface Client {
  get: (p: string) => Promise<Res>;
  post: (p: string, b?: unknown) => Promise<Res>;
  patch: (p: string, b?: unknown) => Promise<Res>;
}
/** Narrow a response body at the call site (the product's own types; no cast laundering). */
const asBinding = (r: Res): HostEventBinding => r.body as HostEventBinding;
const asError = (r: Res): ErrorBody => r.body as ErrorBody;
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
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

let n = 0;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function signup(c: Client): Promise<{ userId: string; tenantId: string }> {
  const tenantId = `org:test-${Date.now()}-${n++}`;
  const r = await c.post('/host/openwop-app/test/login', { email: uniqEmail('bindui'), tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { userId: (r.body as LoginBody).user.userId, tenantId };
}

const BINDINGS = '/host/openwop-app/host-events/bindings';

describe('host-event bindings — PATCH :bindingId (admin-UI enabled toggle)', () => {
  it('flips enabled, stamps updatedAt, and rejects a non-boolean body', async () => {
    const a = client();
    await signup(a);
    const createdRes = await a.post(BINDINGS, { eventType: 'host.crm.contact.created', workflowId });
    expect(createdRes.status, JSON.stringify(createdRes.body)).toBe(201);
    const created = asBinding(createdRes);
    expect(created.enabled).toBe(true);

    const badBody = await a.patch(`${BINDINGS}/${created.bindingId}`, { enabled: 'nope' });
    expect(badBody.status).toBe(400);
    expect(asError(badBody)).toMatchObject({ error: 'validation_error', message: 'enabled must be a boolean.' });

    // Fake only Date, 5 s past the create stamp, so the toggle's re-stamp is exact.
    const toggledAt = new Date(Date.parse(created.updatedAt) + 5_000);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(toggledAt);
    let disabledRes: Res;
    try {
      disabledRes = await a.patch(`${BINDINGS}/${created.bindingId}`, { enabled: false });
    } finally { vi.useRealTimers(); }
    expect(disabledRes.status, JSON.stringify(disabledRes.body)).toBe(200);
    const disabled = asBinding(disabledRes);
    expect(disabled.enabled).toBe(false);
    expect(disabled.bindingId).toBe(created.bindingId);
    expect(disabled.updatedAt).toBe(toggledAt.toISOString());

    const reEnabled = await a.patch(`${BINDINGS}/${created.bindingId}`, { enabled: true });
    expect(reEnabled.status).toBe(200);
    expect(asBinding(reEnabled).enabled).toBe(true);
  });

  it('a different tenant cannot toggle another tenant’s binding (404, never leaks existence)', async () => {
    const a = client();
    await signup(a);
    const createdRes = await a.post(BINDINGS, { eventType: 'host.crm.deal.stage-changed', workflowId });
    expect(createdRes.status, JSON.stringify(createdRes.body)).toBe(201);
    const created = asBinding(createdRes);

    const b = client();
    await signup(b);
    const foreignToggle = await b.patch(`${BINDINGS}/${created.bindingId}`, { enabled: false });
    expect(foreignToggle.status).toBe(404);
    expect(asError(foreignToggle)).toMatchObject({ error: 'not_found', message: 'Binding not found.' });

    // Untouched by the foreign attempt.
    const stillEnabled = (await a.get(BINDINGS)).body as { bindings: HostEventBinding[] };
    expect(stillEnabled.bindings.find((x) => x.bindingId === created.bindingId)?.enabled).toBe(true);
  });

  it('an unknown bindingId 404s', async () => {
    const a = client();
    await signup(a);
    const res = await a.patch(`${BINDINGS}/hevb:does-not-exist`, { enabled: false });
    expect(res.status).toBe(404);
    expect(asError(res)).toMatchObject({ error: 'not_found', message: 'Binding not found.' });
  });
});
