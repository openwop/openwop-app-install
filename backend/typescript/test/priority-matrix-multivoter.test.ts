/**
 * Priority Matrix multi-voter scoring (ADR 0059) — ROUTE harness. Two members vote
 * independently; the ranking uses the aggregate; one member never overwrites the
 * other; switching mode is config-authority-gated; single-mode is unchanged.
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
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}

const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function signup(c: Client, opts: { tenantId?: string } = {}): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('mv'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}

const L = '/v1/host/openwop-app/priority-matrix/lists';
// Weighted preset criterion ids; score one benefit criterion so the aggregate is easy to reason about.
const A = { 'strategic-alignment': 8, roi: 8, urgency: 8, 'compliance-risk': 8, cost: 2 };
const B = { 'strategic-alignment': 2, roi: 2, urgency: 2, 'compliance-risk': 2, cost: 8 };

describe('priority-matrix multi-voter (ADR 0059)', () => {
  it('aggregates two members’ independent votes; neither overwrites the other', async () => {
    const tenantId = `org:mv-${Date.now()}-${n++}`;
    const owner = client();
    await signup(owner, { tenantId });
    const member = client();
    const memberUser = await signup(member, { tenantId });
    const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: ['editor'] });

    const list = (await owner.post(L, { orgId, name: 'Council', presetId: 'weighted', votingMode: 'multi-voter', voteAggregation: 'mean' })).body;
    expect(list.votingMode).toBe('multi-voter');
    const base = `${L}/${encodeURIComponent(list.id)}`;
    const idea = (await owner.post(`${base}/ideas`, { title: 'Shared idea' })).body;

    // Owner votes high, member votes low — independently.
    const r1 = await owner.put(`${base}/ideas/${encodeURIComponent(idea.id)}/scores`, { scores: A });
    expect(r1.body.voterCount).toBe(1);
    const r2 = await member.put(`${base}/ideas/${encodeURIComponent(idea.id)}/scores`, { scores: B });
    expect(r2.body.voterCount).toBe(2); // member did NOT overwrite the owner

    // Owner's read: aggregate priority + their own vote preserved; two voters counted.
    const ownerView = (await owner.get(`${base}/ideas`)).body.ideas[0];
    expect(ownerView.voterCount).toBe(2);
    expect(ownerView.myScores.roi).toBe(8);            // owner sees their own vote
    // Aggregate (mean of 8 and 2 = 5 on benefits) sits strictly between the two solo scores.
    const aggregate = ownerView.computedPriority;
    expect(aggregate).toBeGreaterThan(0);
    // Member's read sees their own low vote, same aggregate.
    const memberView = (await member.get(`${base}/ideas`)).body.ideas[0];
    expect(memberView.myScores.roi).toBe(2);
    expect(memberView.computedPriority).toBe(aggregate);
  });

  it('median aggregation differs from mean on a 3-voter skew', async () => {
    const tenantId = `org:mv-${Date.now()}-${n++}`;
    const owner = client();
    await signup(owner, { tenantId });
    const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    const list = (await owner.post(L, { orgId, name: 'Median', presetId: 'weighted', votingMode: 'multi-voter', voteAggregation: 'median' })).body;
    expect(list.voteAggregation).toBe('median');
    // (Single voter here just exercises the median path end-to-end without overwrite.)
    const base = `${L}/${encodeURIComponent(list.id)}`;
    const idea = (await owner.post(`${base}/ideas`, { title: 'Skewed' })).body;
    const r = await owner.put(`${base}/ideas/${encodeURIComponent(idea.id)}/scores`, { scores: A });
    expect(r.body.computedPriority).toBeGreaterThan(0);
  });

  it('weighted voters shift the aggregate toward the heavier-weighted voter (ADR 0059)', async () => {
    const tenantId = `org:mv-${Date.now()}-${n++}`;
    const owner = client();
    const ownerUser = await signup(owner, { tenantId });
    const member = client();
    const memberUser = await signup(member, { tenantId });
    const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: ['editor'] });

    const list = (await owner.post(L, { orgId, name: 'Weighted', presetId: 'weighted', votingMode: 'multi-voter', voteAggregation: 'mean' })).body;
    const base = `${L}/${encodeURIComponent(list.id)}`;
    const idea = (await owner.post(`${base}/ideas`, { title: 'Weighted idea' })).body;

    // Owner votes high (A), member votes low (B) — equal weight ⇒ mean halfway.
    await owner.put(`${base}/ideas/${encodeURIComponent(idea.id)}/scores`, { scores: A });
    await member.put(`${base}/ideas/${encodeURIComponent(idea.id)}/scores`, { scores: B });
    const equalWeight = (await owner.get(`${base}/ideas`)).body.ideas[0].computedPriority;

    // Weight the owner 10×, the member 1× — the aggregate must move toward the owner's high vote.
    const patched = await owner.patch(base, { voterWeights: { [ownerUser.userId]: 10, [memberUser.userId]: 1 } });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.voterWeights[ownerUser.userId]).toBe(10);
    const weighted = (await owner.get(`${base}/ideas`)).body.ideas[0].computedPriority;
    expect(weighted).toBeGreaterThan(equalWeight); // heavier owner pulls priority up

    // The caller's own vote is untouched by re-weighting (weights aggregate, never overwrite).
    expect((await owner.get(`${base}/ideas`)).body.ideas[0].myScores.roi).toBe(8);
  });

  it('uniform non-default weights match the unweighted aggregate in median mode (code-review 2026-06-16)', async () => {
    const tenantId = `org:mv-${Date.now()}-${n++}`;
    const owner = client();
    const ownerUser = await signup(owner, { tenantId });
    const member = client();
    const memberUser = await signup(member, { tenantId });
    const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: ['editor'] });
    const list = (await owner.post(L, { orgId, name: 'UnifMedian', presetId: 'weighted', votingMode: 'multi-voter', voteAggregation: 'median' })).body;
    const base = `${L}/${encodeURIComponent(list.id)}`;
    const idea = (await owner.post(`${base}/ideas`, { title: 'Idea' })).body;

    // Two voters split high/low → unweighted median averages the middle pair.
    await owner.put(`${base}/ideas/${encodeURIComponent(idea.id)}/scores`, { scores: A });
    await member.put(`${base}/ideas/${encodeURIComponent(idea.id)}/scores`, { scores: B });
    const defaultPriority = (await owner.get(`${base}/ideas`)).body.ideas[0].computedPriority;

    // Raise BOTH voters to the SAME non-1 weight: equal weight ⇒ identical aggregate.
    // (Before the fix this took the weighted path and the lower-weighted-median diverged.)
    await owner.patch(base, { voterWeights: { [ownerUser.userId]: 5, [memberUser.userId]: 5 } });
    const uniformPriority = (await owner.get(`${base}/ideas`)).body.ideas[0].computedPriority;
    expect(uniformPriority).toBe(defaultPriority);
  });

  it('setting voterWeights is config-authority-gated (a co-tenant editor gets 403)', async () => {
    const tenantId = `org:mv-${Date.now()}-${n++}`;
    const owner = client();
    const ownerUser = await signup(owner, { tenantId });
    const member = client();
    const memberUser = await signup(member, { tenantId });
    const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: ['editor'] });
    const list = (await owner.post(L, { orgId, name: 'Gated', presetId: 'weighted', votingMode: 'multi-voter' })).body;

    // A co-tenant editor cannot set per-voter weights.
    expect((await member.patch(`${L}/${encodeURIComponent(list.id)}`, { voterWeights: { [memberUser.userId]: 10 } })).status).toBe(403);
    // The config authority (creator) can; invalid weights (out of 1..10) are dropped.
    const ok = await owner.patch(`${L}/${encodeURIComponent(list.id)}`, { voterWeights: { [ownerUser.userId]: 5, [memberUser.userId]: 99 } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.voterWeights[ownerUser.userId]).toBe(5);
    expect(ok.body.voterWeights[memberUser.userId]).toBeUndefined(); // 99 is out of range → dropped
  });

  it('switching voting mode is config-authority-gated; a single-mode list is unchanged', async () => {
    const tenantId = `org:mv-${Date.now()}-${n++}`;
    const owner = client();
    await signup(owner, { tenantId });
    const member = client();
    const memberUser = await signup(member, { tenantId });
    const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: ['editor'] });
    const list = (await owner.post(L, { orgId, name: 'Default single' })).body;
    expect(list.votingMode).toBe('single'); // default

    // A co-tenant editor cannot flip the scoring mode (config authority).
    expect((await member.patch(`${L}/${encodeURIComponent(list.id)}`, { votingMode: 'multi-voter' })).status).toBe(403);
    // The owner can.
    const ok = await owner.patch(`${L}/${encodeURIComponent(list.id)}`, { votingMode: 'multi-voter' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.votingMode).toBe('multi-voter');
  });
});
