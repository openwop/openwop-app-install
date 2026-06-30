/**
 * Priority Matrix portfolio (ADR 0060) — ROUTE harness. Cross-list rollup across a
 * workspace's readable lists: merged + ranked by priority, topN respected, source
 * list + in-list rank surfaced, and cross-org lists excluded (no leak).
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
  const d = getToggleDefault('priority-matrix');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };
}

const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function signup(c: Client, opts: { tenantId?: string } = {}): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('pf'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}

const L = '/v1/host/openwop-app/priority-matrix/lists';
const P = '/v1/host/openwop-app/priority-matrix/portfolio';
const HIGH = { 'strategic-alignment': 10, roi: 10, urgency: 10, 'compliance-risk': 10, cost: 1 };
const LOW = { 'strategic-alignment': 1, roi: 1, urgency: 1, 'compliance-risk': 1, cost: 10 };

async function listWithScoredIdea(c: Client, orgId: string, listName: string, title: string, scores: Record<string, number>): Promise<void> {
  const list = (await c.post(L, { orgId, name: listName, presetId: 'weighted' })).body;
  const idea = (await c.post(`${L}/${encodeURIComponent(list.id)}/ideas`, { title })).body;
  await c.put(`${L}/${encodeURIComponent(list.id)}/ideas/${encodeURIComponent(idea.id)}/scores`, { scores });
}

describe('priority-matrix portfolio (ADR 0060)', () => {
  it('merges ideas across the workspace’s lists, ranked by priority, with source + in-list rank', async () => {
    const owner = client();
    await signup(owner);
    const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    await listWithScoredIdea(owner, orgId, 'List A', 'Top across all', HIGH);
    await listWithScoredIdea(owner, orgId, 'List B', 'Bottom across all', LOW);

    const pf = await owner.get(P);
    expect(pf.status, JSON.stringify(pf.body)).toBe(200);
    expect(pf.body.lists).toHaveLength(2);
    expect(pf.body.items).toHaveLength(2);
    // Merged + ranked by priority: the HIGH idea from List A leads.
    expect(pf.body.items[0].title).toBe('Top across all');
    expect(pf.body.items[0].listName).toBe('List A');
    expect(pf.body.items[0].inListRank).toBe(1);
    expect(pf.body.items[0].scoringModel).toBe('weighted');
    expect(pf.body.items[0].computedPriority).toBeGreaterThan(pf.body.items[1].computedPriority);
  });

  it('respects topN', async () => {
    const owner = client();
    await signup(owner);
    const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    await listWithScoredIdea(owner, orgId, 'L1', 'i1', HIGH);
    await listWithScoredIdea(owner, orgId, 'L2', 'i2', LOW);
    const pf = await owner.get(`${P}?topN=1`);
    expect(pf.body.items).toHaveLength(1);
    expect(pf.body.lists).toHaveLength(2); // the rollup still reports both contributing lists
  });

  it('excludes a list in an org the caller cannot read (no cross-org leak)', async () => {
    const tenantId = `org:pf-${Date.now()}-${n++}`;
    const owner = client();
    await signup(owner, { tenantId });
    const member = client();
    const memberUser = await signup(member, { tenantId });
    const orgA = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Alpha' })).body.orgId;
    const orgB = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Bravo' })).body.orgId;
    await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgA)}/members`, { displayName: 'M', subject: memberUser.userId, roles: ['editor'] });
    await listWithScoredIdea(owner, orgA, 'A-list', 'visible', HIGH);
    await listWithScoredIdea(owner, orgB, 'B-list', 'hidden', HIGH);

    const pf = await member.get(P); // member reads only org A
    expect(pf.body.lists.map((l: any) => l.name)).toEqual(['A-list']);
    expect(pf.body.items.map((i: any) => i.title)).toEqual(['visible']);
  });
});
