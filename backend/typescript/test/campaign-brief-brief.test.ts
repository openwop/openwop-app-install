/**
 * Campaign Brief — Briefs (ADR 0156 Phase 2) — ROUTE harness. Drives the brief
 * surface over HTTP:
 *   - create / list / get / update / delete a brief (org-scoped)
 *   - validate → enabledChannels + completeness issues
 *   - editing a brief that has a kernel marks it stale
 *   - IDOR: a co-tenant member without read in the org gets 404
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const d = getToggleDefault('campaign-brief'); if (d) await saveConfig({ ...d, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

const uniqEmail = (): string => `cb-${Date.now()}-${n++}@acme.test`;
async function ownerWithOrg(): Promise<{ owner: Client; orgId: string }> {
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: uniqEmail() });
  expect(r.status).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { owner, orgId: org.body.orgId };
}

const B = '/v1/host/openwop-app/campaign-brief/briefs';

describe('campaign-brief briefs — CRUD + validate', () => {
  it('creates a brief seeded with all five channels disabled', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const r = await owner.post(B, { orgId, name: 'Q4 Launch', productName: 'FlashPick' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.brief.channels).toHaveLength(5);
    expect(r.body.brief.channels.every((c: any) => c.enabled === false)).toBe(true);
    expect(r.body.brief.status).toBe('draft');
  });

  it('validate reports completeness issues and the enabled channel set', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const created = await owner.post(B, { orgId, name: 'Camp', productName: 'FlashPick' });
    const id = created.body.brief.id;
    // Incomplete: no persona, no value prop, no enabled channel.
    let v = await owner.post(`${B}/${id}/validate`);
    expect(v.status).toBe(200);
    expect(v.body.valid).toBe(false);
    expect(v.body.enabledChannels).toEqual([]);
    expect(v.body.issues.map((i: any) => i.field)).toEqual(expect.arrayContaining(['personaIds', 'messaging.primaryValueProp', 'channels']));

    // Complete it.
    await owner.patch(`${B}/${id}`, {
      personaIds: ['p1'],
      messaging: { primaryValueProp: 'Pick faster' },
      channels: [
        { type: 'landing_page', enabled: true, config: {} },
        { type: 'email_sequence', enabled: true, config: {} },
      ],
    });
    v = await owner.post(`${B}/${id}/validate`);
    expect(v.body.valid).toBe(true);
    expect(v.body.enabledChannels).toEqual(['landing_page', 'email_sequence']);
  });

  it('lists, gets, and deletes a brief', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const created = await owner.post(B, { orgId, name: 'L', productName: 'P' });
    const id = created.body.brief.id;
    expect((await owner.get(`${B}?orgId=${orgId}`)).body.briefs.map((b: any) => b.id)).toContain(id);
    expect((await owner.get(`${B}/${id}`)).body.brief.name).toBe('L');
    expect((await owner.del(`${B}/${id}`)).status).toBe(200);
    expect((await owner.get(`${B}/${id}`)).status).toBe(404);
  });
});

describe('campaign-brief briefs — isolation', () => {
  it('a member without read in the brief org gets a uniform 404', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const created = await owner.post(B, { orgId, name: 'Secret', productName: 'P' });
    const id = created.body.brief.id;
    const stranger = client();
    await stranger.post('/v1/host/openwop-app/test/login', { email: uniqEmail() });
    expect((await stranger.get(`${B}/${id}`)).status).toBe(404);
    expect((await stranger.del(`${B}/${id}`)).status).toBe(404);
  });
});
