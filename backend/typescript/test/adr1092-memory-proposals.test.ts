/**
 * ADR 1092 D2 — memory writes a person approves. An agent's proposal is not
 * memory until a writer approves it (then it is a project note); a reader can
 * see but not decide; a decided proposal can't be decided again; the same text
 * files once; the pending cap holds; proposals go with the project and lose the
 * person's name on erasure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, type Client } from './planningHarness.js';
import { createProject, deleteProject, projectSubject } from '../src/features/projects/projectsService.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { PROJECTS_MEMORY_PROPOSE_TOOL_ID } from '../src/features/projects/agentTools.js';
import { PROPOSALS_PENDING_CAP, listMemoryProposals } from '../src/features/projects/memoryProposals.js';
import { listSubjectNotes } from '../src/host/subjectMemory.js';
import { eraseSubject } from '../src/host/subjectErasure.js';

const H = '/host/openwop-app';
let BASE = '';
let closeApp: () => Promise<void>;
let n = 0;
beforeAll(async () => { const h = await bootPlanningApp(); BASE = h.base; closeApp = h.close; await enableToggle('projects', 'on').catch(() => undefined); });
afterAll(async () => { await closeApp(); });

async function firm(): Promise<{ tenantId: string; owner: Client; ownerId: string; orgId: string; viewer: Client }> {
  const tenantId = `org:m1092-${Date.now()}-${n++}`;
  const owner = makeClient(() => BASE);
  const ownerId = (await owner.post(`${H}/test/login`, { email: `o-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId as string;
  const orgId = (await owner.post(`${H}/orgs`, { name: 'Studio' })).body.orgId as string;
  const viewer = makeClient(() => BASE);
  const viewerId = (await viewer.post(`${H}/test/login`, { email: `v-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId as string;
  await owner.post(`${H}/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'Vic', subject: viewerId, roles: ['viewer'] });
  return { tenantId, owner, ownerId, orgId, viewer };
}
const propose = async (tenantId: string, actingUserId: string | undefined, input: Record<string, unknown>) =>
  JSON.parse((await createAgentToolProvider({ tenantId, runId: 'r-1092', ...(actingUserId ? { actingUserId } : {}) }).executeTool({ name: PROJECTS_MEMORY_PROPOSE_TOOL_ID, input })).content);

describe('ADR 1092 D2 — memory proposals', () => {
  it('a proposal waits; a writer approves it into memory; a reader cannot decide', async () => {
    const f = await firm();
    const p = await createProject(f.tenantId, f.orgId, { name: 'Atlas' }, f.ownerId);
    expect(await propose(f.tenantId, undefined, { projectId: p.id, text: 'x' })).toMatchObject({ error: { code: 'acting_user_required' } });
    const a = await propose(f.tenantId, f.ownerId, { projectId: p.id, text: 'The client prefers unlacquered brass.' });
    expect(a).toMatchObject({ status: 'pending' });
    expect(await propose(f.tenantId, f.ownerId, { projectId: p.id, text: 'The client prefers unlacquered brass.' })).toMatchObject({ proposalId: a.proposalId }); // once
    expect((await listSubjectNotes(f.tenantId, projectSubject(p.id))).some((x) => String(x.content ?? x).includes('unlacquered'))).toBe(false);
    const list = await f.viewer.get(`${H}/projects/${encodeURIComponent(p.id)}/memory-proposals`);
    expect(list.status).toBe(200);
    expect(list.body.proposals).toHaveLength(1);
    expect((await f.viewer.post(`${H}/projects/${encodeURIComponent(p.id)}/memory-proposals/${a.proposalId}/approve`, {})).status).toBe(403);
    expect((await f.owner.post(`${H}/projects/${encodeURIComponent(p.id)}/memory-proposals/${a.proposalId}/sideways`, {})).status).toBe(404);
    const ok = await f.owner.post(`${H}/projects/${encodeURIComponent(p.id)}/memory-proposals/${a.proposalId}/approve`, {});
    expect(ok.status).toBe(200);
    expect(ok.body.proposal.status).toBe('approved');
    expect(JSON.stringify(await listSubjectNotes(f.tenantId, projectSubject(p.id)))).toContain('unlacquered brass');
    expect((await f.owner.post(`${H}/projects/${encodeURIComponent(p.id)}/memory-proposals/${a.proposalId}/dismiss`, {})).status).toBe(409);
  });

  it('caps pending proposals, and they go with the project and lose the name on erasure', async () => {
    const f = await firm();
    const p = await createProject(f.tenantId, f.orgId, { name: 'Harbor' }, f.ownerId);
    for (let k = 0; k < PROPOSALS_PENDING_CAP; k++) await propose(f.tenantId, f.ownerId, { projectId: p.id, text: `Fact ${k}` });
    expect(await propose(f.tenantId, f.ownerId, { projectId: p.id, text: 'One too many' })).toMatchObject({ error: { code: 'conflict' } });
    await eraseSubject(f.tenantId, f.ownerId);
    const after = await listMemoryProposals(f.tenantId, p.id);
    expect(after.every((r) => r.createdBy === 'user:[erased]' && r.text === '[erased]' && r.status === 'dismissed')).toBe(true);
    await deleteProject(f.tenantId, p.id);
    expect(await listMemoryProposals(f.tenantId, p.id)).toEqual([]);
  });
});
