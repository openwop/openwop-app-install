/**
 * ADR 0534 P5 — the ranking route, tested through the HTTP boundary.
 *
 * The unit suites cover the predicate and the surface, but toggle gating,
 * session binding and tenant isolation are only observable at the boundary — a
 * service-level test cannot see a route that is unregistered, ungated, or
 * reachable by the wrong caller. This is the suite that would catch that.
 *
 * Sabotage-witnessed (wave 64, probes 8fw5g1-ws-*): the toggle gate, the board's
 * tenant fence (stranger + anon), the score projection (ordering + reasons) and the
 * #4496 caller hand-off to the subject-access seam each turn their case red.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client } from './planningHarness.js';
import { createBoard } from '../src/host/kanbanService.js';
import type { RankedCardView } from '../src/features/work-selection/agentTools.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE = '';
let closeApp: () => Promise<void>;

beforeAll(async () => {
  const h = await bootPlanningApp();
  BASE = h.base;
  closeApp = h.close;
});
afterAll(async () => { await closeApp(); });

const client = (): Client => makeClient(() => BASE);

async function signup(c: Client): Promise<void> {
  const r = await c.post('/host/openwop-app/test/login', { email: uniqEmail('ws') });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

/** A board owned by the signed-in caller, with two To Do cards of differing priority. */
async function seedBoard(c: Client): Promise<string> {
  const board = await c.post('/host/openwop-app/kanban/boards', {
    name: 'Agent board',
    ownerSubject: { kind: 'agent', id: 'roster-route-1' },
    columns: [
      { id: 'todo', name: 'To Do' },
      { id: 'working', name: 'Working' },
      { id: 'done', name: 'Done', terminal: true },
    ],
  });
  expect(board.status, JSON.stringify(board.body)).toBe(201);
  const boardId = board.body.board?.id ?? board.body.id;

  for (const [title, priority] of [['low one', 'low'], ['high one', 'high']] as const) {
    const card = await c.post(`/host/openwop-app/kanban/boards/${boardId}/cards`, {
      title, columnId: 'todo', priority,
    });
    expect(card.status, JSON.stringify(card.body)).toBe(201);
  }
  return boardId;
}

const RANKING = (boardId: string) => `/host/openwop-app/work-selection/boards/${boardId}/ranking`;

describe('ADR 0534 — the ranking route', () => {
  it('404s when the feature is OFF — a ranking would describe a decision the host is not making', async () => {
    await enableToggle('work-selection', 'off');
    const c = client();
    await signup(c);
    const boardId = await seedBoard(c);

    const res = await c.get(RANKING(boardId));
    expect(res.status).toBe(404);
    // The feature gate's refusal, not an unregistered route's.
    expect(res.body).toMatchObject({ error: 'not_found', message: 'Ranked work selection is not enabled for this tenant.' });
  });

  it('ranks the To Do lane when ON, highest first, with the reasons', async () => {
    await enableToggle('work-selection', 'on');
    const c = client();
    await signup(c);
    const boardId = await seedBoard(c);

    const res = await c.get(RANKING(boardId));
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const ranked: RankedCardView[] = res.body.ranked;
    expect(ranked.map((r) => r.title)).toEqual(['high one', 'low one']);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2]);
    expect(ranked[0]!.why.length, 'each card explains itself').toBeGreaterThan(0);
    expect(ranked[1]!.why.length).toBeGreaterThan(0);
  });

  it('another tenant reads EMPTY for the same board id — no cross-tenant leak', async () => {
    await enableToggle('work-selection', 'on');
    const owner = client();
    await signup(owner);
    const boardId = await seedBoard(owner);

    // A DIFFERENT signed-in caller, i.e. a different tenant.
    const stranger = client();
    await signup(stranger);

    // Control: the owner DOES rank this board, so the stranger's empty answer is the fence.
    expect(((await owner.get(RANKING(boardId))).body.ranked as RankedCardView[]).length).toBe(2);
    const res = await stranger.get(RANKING(boardId));
    expect(res.status, 'empty rather than 403 — existence must not leak').toBe(200);
    expect(res.body.ranked).toEqual([]);
  });

  it('an anonymous caller sees nothing of an owned board', async () => {
    // This app gives every visitor its own tenant, so an unauthenticated read is
    // not itself an error — it resolves to an anon tenant that owns no boards.
    // The invariant that matters is therefore the BODY, not the status: an anon
    // caller must never see another tenant's cards.
    await enableToggle('work-selection', 'on');
    const owner = client();
    await signup(owner);
    const boardId = await seedBoard(owner);

    const anon = client();
    const res = await anon.get(RANKING(boardId));
    expect(res.body.ranked, 'an anon tenant must not read an owned board').toEqual([]);
  });

  it('#4496 — an anonymous owner ranks their own PROJECT board (the seam gets a caller)', async () => {
    // ADR 0839: the subject-access seam refuses an absent caller. A project-owned
    // board is membership-scoped, so the route must hand the seam the anon
    // session's principal; `req.userId` is undefined for an anonymous session.
    await enableToggle('work-selection', 'on');
    await enableToggle('projects', 'on');
    try {
      const anon = client();
      const orgId = (await anon.post('/host/openwop-app/orgs', { name: 'Anon org' })).body?.orgId as string;
      const project = await anon.post('/host/openwop-app/projects', { orgId, name: 'Anon project' });
      expect(project.status, JSON.stringify(project.body)).toBe(201);
      // The kanban create route does not bind a board to a project; seed the
      // project-owned board through the service, as the project surfaces do.
      const board = await createBoard({
        tenantId: project.body.tenantId,
        name: 'Project board',
        ownerSubject: { kind: 'project', id: project.body.id },
        columns: [{ id: 'todo', name: 'To Do' }, { id: 'working', name: 'Working' }, { id: 'done', name: 'Done', terminal: true }],
      });
      expect((await anon.post(`/host/openwop-app/kanban/boards/${board.id}/cards`, { title: 'anon card', columnId: 'todo' })).status).toBe(201);

      const res = await anon.get(RANKING(board.id));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const ranked: RankedCardView[] = res.body.ranked;
      expect(ranked.map((r) => r.title)).toEqual(['anon card']);
    } finally {
      // Back to the registry default (whatever it is), not a guessed status.
      const d = getToggleDefault('projects');
      if (d) await saveConfig(d, 'test');
    }
  });
});
