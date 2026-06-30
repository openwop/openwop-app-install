/**
 * Priority Matrix follow-ons — ROUTE harness:
 *   - ADR 0060: portfolio normalization (list-relative + percentile)
 *   - ADR 0059: per-voter vote breakdown (config-authority gated)
 *   - ADR 0059: single→multi-voter vote seeding (scores survive the switch)
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
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), put: (p, b) => call('PUT', p, b) };
}

const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function signup(c: Client, opts: { tenantId?: string } = {}): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('fo'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}

const L = '/v1/host/openwop-app/priority-matrix/lists';
const HIGH = { 'strategic-alignment': 10, roi: 10, urgency: 10, 'compliance-risk': 10, cost: 1 };
const MID = { 'strategic-alignment': 5, roi: 5, urgency: 5, 'compliance-risk': 5, cost: 5 };
const LOW = { 'strategic-alignment': 1, roi: 1, urgency: 1, 'compliance-risk': 1, cost: 10 };

async function scoredIdea(c: Client, listId: string, title: string, scores: Record<string, number>): Promise<string> {
  const idea = (await c.post(`${L}/${encodeURIComponent(listId)}/ideas`, { title })).body;
  await c.put(`${L}/${encodeURIComponent(listId)}/ideas/${encodeURIComponent(idea.id)}/scores`, { scores });
  return idea.id;
}

describe('portfolio normalization (ADR 0060)', () => {
  it('list-relative + percentile attach a 0–100 score; the top of each list normalizes to ~100', async () => {
    const owner = client();
    await signup(owner);
    const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    const list = (await owner.post(L, { orgId, name: 'L', presetId: 'weighted' })).body;
    await scoredIdea(owner, list.id, 'top', HIGH);
    await scoredIdea(owner, list.id, 'mid', MID);
    await scoredIdea(owner, list.id, 'low', LOW);

    const raw = (await owner.get(`${L.replace('/lists', '')}/portfolio`)).body;
    expect(raw.normalize).toBe('none');
    expect(raw.items[0].normalizedPriority).toBeUndefined();

    const rel = (await owner.get(`${L.replace('/lists', '')}/portfolio?normalize=list-relative`)).body;
    expect(rel.normalize).toBe('list-relative');
    expect(rel.items[0].normalizedPriority).toBe(100); // top of its list
    expect(rel.items[0].title).toBe('top');

    const pct = (await owner.get(`${L.replace('/lists', '')}/portfolio?normalize=percentile`)).body;
    expect(pct.items[0].normalizedPriority).toBe(100); // rank 1 of 3
    expect(pct.items[2].normalizedPriority).toBe(0);   // rank 3 of 3
  });
});

describe('vote breakdown (ADR 0059) — config-authority gated', () => {
  it('owner sees per-voter scores; a co-tenant editor is 403', async () => {
    const tenantId = `org:fo-${Date.now()}-${n++}`;
    const owner = client();
    await signup(owner, { tenantId });
    const member = client();
    const memberUser = await signup(member, { tenantId });
    const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: ['editor'] });
    const list = (await owner.post(L, { orgId, name: 'Council', presetId: 'weighted', votingMode: 'multi-voter' })).body;
    const idea = (await owner.post(`${L}/${encodeURIComponent(list.id)}/ideas`, { title: 'shared' })).body;
    await owner.put(`${L}/${encodeURIComponent(list.id)}/ideas/${encodeURIComponent(idea.id)}/scores`, { scores: HIGH });
    await member.put(`${L}/${encodeURIComponent(list.id)}/ideas/${encodeURIComponent(idea.id)}/scores`, { scores: LOW });

    const votesUrl = `${L}/${encodeURIComponent(list.id)}/ideas/${encodeURIComponent(idea.id)}/votes`;
    const ownerView = await owner.get(votesUrl);
    expect(ownerView.status, JSON.stringify(ownerView.body)).toBe(200);
    expect(ownerView.body.votes).toHaveLength(2); // both voters
    // The editor (not creator, not org-admin) can't see the breakdown.
    expect((await member.get(votesUrl)).status).toBe(403);
  });
});

describe('single→multi-voter seeding (ADR 0059)', () => {
  it('seeds the creator’s vote from the existing shared score so priority survives the switch', async () => {
    const owner = client();
    await signup(owner);
    const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    const list = (await owner.post(L, { orgId, name: 'Switch', presetId: 'weighted' })).body; // single (default)
    const idea = await scoredIdea(owner, list.id, 'kept', HIGH);
    const before = (await owner.get(`${L}/${encodeURIComponent(list.id)}/ideas`)).body.ideas[0];
    expect(before.computedPriority).toBeGreaterThan(0);

    // Flip to multi-voter (owner = creator ⇒ config authority).
    expect((await owner.patch(`${L}/${encodeURIComponent(list.id)}`, { votingMode: 'multi-voter' })).status).toBe(200);

    // The idea's priority survived (seeded creator vote), not reset to 0.
    const after = (await owner.get(`${L}/${encodeURIComponent(list.id)}/ideas`)).body.ideas[0];
    expect(after.computedPriority).toBe(before.computedPriority);
    expect(after.voterCount).toBe(1);
    expect(after.myScores.roi).toBe(10);
    // The breakdown shows exactly the creator's seeded vote.
    const votes = (await owner.get(`${L}/${encodeURIComponent(list.id)}/ideas/${encodeURIComponent(idea)}/votes`)).body.votes;
    expect(votes).toHaveLength(1);
    expect(votes[0].scores.roi).toBe(10);
  });
});
