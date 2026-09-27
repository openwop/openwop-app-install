/**
 * Priority Matrix — idea edit / delete / clone (ADR 0259). ROUTE harness.
 * Verifies the three per-idea CRUD ops added on top of create/score:
 *   - PATCH  /lists/:listId/ideas/:cardId          → edit title/description
 *   - DELETE /lists/:listId/ideas/:cardId          → delete (idempotent 404)
 *   - POST   /lists/:listId/ideas/:cardId/clone     → clone (copies single-mode scores)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client } from './planningHarness.js';

let BASE = '';
let closeApp: () => Promise<void>;

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; closeApp = h.close;
  await enableToggle('priority-matrix', 'on');
});
afterAll(async () => { await closeApp(); });

const client = (): Client => makeClient(() => BASE);
const L = '/v1/host/openwop-app/priority-matrix/lists';
const HIGH = { 'strategic-alignment': 9, roi: 8, urgency: 8, 'compliance-risk': 9, cost: 4 };

async function signup(c: Client): Promise<void> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('idea-crud') });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

async function newList(c: Client): Promise<string> {
  const orgId = (await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
  return (await c.post(L, { orgId, name: 'Roadmap', presetId: 'weighted' })).body.id;
}

const listIdeas = async (c: Client, listId: string): Promise<Array<{ card: { id: string; title: string; description?: string }; scores: Record<string, number>; computedPriority: number }>> =>
  (await c.get(`${L}/${encodeURIComponent(listId)}/ideas`)).body.ideas;

describe('idea edit (ADR 0259)', () => {
  it('PATCH updates title + description; other ideas are untouched', async () => {
    const c = client(); await signup(c);
    const listId = await newList(c);
    const a = (await c.post(`${L}/${encodeURIComponent(listId)}/ideas`, { title: 'Old title', description: 'old' })).body;
    (await c.post(`${L}/${encodeURIComponent(listId)}/ideas`, { title: 'Untouched' }));

    const res = await c.patch(`${L}/${encodeURIComponent(listId)}/ideas/${encodeURIComponent(a.id)}`, { title: 'New title', description: 'new body' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.title).toBe('New title');

    const ideas = await listIdeas(c, listId);
    const edited = ideas.find((r) => r.card.id === a.id);
    expect(edited?.card.title).toBe('New title');
    expect(edited?.card.description).toBe('new body');
    expect(ideas.some((r) => r.card.title === 'Untouched')).toBe(true);
  });

  it('rejects an empty title with 400', async () => {
    const c = client(); await signup(c);
    const listId = await newList(c);
    const a = (await c.post(`${L}/${encodeURIComponent(listId)}/ideas`, { title: 'Keep me' })).body;
    const res = await c.patch(`${L}/${encodeURIComponent(listId)}/ideas/${encodeURIComponent(a.id)}`, { title: '   ' });
    expect(res.status).toBe(400);
    // The title is unchanged after a rejected edit.
    expect((await listIdeas(c, listId))[0].card.title).toBe('Keep me');
  });
});

describe('idea delete (ADR 0259)', () => {
  it('DELETE removes the idea (204) and is idempotent (404 on the second call)', async () => {
    const c = client(); await signup(c);
    const listId = await newList(c);
    const a = (await c.post(`${L}/${encodeURIComponent(listId)}/ideas`, { title: 'Doomed' })).body;
    (await c.post(`${L}/${encodeURIComponent(listId)}/ideas`, { title: 'Survivor' }));

    const del1 = await c.del(`${L}/${encodeURIComponent(listId)}/ideas/${encodeURIComponent(a.id)}`);
    expect(del1.status, JSON.stringify(del1.body)).toBe(204);

    const ideas = await listIdeas(c, listId);
    expect(ideas.map((r) => r.card.title)).toEqual(['Survivor']);

    const del2 = await c.del(`${L}/${encodeURIComponent(listId)}/ideas/${encodeURIComponent(a.id)}`);
    expect(del2.status).toBe(404);
  });
});

describe('idea clone (ADR 0259)', () => {
  it('POST clone creates a copy that carries the source title suffix + scores', async () => {
    const c = client(); await signup(c);
    const listId = await newList(c);
    const a = (await c.post(`${L}/${encodeURIComponent(listId)}/ideas`, { title: 'Enterprise SSO', description: 'roll it out' })).body;
    await c.put(`${L}/${encodeURIComponent(listId)}/ideas/${encodeURIComponent(a.id)}/scores`, { scores: HIGH });

    const res = await c.post(`${L}/${encodeURIComponent(listId)}/ideas/${encodeURIComponent(a.id)}/clone`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.id).not.toBe(a.id);

    const ideas = await listIdeas(c, listId);
    expect(ideas).toHaveLength(2);
    const clone = ideas.find((r) => r.card.id === res.body.id);
    expect(clone?.card.title).toBe('Enterprise SSO (copy)');
    expect(clone?.card.description).toBe('roll it out');
    // Single-mode scores are copied, so the clone is ranked with the same priority.
    const orig = ideas.find((r) => r.card.id === a.id);
    expect(clone?.computedPriority).toBeCloseTo(orig?.computedPriority ?? -1, 5);
  });

  it('honors a caller-supplied title override', async () => {
    const c = client(); await signup(c);
    const listId = await newList(c);
    const a = (await c.post(`${L}/${encodeURIComponent(listId)}/ideas`, { title: 'Base' })).body;
    const res = await c.post(`${L}/${encodeURIComponent(listId)}/ideas/${encodeURIComponent(a.id)}/clone`, { title: 'Base — variant B' });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Base — variant B');
  });
});
