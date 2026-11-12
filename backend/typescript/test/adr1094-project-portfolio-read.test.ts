/**
 * ADR 1094 — the paged portfolio read. One page of the projects the caller
 * can see, filtered by org, lead and status, with manual and computed health,
 * lead name, member count and next open milestone; a private project the
 * caller can't open never appears; the route is not swallowed by `/:id`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, type Client } from './planningHarness.js';
import { addProjectMember, createProject, setProjectVisibility, updateProject } from '../src/features/projects/projectsService.js';
import { registerProjectHealthProvider, __resetProjectHealthProviders } from '../src/host/projectHealthProviders.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { PROJECTS_PORTFOLIO_TOOL_ID } from '../src/features/projects/agentTools.js';

const H = '/host/openwop-app';
let BASE = '';
let closeApp: () => Promise<void>;
let n = 0;
beforeAll(async () => { const h = await bootPlanningApp(); BASE = h.base; closeApp = h.close; await enableToggle('projects', 'on').catch(() => undefined); });
afterAll(async () => { __resetProjectHealthProviders(); await closeApp(); });
beforeEach(() => __resetProjectHealthProviders());

async function firm(): Promise<{ tenantId: string; owner: Client; ownerId: string; orgId: string; viewer: Client; viewerId: string }> {
  const tenantId = `org:p1094-${Date.now()}-${n++}`;
  const owner = makeClient(() => BASE);
  const ownerId = (await owner.post(`${H}/test/login`, { email: `o-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId as string;
  const orgId = (await owner.post(`${H}/orgs`, { name: 'Studio' })).body.orgId as string;
  const viewer = makeClient(() => BASE);
  const viewerId = (await viewer.post(`${H}/test/login`, { email: `v-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId as string;
  await owner.post(`${H}/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'Vic Viewer', subject: viewerId, roles: ['viewer'] });
  return { tenantId, owner, ownerId, orgId, viewer, viewerId };
}

describe('ADR 1094 — the portfolio read', () => {
  it('pages, filters, carries health, lead and next milestone, and hides private projects', async () => {
    const f = await firm();
    const a = await createProject(f.tenantId, f.orgId, { name: 'Alpha' }, f.ownerId);
    const b = await createProject(f.tenantId, f.orgId, { name: 'Bravo' }, f.ownerId);
    const c = await createProject(f.tenantId, f.orgId, { name: 'Charlie' }, f.ownerId);
    const old = await createProject(f.tenantId, f.orgId, { name: 'Zulu' }, f.ownerId);
    await updateProject(f.tenantId, old.id, { charter: { status: 'archived' } });
    await updateProject(f.tenantId, a.id, { charter: { health: 'on-track', status: 'active', milestones: [{ id: 'm2', title: 'Later', dueDate: '2027-06-01', done: false }, { id: 'm1', title: 'Soon', dueDate: '2027-02-01', done: false }, { id: 'm0', title: 'Done', dueDate: '2027-01-01', done: true }] } });
    await addProjectMember(f.tenantId, a.id, `user:${f.viewerId}`, 'lead');
    await setProjectVisibility(f.tenantId, c.id, 'private');
    registerProjectHealthProvider('t', async ({ project }) => (project.id === a.id ? { level: 'at-risk', reason: 'Late.', source: 'Test', asOf: '2027-01-25' } : undefined));

    const all = (await f.owner.get(`${H}/projects/portfolio?orgId=${encodeURIComponent(f.orgId)}`)).body as { rows: Array<Record<string, any>>; total: number };
    expect(all.rows.map((r) => r.name)).toEqual(['Alpha', 'Bravo', 'Charlie']); // archived left out
    expect(all.total).toBe(3);
    expect(all.rows[0]).toMatchObject({ id: a.id, status: 'active', access: 'write', health: { manual: 'on-track', computed: { level: 'at-risk' } }, lead: { name: 'Vic Viewer' }, memberCount: 1, nextMilestone: { title: 'Soon', dueDate: '2027-02-01' } });
    expect(all.rows[1]!.health).toEqual({ manual: null });

    const p1 = (await f.owner.get(`${H}/projects/portfolio?limit=2`)).body as { rows: unknown[]; nextCursor?: string; total: number };
    expect(p1.rows).toHaveLength(2);
    expect(p1.nextCursor).toBe('2');
    const p2 = (await f.owner.get(`${H}/projects/portfolio?limit=2&cursor=2`)).body as { rows: unknown[]; nextCursor?: string };
    expect(p2.rows).toHaveLength(1);
    expect(p2.nextCursor).toBeUndefined();

    expect(((await f.owner.get(`${H}/projects/portfolio?status=archived`)).body as { rows: Array<{ name: string }> }).rows.map((r) => r.name)).toEqual(['Zulu']);
    expect(((await f.viewer.get(`${H}/projects/portfolio?lead=me`)).body as { rows: Array<{ id: string }> }).rows.map((r) => r.id)).toEqual([a.id]);
    // A lead ref taken from a row filters the same way.
    expect(((await f.owner.get(`${H}/projects/portfolio?lead=${encodeURIComponent(`user:${f.viewerId}`)}`)).body as { rows: Array<{ id: string }> }).rows.map((r) => r.id)).toEqual([a.id]);
    // The viewer never sees the private project.
    expect(((await f.viewer.get(`${H}/projects/portfolio`)).body as { rows: Array<{ id: string }> }).rows.map((r) => r.id)).not.toContain(c.id);
    expect(b.id).toBeTruthy();
  });

  it('ADR 1095 — the single-project read stamps the caller\'s own role', async () => {
    const f = await firm();
    const p = await createProject(f.tenantId, f.orgId, { name: 'Roles' }, f.ownerId);
    await addProjectMember(f.tenantId, p.id, `user:${f.viewerId}`, 'observer');
    expect((await f.viewer.get(`${H}/projects/${encodeURIComponent(p.id)}`)).body.myRole).toBe('observer');
    expect((await f.owner.get(`${H}/projects/${encodeURIComponent(p.id)}`)).body.myRole).toBeUndefined();
  });

  it('refuses bad inputs by field, and the tool needs a person', async () => {
    const f = await firm();
    for (const q of ['limit=0', 'limit=101', 'cursor=abc', 'status=lost']) {
      const r = await f.owner.get(`${H}/projects/portfolio?${q}`);
      expect(r.status, q).toBe(400);
    }
    const tool = createAgentToolProvider({ tenantId: f.tenantId, runId: 'r-1094' });
    expect(JSON.parse((await tool.executeTool({ name: PROJECTS_PORTFOLIO_TOOL_ID, input: {} })).content)).toMatchObject({ error: { code: 'acting_user_required' } });
    await createProject(f.tenantId, f.orgId, { name: 'Only' }, f.ownerId);
    const out = JSON.parse((await createAgentToolProvider({ tenantId: f.tenantId, runId: 'r-1094', actingUserId: f.ownerId }).executeTool({ name: PROJECTS_PORTFOLIO_TOOL_ID, input: { limit: 5 } })).content);
    expect(out.rows.map((r: { name: string }) => r.name)).toEqual(['Only']);
    expect(JSON.parse((await createAgentToolProvider({ tenantId: f.tenantId, runId: 'r-1094', actingUserId: f.ownerId }).executeTool({ name: PROJECTS_PORTFOLIO_TOOL_ID, input: { limit: 500 } })).content)).toMatchObject({ error: { code: 'validation_error' } });
  });
});
