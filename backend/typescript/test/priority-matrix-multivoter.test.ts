/**
 * Priority Matrix multi-voter scoring (ADR 0059) — ROUTE harness. Two members vote
 * independently; the ranking uses the aggregate; one member never overwrites the
 * other; switching mode is config-authority-gated; single-mode is unchanged.
 *
 * What turns it red (w15 probes, `priorityMatrixService.ts` / `routes.ts`): a vote key
 * without the voterId (overwrite); the mean or median aggregator replaced; weighted voters
 * aggregated unweighted; the "uniform weights ⇒ unweighted path" rule keyed on weight 1;
 * `voterWeights` / `votingMode` dropped from the config-authority gate (RBAC); the 1..10
 * weight range unchecked.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client } from './planningHarness.js';
import { computePriority } from '../src/features/priority-matrix/scoring.js';
import { CRITERIA_PRESETS } from '../src/features/priority-matrix/types.js';

let BASE = '';
let closeApp: () => Promise<void>;
let n = 0;

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; closeApp = h.close;
  await enableToggle('priority-matrix', 'on');
});
afterAll(async () => { await closeApp(); });

const client = (): Client => makeClient(() => BASE);
const W = CRITERIA_PRESETS.weighted;
async function signup(c: Client, opts: { tenantId?: string } = {}): Promise<{ userId: string }> {
  const r = await c.post('/host/openwop-app/test/login', { email: uniqEmail('mv'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}

const L = '/host/openwop-app/priority-matrix/lists';
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
    const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: ['editor'] });

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
    // Aggregate = the per-criterion MEAN of A and B (5 everywhere), which sits strictly
    // between the two solo scores.
    const aggregate = ownerView.computedPriority;
    expect(aggregate).toBe(computePriority(W, { 'strategic-alignment': 5, roi: 5, urgency: 5, 'compliance-risk': 5, cost: 5 }));
    expect(aggregate).toBeGreaterThan(computePriority(W, B));
    expect(aggregate).toBeLessThan(computePriority(W, A));
    // Member's read sees their own low vote, same aggregate.
    const memberView = (await member.get(`${base}/ideas`)).body.ideas[0];
    expect(memberView.myScores.roi).toBe(2);
    expect(memberView.computedPriority).toBe(aggregate);
  });

  it('median aggregation differs from mean on a 3-voter skew', async () => {
    const tenantId = `org:mv-${Date.now()}-${n++}`;
    const owner = client();
    await signup(owner, { tenantId });
    const m1 = client();
    const m1User = await signup(m1, { tenantId });
    const m2 = client();
    const m2User = await signup(m2, { tenantId });
    const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    for (const u of [m1User, m2User]) {
      await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: u.userId, roles: ['editor'] });
    }
    const list = (await owner.post(L, { orgId, name: 'Median', presetId: 'weighted', votingMode: 'multi-voter', voteAggregation: 'median' })).body;
    expect(list.voteAggregation).toBe('median');
    const base = `${L}/${encodeURIComponent(list.id)}`;
    const idea = (await owner.post(`${base}/ideas`, { title: 'Skewed' })).body;
    // Skew: two high votes and one low. Median picks A on every criterion; the mean is
    // pulled toward B (8,8,2 → 6; cost 2,2,8 → 4).
    for (const [c, s] of [[owner, A], [m1, A], [m2, B]] as const) {
      expect((await c.put(`${base}/ideas/${encodeURIComponent(idea.id)}/scores`, { scores: s })).status).toBe(200);
    }
    const median = (await owner.get(`${base}/ideas`)).body.ideas[0].computedPriority;
    expect(median).toBe(computePriority(W, A));

    expect((await owner.patch(base, { voteAggregation: 'mean' })).status).toBe(200);
    const mean = (await owner.get(`${base}/ideas`)).body.ideas[0].computedPriority;
    expect(mean).toBe(computePriority(W, { 'strategic-alignment': 6, roi: 6, urgency: 6, 'compliance-risk': 6, cost: 4 }));
    expect(mean).not.toBe(median);
  });

  it('weighted voters shift the aggregate toward the heavier-weighted voter (ADR 0059)', async () => {
    const tenantId = `org:mv-${Date.now()}-${n++}`;
    const owner = client();
    const ownerUser = await signup(owner, { tenantId });
    const member = client();
    const memberUser = await signup(member, { tenantId });
    const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: ['editor'] });

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
    const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: ['editor'] });
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
    const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: ['editor'] });
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
    const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: ['editor'] });
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
