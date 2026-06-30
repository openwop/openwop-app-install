/**
 * Campaign Brief — Personas (ADR 0156 Phase 1) — ROUTE harness. Boots the real
 * app and drives the persona surface over HTTP:
 *   - toggle gating (404 when `campaign-brief` is off)
 *   - create / list / get / update / delete a persona (org-scoped)
 *   - buyer-stage clamp + list filtering by brandId
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
  await enable('on');
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

const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function signup(c: Client): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('cb') });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
const enable = async (status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault('campaign-brief'); if (d) await saveConfig({ ...d, status }, 'test'); };

async function ownerWithOrg(): Promise<{ owner: Client; orgId: string }> {
  const owner = client();
  await signup(owner);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId };
}

const P = '/v1/host/openwop-app/campaign-brief/personas';

describe('campaign-brief personas — toggle gating', () => {
  it('404s when the toggle is off', async () => {
    await enable('off');
    const c = client();
    await signup(c);
    expect((await c.get(P)).status).toBe(404);
    await enable('on');
  });
});

describe('campaign-brief personas — CRUD', () => {
  it('creates, lists, gets, updates, deletes; clamps buyer stage', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const r = await owner.post(P, { orgId, name: 'Ops Director', role: 'Operations Director', buyerStage: 'not_a_stage', painPoints: ['labor shortage'], objections: ['too expensive'] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.persona.buyerStage).toBe('problem_aware'); // clamped
    expect(r.body.persona.painPoints).toEqual(['labor shortage']);
    const id = r.body.persona.id;

    const list = await owner.get(`${P}?orgId=${orgId}`);
    expect(list.status).toBe(200);
    expect(list.body.personas.map((p: any) => p.id)).toContain(id);

    const patched = await owner.patch(`${P}/${id}`, { buyerStage: 'product_aware', goals: ['cut cost'] });
    expect(patched.status).toBe(200);
    expect(patched.body.persona.buyerStage).toBe('product_aware');
    expect(patched.body.persona.goals).toEqual(['cut cost']);

    const del = await owner.del(`${P}/${id}`);
    expect(del.status).toBe(200);
    expect((await owner.get(`${P}/${id}`)).status).toBe(404);
  });

  it('filters personas by brandId', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const a = await owner.post(P, { orgId, name: 'A', brandId: 'brand-1' });
    await owner.post(P, { orgId, name: 'B', brandId: 'brand-2' });
    const list = await owner.get(`${P}?orgId=${orgId}&brandId=brand-1`);
    expect(list.body.personas.map((p: any) => p.id)).toEqual([a.body.persona.id]);
  });

  it('requires a name', async () => {
    const { owner, orgId } = await ownerWithOrg();
    expect((await owner.post(P, { orgId, name: '  ' })).status).toBe(400);
  });
});

describe('campaign-brief personas — isolation', () => {
  it('a member without read in the persona org gets a uniform 404', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const created = await owner.post(P, { orgId, name: 'Secret' });
    const id = created.body.persona.id;
    const stranger = client();
    await signup(stranger);
    expect((await stranger.get(`${P}/${id}`)).status).toBe(404);
    expect((await stranger.patch(`${P}/${id}`, { name: 'x' })).status).toBe(404);
  });
});
