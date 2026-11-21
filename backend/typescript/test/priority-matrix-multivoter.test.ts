/**
 * Priority Matrix multi-voter scoring (ADR 0059) — ROUTE harness. Two members vote
 * independently; the ranking uses the aggregate; one member never overwrites the
 * other; switching mode is config-authority-gated (ADR 0058 §8); single-mode is
 * unchanged.
 *
 * Every expected priority is a hand-computed LITERAL, not `computePriority(...)`, so
 * a change to the scoring engine cannot move the expectation with it. The weighted
 * preset is weighted-sum over strategic-alignment 8, roi 7, urgency 6,
 * compliance-risk 7 (benefits, Σ28) and cost 5 (scored as 11 − s), Σw 33:
 *   A (8,8,8,8 / cost 2) = (8·28 + 9·5)/33 = 269/33 → 8.15
 *   B (2,2,2,2 / cost 8) = (2·28 + 3·5)/33 =  71/33 → 2.15
 *   all 5 (mean of A,B)  = (5·28 + 6·5)/33 = 170/33 → 5.15
 *   6/4 (mean of A,A,B)  = (6·28 + 7·5)/33 = 203/33 → 6.15
 *   owner 10× A, member 1× B: benefits 82/11, cost 28/11 → 2761/363 → 7.61
 *
 * The two refusals are asserted by the config-authority gate's own message: a
 * `workspace:write` refusal shares the `forbidden_scope` code and the 403.
 *
 * What turns it red (w15 probes, re-probed wave 121 as w121g1-pm-*,
 * `priorityMatrixService.ts` / `routes.ts` / `listAccess.ts`): a vote key without
 * the voterId (overwrite); the mean or median aggregator replaced; weighted voters
 * aggregated unweighted; the "uniform weights ⇒ unweighted path" rule keyed on
 * weight 1; `voterWeights` / `votingMode` dropped from the config-authority gate
 * (RBAC); either half of `hasListConfigAuthority` granting a plain editor; the 1..10
 * weight range unchecked; the `single` default replaced.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client, type Res } from './planningHarness.js';
import type { PriorityList } from '../src/features/priority-matrix/types.js';
import type { RankedIdea, ScoreResult } from '../src/features/priority-matrix/priorityMatrixService.js';
import type { KanbanCard } from '../src/host/kanbanService.js';

let BASE = '';
let closeApp: () => Promise<void>;
let n = 0;

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; closeApp = h.close;
  await enableToggle('priority-matrix', 'on');
});
afterAll(async () => { await closeApp(); });

const client = (): Client => makeClient(() => BASE);
async function signup(c: Client, opts: { tenantId?: string } = {}): Promise<{ userId: string }> {
  const r: Res<{ user: { userId: string } }> = await c.post('/host/openwop-app/test/login', { email: uniqEmail('mv'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}

/** A fresh org owned by `owner`, with each of `members` seeded as an editor. */
async function orgWithEditors(owner: Client, members: ReadonlyArray<{ userId: string }>): Promise<string> {
  const org: Res<{ orgId: string }> = await owner.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  for (const u of members) {
    const m = await owner.post(`/host/openwop-app/test/orgs/${encodeURIComponent(org.body.orgId)}/members`, { displayName: 'M', subject: u.userId, roles: ['editor'] });
    expect(m.status, JSON.stringify(m.body)).toBe(201);
  }
  return org.body.orgId;
}

async function createList(owner: Client, body: Record<string, unknown>): Promise<PriorityList> {
  const r: Res<PriorityList> = await owner.post(L, body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

async function createIdea(owner: Client, base: string, title: string): Promise<KanbanCard> {
  const r: Res<KanbanCard> = await owner.post(`${base}/ideas`, { title });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

/** The list's single idea, as `c` sees it. */
async function theIdea(c: Client, base: string): Promise<RankedIdea> {
  const r: Res<{ ideas: RankedIdea[] }> = await c.get(`${base}/ideas`);
  expect(r.status).toBe(200);
  expect(r.body.ideas).toHaveLength(1);
  return r.body.ideas[0];
}

async function vote(c: Client, base: string, ideaId: string, scores: Record<string, number>): Promise<ScoreResult> {
  const r: Res<ScoreResult> = await c.put(`${base}/ideas/${encodeURIComponent(ideaId)}/scores`, { scores });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}

const CONFIG_AUTHORITY = 'requires being the list owner or an org admin';

const L = '/host/openwop-app/priority-matrix/lists';
// Weighted preset criterion ids; score one benefit criterion so the aggregate is easy to reason about.
const A = { 'strategic-alignment': 8, roi: 8, urgency: 8, 'compliance-risk': 8, cost: 2 };
const B = { 'strategic-alignment': 2, roi: 2, urgency: 2, 'compliance-risk': 2, cost: 8 };
const PRIORITY_A = 8.15;
const PRIORITY_B = 2.15;

describe('priority-matrix multi-voter (ADR 0059)', () => {
  it('aggregates two members’ independent votes; neither overwrites the other', async () => {
    const tenantId = `org:mv-${Date.now()}-${n++}`;
    const owner = client();
    await signup(owner, { tenantId });
    const member = client();
    const memberUser = await signup(member, { tenantId });
    const orgId = await orgWithEditors(owner, [memberUser]);

    const list = await createList(owner, { orgId, name: 'Council', presetId: 'weighted', votingMode: 'multi-voter', voteAggregation: 'mean' });
    expect(list.votingMode).toBe('multi-voter');
    const base = `${L}/${encodeURIComponent(list.id)}`;
    const idea = await createIdea(owner, base, 'Shared idea');

    // Owner votes high, member votes low — independently.
    expect((await vote(owner, base, idea.id, A)).voterCount).toBe(1);
    expect((await vote(member, base, idea.id, B)).voterCount).toBe(2); // member did NOT overwrite the owner

    // Owner's read: aggregate priority + their own vote preserved; two voters counted.
    const ownerView = await theIdea(owner, base);
    expect(ownerView.voterCount).toBe(2);
    expect(ownerView.myScores?.roi).toBe(8);            // owner sees their own vote
    // Aggregate = the per-criterion MEAN of A and B (5 everywhere), which sits strictly
    // between the two solo scores.
    const aggregate = ownerView.computedPriority;
    expect(aggregate).toBe(5.15);
    expect(aggregate).toBeGreaterThan(PRIORITY_B);
    expect(aggregate).toBeLessThan(PRIORITY_A);
    // Member's read sees their own low vote, same aggregate.
    const memberView = await theIdea(member, base);
    expect(memberView.myScores?.roi).toBe(2);
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
    const orgId = await orgWithEditors(owner, [m1User, m2User]);
    const list = await createList(owner, { orgId, name: 'Median', presetId: 'weighted', votingMode: 'multi-voter', voteAggregation: 'median' });
    expect(list.voteAggregation).toBe('median');
    const base = `${L}/${encodeURIComponent(list.id)}`;
    const idea = await createIdea(owner, base, 'Skewed');
    // Skew: two high votes and one low. Median picks A on every criterion; the mean is
    // pulled toward B (8,8,2 → 6; cost 2,2,8 → 4).
    for (const [c, s] of [[owner, A], [m1, A], [m2, B]] as const) await vote(c, base, idea.id, s);
    const median = (await theIdea(owner, base)).computedPriority;
    expect(median).toBe(PRIORITY_A);

    expect((await owner.patch(base, { voteAggregation: 'mean' })).status).toBe(200);
    const mean = (await theIdea(owner, base)).computedPriority;
    expect(mean).toBe(6.15);
    expect(mean).not.toBe(median);
  });

  it('weighted voters shift the aggregate toward the heavier-weighted voter (ADR 0059)', async () => {
    const tenantId = `org:mv-${Date.now()}-${n++}`;
    const owner = client();
    const ownerUser = await signup(owner, { tenantId });
    const member = client();
    const memberUser = await signup(member, { tenantId });
    const orgId = await orgWithEditors(owner, [memberUser]);

    const list = await createList(owner, { orgId, name: 'Weighted', presetId: 'weighted', votingMode: 'multi-voter', voteAggregation: 'mean' });
    const base = `${L}/${encodeURIComponent(list.id)}`;
    const idea = await createIdea(owner, base, 'Weighted idea');

    // Owner votes high (A), member votes low (B) — equal weight ⇒ mean halfway.
    await vote(owner, base, idea.id, A);
    await vote(member, base, idea.id, B);
    const equalWeight = (await theIdea(owner, base)).computedPriority;
    expect(equalWeight).toBe(5.15);

    // Weight the owner 10×, the member 1× — the aggregate must move toward the owner's high vote.
    const patched: Res<PriorityList> = await owner.patch(base, { voterWeights: { [ownerUser.userId]: 10, [memberUser.userId]: 1 } });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.voterWeights?.[ownerUser.userId]).toBe(10);
    const weighted = (await theIdea(owner, base)).computedPriority;
    expect(weighted).toBe(7.61);
    expect(weighted).toBeGreaterThan(equalWeight); // heavier owner pulls priority up

    // The caller's own vote is untouched by re-weighting (weights aggregate, never overwrite).
    expect((await theIdea(owner, base)).myScores?.roi).toBe(8);
  });

  it('uniform non-default weights match the unweighted aggregate in median mode (code-review 2026-06-16)', async () => {
    const tenantId = `org:mv-${Date.now()}-${n++}`;
    const owner = client();
    const ownerUser = await signup(owner, { tenantId });
    const member = client();
    const memberUser = await signup(member, { tenantId });
    const orgId = await orgWithEditors(owner, [memberUser]);
    const list = await createList(owner, { orgId, name: 'UnifMedian', presetId: 'weighted', votingMode: 'multi-voter', voteAggregation: 'median' });
    const base = `${L}/${encodeURIComponent(list.id)}`;
    const idea = await createIdea(owner, base, 'Idea');

    // Two voters split high/low → unweighted median averages the middle pair.
    await vote(owner, base, idea.id, A);
    await vote(member, base, idea.id, B);
    const defaultPriority = (await theIdea(owner, base)).computedPriority;
    expect(defaultPriority).toBe(5.15);

    // Raise BOTH voters to the SAME non-1 weight: equal weight ⇒ identical aggregate.
    // (Before the fix this took the weighted path and the lower-weighted-median diverged,
    // to 3.06 on these votes.)
    const patched: Res<PriorityList> = await owner.patch(base, { voterWeights: { [ownerUser.userId]: 5, [memberUser.userId]: 5 } });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.voterWeights).toEqual({ [ownerUser.userId]: 5, [memberUser.userId]: 5 });
    const uniformPriority = (await theIdea(owner, base)).computedPriority;
    expect(uniformPriority).toBe(defaultPriority);
  });

  it('setting voterWeights is config-authority-gated (a co-tenant editor gets 403)', async () => {
    const tenantId = `org:mv-${Date.now()}-${n++}`;
    const owner = client();
    const ownerUser = await signup(owner, { tenantId });
    const member = client();
    const memberUser = await signup(member, { tenantId });
    const orgId = await orgWithEditors(owner, [memberUser]);
    const list = await createList(owner, { orgId, name: 'Gated', presetId: 'weighted', votingMode: 'multi-voter' });

    // A co-tenant editor cannot set per-voter weights — refused by the config-authority
    // gate itself, not by a missing workspace:write (same code, different message).
    const refused: Res<{ error: string; message: string }> = await member.patch(`${L}/${encodeURIComponent(list.id)}`, { voterWeights: { [memberUser.userId]: 10 } });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('forbidden_scope');
    expect(refused.body.message).toContain(CONFIG_AUTHORITY);
    // The config authority (creator) can; invalid weights (out of 1..10) are dropped.
    const ok: Res<PriorityList> = await owner.patch(`${L}/${encodeURIComponent(list.id)}`, { voterWeights: { [ownerUser.userId]: 5, [memberUser.userId]: 99 } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.voterWeights).toEqual({ [ownerUser.userId]: 5 }); // 99 is out of range → dropped
  });

  it('switching voting mode is config-authority-gated; a single-mode list is unchanged', async () => {
    const tenantId = `org:mv-${Date.now()}-${n++}`;
    const owner = client();
    await signup(owner, { tenantId });
    const member = client();
    const memberUser = await signup(member, { tenantId });
    const orgId = await orgWithEditors(owner, [memberUser]);
    const list = await createList(owner, { orgId, name: 'Default single' });
    expect(list.votingMode).toBe('single'); // default

    // A co-tenant editor cannot flip the scoring mode (config authority).
    const refused: Res<{ error: string; message: string }> = await member.patch(`${L}/${encodeURIComponent(list.id)}`, { votingMode: 'multi-voter' });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('forbidden_scope');
    expect(refused.body.message).toContain(CONFIG_AUTHORITY);
    // The owner can.
    const ok: Res<PriorityList> = await owner.patch(`${L}/${encodeURIComponent(list.id)}`, { votingMode: 'multi-voter' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.votingMode).toBe('multi-voter');
  });
});
