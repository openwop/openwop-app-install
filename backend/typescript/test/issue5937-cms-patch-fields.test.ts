/**
 * Issue 5937 — a CMS PATCH whose body names no editable field, or an unknown one, was
 * accepted (200) and still wrote the row: a new `version`, `updatedAt` and `updatedBy`
 * for an edit that did not happen. Found live on prod, where `{section: …}` (a typo for
 * `data`) returned 200 and moved a shared section's `updatedAt`.
 *
 * Through the real HTTP boundary, for both routes: a typo'd body, an empty body and a
 * body holding only `expectedVersion` are refused with 400 `validation_error` naming
 * the field, and the stored row keeps its version and `updatedAt`. A real edit still
 * passes. Red on the old routes: the typo'd body returns 200 and bumps the version.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';

let BASE: string;
let server: http.Server;

interface Row { version: number; updatedAt: string; name?: string; title?: string; sharedSectionId?: string; pageId?: string }
interface Body extends Partial<Row> { orgId?: string; error?: string; details?: { field?: string }; sharedSections?: Row[] }
interface Res { status: number; body: Body }
function client(): { post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; get: (p: string) => Promise<Res> } {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m?.[1]) cookie = m[1]; }
    const out: unknown = await res.json().catch(() => ({}));
    return { status: res.status, body: out as Body };
  };
  return { post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), get: (p) => call('GET', p) };
}

let c: ReturnType<typeof client>;
let orgId = '';
const u = (s: string): string => `/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  c = client();
  const login = await c.post('/host/openwop-app/test/login', { email: `i5937-${Date.now()}@acme.test`, tenantId: `org:i5937-${Date.now()}` });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await c.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  orgId = org.body.orgId ?? '';
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('issue 5937 — a CMS PATCH names an editable field, or it writes nothing', () => {
  it('shared section: a typo, an empty body and an unknown extra field are 400 and leave the row alone', async () => {
    const made = await c.post(u('/shared-sections'), { name: 'Footer', type: 'hero', data: { heading: 'Hello' } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = made.body.sharedSectionId ?? '';
    const read = async (): Promise<Row | undefined> => (await c.get(u('/shared-sections'))).body.sharedSections?.find((s) => s.sharedSectionId === id);
    const before = await read();
    expect(before).toBeTruthy();

    for (const [body, field] of [[{ section: { heading: 'Hello' } }, 'section'], [{}, undefined], [{ name: 'Footer 2', colour: 'red' }, 'colour'], [{ name: 123 }, 'name']] as const) {
      const r = await c.patch(u(`/shared-sections/${id}`), body);
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.error).toBe('validation_error');
      if (field) expect(r.body.details?.field).toBe(field);
    }
    const after = await read();
    expect(after?.version).toBe(before?.version);
    expect(after?.updatedAt).toBe(before?.updatedAt);
    expect(after?.name).toBe('Footer');

    const ok = await c.patch(u(`/shared-sections/${id}`), { name: 'Footer 2' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.version).toBe((before?.version ?? 0) + 1);
  });

  it('page: a typo, an empty body and expectedVersion alone are 400 and leave the page alone', async () => {
    const made = await c.post(u('/pages'), { title: 'Pricing', sections: [{ type: 'hero', data: { heading: 'Old' } }] });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = made.body.pageId ?? '';
    const before = (await c.get(u(`/pages/${id}`))).body;

    for (const [body, field] of [[{ titel: 'Typo' }, 'titel'], [{}, undefined], [{ expectedVersion: before.version }, undefined], [{ title: 5 }, 'title']] as const) {
      const r = await c.patch(u(`/pages/${id}`), body);
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.error).toBe('validation_error');
      if (field) expect(r.body.details?.field).toBe(field);
    }
    const after = (await c.get(u(`/pages/${id}`))).body;
    expect(after.version).toBe(before.version);
    expect(after.updatedAt).toBe(before.updatedAt);

    const ok = await c.patch(u(`/pages/${id}`), { title: 'Pricing 2026', expectedVersion: before.version });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.title).toBe('Pricing 2026');
  });
});
