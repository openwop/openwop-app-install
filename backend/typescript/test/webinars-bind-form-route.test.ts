/**
 * WEB-G1 (docs/steward/UX_UPGRADE-webinars.md) — binding a registration form must name a form
 * that EXISTS.
 *
 * The route took `requireString(body.formId)` and bound it. Any string bound
 * cleanly: the dashboard then showed a "Form bound" chip for a binding that
 * could never deliver a registrant, because the submission sink resolves
 * bindings from the real form's id. A permanent silent no-op that reported
 * success — and the `onFormDeleted` prune hook already assumes a binding names a
 * real form.
 *
 * The org check is a SAME-tenant second org (ADR 0815 D1a), so the refusal is
 * decided by `getForm`'s `orgId` predicate, not by a tenant guard.
 * Witnessed (grade-tests w63): the existence check dropped → both refusal cases
 * red; `getForm` ignoring orgId → the foreign-workspace case red; the event
 * upsert dropping formId → the real-bind case red.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'webinars', 'forms']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T }
interface ErrorBody { error?: string; message?: string }
interface EventsBody { events: Array<{ eventId: string; formId?: string }> }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const c of getSetCookies(res.headers) as string[]) {
      const m = /(__session=[^;]+)/.exec(c);
      if (m) cookie = m[1];
    }
    return { status: res.status, body: (await res.json()) as T };
  };
  return { get: <T>(p: string) => call<T>('GET', p), post: <T>(p: string, b?: unknown) => call<T>('POST', p, b) };
}

let n = 0;
async function setup(): Promise<{ c: ReturnType<typeof client>; orgId: string; eventId: string }> {
  const c = client();
  const login = await c.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `wb-${Date.now()}-${n++}@acme.test`, tenantId: 'default' });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  // ADR 0815 D1a — `default` is the SAML host-global shape: after its first org,
  // creating one over HTTP is owner-tier. The org under test is minted directly,
  // owned by this caller (the shape `POST /orgs` produces for an owner).
  const orgId = (await createOrg({ tenantId: 'default', createdBy: login.body.user.userId, name: 'Webinar Co', ownerSubject: login.body.user.userId })).orgId;
  const ev = await c.post<{ eventId: string }>(`/host/openwop-app/webinars/orgs/${orgId}/events`, { providerEventId: `zoom-${n}`, title: 'Launch webinar' });
  expect(ev.status, JSON.stringify(ev.body)).toBe(201);
  return { c, orgId, eventId: ev.body.eventId };
}

describe('WEB-G1: bind-form refuses a form that does not exist', () => {
  it('a made-up form id is REFUSED, not silently bound', async () => {
    const { c, orgId, eventId } = await setup();
    const bind = await c.post<ErrorBody>(`/host/openwop-app/webinars/orgs/${orgId}/events/${eventId}/bind-form`, { formId: 'form-typo-999' });
    // Was 200 + `{ ok: true }`, which is how the dashboard came to display a
    // binding that could never deliver a registrant.
    expect(bind.status).toBe(404);
    expect(bind.body.error).toBe('not_found');
    expect(bind.body.message).toBe('No form with that id in this workspace.');

    // And nothing was written: the event still has no form.
    const list = await c.get<EventsBody>(`/host/openwop-app/webinars/orgs/${orgId}/events`);
    const mine = list.body.events.find((e) => e.eventId === eventId);
    expect(mine, 'the event is listed').toBeDefined();
    expect(mine?.formId).toBeUndefined();
  });

  it('a REAL form binds, and the event reports it', async () => {
    const { c, orgId, eventId } = await setup();
    const form = await c.post<{ formId: string }>(`/host/openwop-app/forms/orgs/${orgId}/forms`, { title: 'Webinar signup', fields: [] });
    expect(form.status, JSON.stringify(form.body)).toBe(201);
    const formId = form.body.formId;

    const bind = await c.post<{ ok: boolean; formId: string }>(`/host/openwop-app/webinars/orgs/${orgId}/events/${eventId}/bind-form`, { formId });
    expect(bind.status, JSON.stringify(bind.body)).toBe(200);
    expect(bind.body.formId).toBe(formId);

    const list = await c.get<EventsBody>(`/host/openwop-app/webinars/orgs/${orgId}/events`);
    const mine = list.body.events.find((e) => e.eventId === eventId);
    expect(mine?.formId).toBe(formId);
  });

  it("a form from ANOTHER workspace is refused (the check is org-scoped)", async () => {
    const { c, orgId, eventId } = await setup();
    // The caller owns `orgId`, so it may create a second org here (ADR 0815 D1a).
    const other = await c.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Other Co' });
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    const form = await c.post<{ formId: string }>(`/host/openwop-app/forms/orgs/${other.body.orgId}/forms`, { title: 'Elsewhere', fields: [] });
    expect(form.status, 'the foreign form really exists').toBe(201);

    const bind = await c.post<ErrorBody>(`/host/openwop-app/webinars/orgs/${orgId}/events/${eventId}/bind-form`, { formId: form.body.formId });
    expect(bind.status).toBe(404);
    expect(bind.body.message).toBe('No form with that id in this workspace.');
    const list = await c.get<EventsBody>(`/host/openwop-app/webinars/orgs/${orgId}/events`);
    expect(list.body.events.find((e) => e.eventId === eventId)?.formId).toBeUndefined();
  });
});
