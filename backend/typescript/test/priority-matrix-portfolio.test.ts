/**
 * Priority Matrix portfolio (ADR 0060) — ROUTE harness. Cross-list rollup across a
 * workspace's readable lists: merged + ranked by priority, topN respected, source
 * list + in-list rank surfaced, and cross-org lists excluded (no leak).
 *
 * What turns it red (w15 probes): `buildPortfolio` not sorting (the LOW list is created
 * FIRST, so insertion order is the wrong order) or sorting ascending; `topN` not applied;
 * `inListRank` not carried; `readableLists` dropping its per-org readability check
 * (the cross-org leak).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client } from './planningHarness.js';

let BASE = '';
let closeApp: () => Promise<void>;
let n = 0;

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; closeApp = h.close;
  await enableToggle('priority-matrix', 'on');
});
afterAll(async () => { await closeApp(); });

const client = (): Client => makeClient(() => BASE);
interface PortfolioItem { title: string; listName: string; inListRank: number; scoringModel: string; computedPriority: number }
interface Portfolio { items: PortfolioItem[]; lists: Array<{ name: string }> }
async function signup(c: Client, opts: { tenantId?: string } = {}): Promise<{ userId: string }> {
  const r = await c.post('/host/openwop-app/test/login', { email: uniqEmail('pf'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}

const L = '/host/openwop-app/priority-matrix/lists';
const P = '/host/openwop-app/priority-matrix/portfolio';
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
    const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    // LOW first: ranking has to beat insertion order to put List A's idea on top.
    await listWithScoredIdea(owner, orgId, 'List B', 'Bottom across all', LOW);
    await listWithScoredIdea(owner, orgId, 'List A', 'Top across all', HIGH);

    const res = await owner.get(P);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const pf = res.body as Portfolio;
    expect(pf.lists).toHaveLength(2);
    expect(pf.items).toHaveLength(2);
    // Merged + ranked by priority: the HIGH idea from List A leads.
    expect(pf.items[0].title).toBe('Top across all');
    expect(pf.items[0].listName).toBe('List A');
    expect(pf.items[0].inListRank).toBe(1);
    expect(pf.items[0].scoringModel).toBe('weighted');
    expect(pf.items[0].computedPriority).toBeGreaterThan(pf.items[1].computedPriority);
    expect(pf.items[1].title).toBe('Bottom across all');
    expect(pf.items[1].inListRank).toBe(1);
  });

  it('respects topN', async () => {
    const owner = client();
    await signup(owner);
    const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    await listWithScoredIdea(owner, orgId, 'L2', 'i2', LOW);
    await listWithScoredIdea(owner, orgId, 'L1', 'i1', HIGH);
    const pf = (await owner.get(`${P}?topN=1`)).body as Portfolio;
    expect(pf.items).toHaveLength(1);
    expect(pf.items[0].title, 'topN keeps the TOP item, not the first inserted').toBe('i1');
    expect(pf.lists).toHaveLength(2); // the rollup still reports both contributing lists
  });

  it('excludes a list in an org the caller cannot read (no cross-org leak)', async () => {
    const tenantId = `org:pf-${Date.now()}-${n++}`;
    const owner = client();
    await signup(owner, { tenantId });
    const member = client();
    const memberUser = await signup(member, { tenantId });
    const orgA = (await owner.post('/host/openwop-app/orgs', { name: 'Alpha' })).body.orgId;
    const orgB = (await owner.post('/host/openwop-app/orgs', { name: 'Bravo' })).body.orgId;
    await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgA)}/members`, { displayName: 'M', subject: memberUser.userId, roles: ['editor'] });
    await listWithScoredIdea(owner, orgA, 'A-list', 'visible', HIGH);
    await listWithScoredIdea(owner, orgB, 'B-list', 'hidden', HIGH);

    const pf = (await member.get(P)).body as Portfolio; // member reads only org A
    expect(pf.lists.map((l) => l.name)).toEqual(['A-list']);
    expect(pf.items.map((i) => i.title)).toEqual(['visible']);
  });
});
