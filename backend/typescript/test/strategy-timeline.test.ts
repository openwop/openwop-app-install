/**
 * Timeline projection + scoring integrity (ADR 0234) — ROUTE coverage:
 *   - initiative date/dependsOn validation (bad date / dangling dep / self-dep)
 *   - GET /strategy/:id/timeline: initiatives + linked idea schedules with slip
 *     flags computed at read (overdue, dependencyLate)
 *   - GET score-history: the B4 trail + the "why ranked here" breakdown
 *   - PlanningSession.rationale set at create, PATCHable
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, type Client } from './planningHarness.js';

let BASE = '';
let closeApp: () => Promise<void>;
let n = 0;

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; closeApp = h.close;
  await enableToggle('strategy', 'on');
  await enableToggle('priority-matrix', 'on');
});
afterAll(async () => { await closeApp(); });

const client = (): Client => makeClient(() => BASE);

const S = '/v1/host/openwop-app/strategy';
const PM = '/v1/host/openwop-app/priority-matrix';

async function login(): Promise<{ c: ReturnType<typeof client>; orgId: string }> {
  const c = client();
  expect((await c.post('/v1/host/openwop-app/test/login', { email: `tl-${Date.now()}-${n++}@acme.test`, tenantId: `org:tl-${Date.now()}-${n++}` })).status).toBe(201);
  const orgId = (await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
  return { c, orgId };
}

describe('initiative dates + dependencies (ADR 0234 §C6)', () => {
  it('validates dates and dependsOn membership', async () => {
    const { c, orgId } = await login();
    expect((await c.post(S, { orgId, title: 'Bad', initiatives: [{ title: 'X', startDate: 'not-a-date' }] })).status).toBe(400);
    expect((await c.post(S, { orgId, title: 'Bad', initiatives: [{ title: 'X', startDate: '2027-02-01', endDate: '2027-01-01' }] })).status).toBe(400);
    expect((await c.post(S, { orgId, title: 'Bad', initiatives: [{ id: 'a', title: 'A', dependsOn: ['ghost'] }] })).status).toBe(400);
    expect((await c.post(S, { orgId, title: 'Bad', initiatives: [{ id: 'a', title: 'A', dependsOn: ['a'] }] })).status).toBe(400);
  });

  it('projects the timeline with overdue + dependencyLate flags', async () => {
    const { c, orgId } = await login();
    const s = (await c.post(S, {
      orgId, title: 'Dated plan',
      initiatives: [
        { id: 'found', title: 'Foundation', startDate: '2020-01-01', endDate: '2030-06-30' },
        { id: 'launch', title: 'Launch', startDate: '2030-01-01', endDate: '2030-12-31', dependsOn: ['found'] },
        { id: 'past', title: 'Overdue thing', startDate: '2020-01-01', endDate: '2020-06-30' },
      ],
    })).body;
    expect(s.id, JSON.stringify(s)).toBeTruthy();

    const tl = await c.get(`${S}/${s.id}/timeline`);
    expect(tl.status, JSON.stringify(tl.body)).toBe(200);
    interface TlRow { id: string; overdue?: boolean; dependencyLate?: string[] }
    const byId = new Map<string, TlRow>((tl.body.items as TlRow[]).map((i) => [i.id, i]));
    expect(byId.get('past')?.overdue).toBe(true);                   // ended 2020, not done
    expect(byId.get('launch')?.dependencyLate).toEqual(['found']);  // found ends after launch starts
    expect(byId.get('found')?.overdue).toBeUndefined();             // ends 2030

    // Linked idea schedules join the projection.
    const listId = (await c.post(`${PM}/lists`, { orgId, name: 'Bets', presetId: 'weighted' })).body.id;
    await c.post(`${PM}/lists/${listId}/ideas`, { title: 'Dated idea' });
    const cardId = (await c.get(`${PM}/lists/${listId}/ideas`)).body.ideas[0].card.id;
    await c.put(`${PM}/lists/${listId}/ideas/${cardId}/schedule`, { targetDate: '2031-03-01' });
    await c.put(`${S}/${s.id}/links`, { links: [{ kind: 'priority-idea', listId, cardId }] });
    const tl2 = await c.get(`${S}/${s.id}/timeline`);
    expect(tl2.body.items.some((i: any) => i.kind === 'idea-schedule' && i.title === 'Dated idea')).toBe(true);

    // The portfolio variant includes this strategy's items.
    const port = await c.get(`${S}/timeline`);
    expect(port.status).toBe(200);
    expect(port.body.items.some((i: any) => i.source.strategyId === s.id)).toBe(true);
  });
});

describe('score history + breakdown + session rationale (ADR 0234 §C7)', () => {
  it('returns the B4 trail with a per-criterion breakdown; rationale persists', async () => {
    const { c, orgId } = await login();
    const listId = (await c.post(`${PM}/lists`, { orgId, name: 'Scored', presetId: 'weighted' })).body.id;
    await c.post(`${PM}/lists/${listId}/ideas`, { title: 'Scored idea' });
    const cardId = (await c.get(`${PM}/lists/${listId}/ideas`)).body.ideas[0].card.id;
    const list = (await c.get(`${PM}/lists/${listId}/ideas`)).body;
    void list;

    // Score twice → two history rows with prior/new priorities.
    const criteria = (await c.get(`${PM}/lists`)).body.lists.find((l: any) => l.id === listId).criteriaSet.criteria;
    const scoresA: Record<string, number> = Object.fromEntries(criteria.map((cr: any) => [cr.id, 4]));
    const scoresB: Record<string, number> = Object.fromEntries(criteria.map((cr: any) => [cr.id, 8]));
    await c.put(`${PM}/lists/${listId}/ideas/${cardId}/scores`, { scores: scoresA });
    await c.put(`${PM}/lists/${listId}/ideas/${cardId}/scores`, { scores: scoresB });

    const hist = await c.get(`${PM}/lists/${listId}/ideas/${cardId}/score-history`);
    expect(hist.status, JSON.stringify(hist.body)).toBe(200);
    expect(hist.body.history).toHaveLength(2);
    expect(hist.body.history[1].priorPriority).toBe(hist.body.history[0].newPriority);
    // The "why ranked here" breakdown: every criterion carries weight + weighted component.
    expect(hist.body.breakdown).toHaveLength(criteria.length);
    for (const b of hist.body.breakdown) {
      expect(b.weight).toBeGreaterThan(0);
      expect(b.score).toBe(8);
      expect(b.weighted).toBe(8 * b.weight);
    }
    expect(hist.body.computedPriority).toBeGreaterThan(0);

    // Session rationale: set at create, PATCHable, '' clears.
    const session = (await c.post(`${PM}/lists/${listId}/sessions`, { mode: 'top-n', n: 1, rationale: 'Q3 focus: EU.' })).body;
    expect(session.rationale).toBe('Q3 focus: EU.');
    const patched = (await c.patch(`${PM}/lists/${listId}/sessions/${session.id}`, { rationale: 'Revised: EU + churn.' })).body;
    expect(patched.rationale).toBe('Revised: EU + churn.');
  });
});

describe('decision records (ADR 0233 §C8)', () => {
  it('requires documents; persists the record + canonical link when enabled', async () => {
    const { c, orgId } = await login();
    const s = (await c.post(S, { orgId, title: 'Decided plan' })).body;

    // documents OFF ⇒ honest 409 (the Document IS the record).
    await enableToggle('documents', 'off');
    expect((await c.post(`${S}/${s.id}/decisions`, { title: 'Pick EU', decision: 'We enter the EU in Q1.' })).status).toBe(409);

    // documents ON ⇒ the record persists and links canonically.
    await enableToggle('documents', 'on');
    try {
      const r = await c.post(`${S}/${s.id}/decisions`, {
        title: 'Pick EU', decision: 'We enter the EU in Q1.',
        rationale: 'Largest under-served segment.', alternatives: 'APAC first (deferred).',
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.documentId).toBeTruthy();
      expect(r.body.strategy.links.some((l: any) => l.kind === 'document' && l.documentId === r.body.documentId)).toBe(true);
      expect((await c.post(`${S}/${s.id}/decisions`, { title: 'No decision text' })).status).toBe(400);
    } finally {
      await enableToggle('documents', 'off');
    }
  });
});
