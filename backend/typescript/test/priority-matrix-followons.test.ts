/**
 * Priority Matrix follow-ons — ROUTE harness:
 *   - ADR 0060: portfolio normalization (list-relative + percentile)
 *   - ADR 0059: per-voter vote breakdown (config-authority gated)
 *   - ADR 0059: single→multi-voter vote seeding (scores survive the switch)
 *
 * Sabotage map (wave 15, `w15g1-fo-*`): the list-relative scale, the percentile
 * DIRECTION (caught by the rank-order + middle value; the re-sort hid it before), the
 * `none` default, the `/votes` config-authority gate, the multi-voter breakdown, and the
 * single→multi seeding each turn a case red.
 * CEILING: `planningHarness.ts` returns untyped JSON bodies (shared infra, 19 importers);
 * the reads here are narrowed by annotated assignment, not casts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client } from './planningHarness.js';
import type { PortfolioItem, VoteBreakdownEntry } from '../src/features/priority-matrix/priorityMatrixService.js';

type Portfolio = { normalize: string; items: PortfolioItem[] };

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
  const r = await c.post('/host/openwop-app/test/login', { email: uniqEmail('fo'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}

const L = '/host/openwop-app/priority-matrix/lists';
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
    const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    const list = (await owner.post(L, { orgId, name: 'L', presetId: 'weighted' })).body;
    await scoredIdea(owner, list.id, 'top', HIGH);
    await scoredIdea(owner, list.id, 'mid', MID);
    await scoredIdea(owner, list.id, 'low', LOW);

    const raw: Portfolio = (await owner.get(`${L.replace('/lists', '')}/portfolio`)).body;
    expect(raw.normalize).toBe('none');
    expect(raw.items[0]!.normalizedPriority).toBeUndefined();

    const rel: Portfolio = (await owner.get(`${L.replace('/lists', '')}/portfolio?normalize=list-relative`)).body;
    expect(rel.normalize).toBe('list-relative');
    expect(rel.items.map((i) => i.title)).toEqual(['top', 'mid', 'low']);
    expect(rel.items[0]!.normalizedPriority).toBe(100); // top of its list
    expect(rel.items[1]!.normalizedPriority).toBeGreaterThan(0);
    expect(rel.items[1]!.normalizedPriority).toBeLessThan(100);

    const pct: Portfolio = (await owner.get(`${L.replace('/lists', '')}/portfolio?normalize=percentile`)).body;
    // The route re-sorts by the normalized value, so 100…0 alone would survive an
    // inverted direction — the ORDER of the ideas is what carries the claim.
    expect(pct.items.map((i) => i.title)).toEqual(['top', 'mid', 'low']);
    expect(pct.items.map((i) => i.normalizedPriority)).toEqual([100, 50, 0]); // rank 1/2/3 of 3
  });
});

describe('vote breakdown (ADR 0059) — config-authority gated', () => {
  it('owner sees per-voter scores; a co-tenant editor is 403', async () => {
    const tenantId = `org:fo-${Date.now()}-${n++}`;
    const owner = client();
    const ownerUser = await signup(owner, { tenantId });
    const member = client();
    const memberUser = await signup(member, { tenantId });
    const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: ['editor'] });
    const list = (await owner.post(L, { orgId, name: 'Council', presetId: 'weighted', votingMode: 'multi-voter' })).body;
    const idea = (await owner.post(`${L}/${encodeURIComponent(list.id)}/ideas`, { title: 'shared' })).body;
    await owner.put(`${L}/${encodeURIComponent(list.id)}/ideas/${encodeURIComponent(idea.id)}/scores`, { scores: HIGH });
    await member.put(`${L}/${encodeURIComponent(list.id)}/ideas/${encodeURIComponent(idea.id)}/scores`, { scores: LOW });

    const votesUrl = `${L}/${encodeURIComponent(list.id)}/ideas/${encodeURIComponent(idea.id)}/votes`;
    const ownerView = await owner.get(votesUrl);
    expect(ownerView.status, JSON.stringify(ownerView.body)).toBe(200);
    const votes: VoteBreakdownEntry[] = ownerView.body.votes;
    // Both voters, each with THEIR OWN ballot.
    expect(votes.map((v) => v.voterId).sort()).toEqual([ownerUser.userId, memberUser.userId].sort());
    expect(votes.find((v) => v.voterId === ownerUser.userId)?.scores).toEqual(HIGH);
    expect(votes.find((v) => v.voterId === memberUser.userId)?.scores).toEqual(LOW);
    // The editor (not creator, not org-admin) can't see the breakdown.
    expect((await member.get(votesUrl)).status).toBe(403);
  });
});

describe('single→multi-voter seeding (ADR 0059)', () => {
  it('seeds the creator’s vote from the existing shared score so priority survives the switch', async () => {
    const owner = client();
    await signup(owner);
    const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
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
    const votes: VoteBreakdownEntry[] = (await owner.get(`${L}/${encodeURIComponent(list.id)}/ideas/${encodeURIComponent(idea)}/votes`)).body.votes;
    expect(votes).toHaveLength(1);
    expect(votes[0]!.scores.roi).toBe(10);
  });
});
