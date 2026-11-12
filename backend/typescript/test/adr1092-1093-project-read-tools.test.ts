/**
 * ADR 1092 D1 and ADR 1093 — the project read tools for agents:
 * `openwop:projects.get` (one project in full, with computed health when a
 * provider answers) and `openwop:projects.knowledge.search` (the project's own
 * bound documents and memory). Both need an acting user who can read the
 * project; a missing and a hidden project answer the same not-found.
 */
import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { PROJECTS_GET_TOOL_ID, PROJECTS_KNOWLEDGE_SEARCH_TOOL_ID } from '../src/features/projects/agentTools.js';
import { addProjectMember, createProject, projectSubject, setProjectVisibility, updateProject } from '../src/features/projects/projectsService.js';
import { createOrg, createCustomRole, createMember } from '../src/host/accessControlService.js';
import { registerProjectHealthProvider, __resetProjectHealthProviders } from '../src/host/projectHealthProviders.js';
import { addSubjectNote } from '../src/host/subjectMemory.js';

const TENANT = 'default';
let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
});
afterAll(async () => { __resetProjectHealthProviders(); await new Promise<void>((res) => server.close(() => res())); });
beforeEach(() => __resetProjectHealthProviders());

const run = async (name: string, input: Record<string, unknown>, actingUserId?: string) => {
  const r = await createAgentToolProvider({ tenantId: TENANT, runId: 'run-1092', ...(actingUserId ? { actingUserId } : {}) }).executeTool({ name, input });
  return JSON.parse(r.content) as Record<string, unknown>;
};
async function orgWithReader(): Promise<string> {
  const org = await createOrg({ tenantId: TENANT, createdBy: 'u-owner', name: `Org ${Date.now()}`, ownerSubject: 'u-owner' });
  const role = await createCustomRole({ orgId: org.orgId, tenantId: TENANT, name: `reader-${Date.now()}`, scopes: ['workspace:read'] });
  await createMember({ orgId: org.orgId, tenantId: TENANT, displayName: 'Reader', subject: 'u-1092-reader', roles: [role.roleId] });
  await createMember({ orgId: org.orgId, tenantId: TENANT, displayName: 'Other', subject: 'u-1092-other', roles: [role.roleId] });
  return org.orgId;
}

describe('ADR 1092/1093 — project read tools', () => {
  it('both tools are registered', () => {
    expect(builtinAgentToolIds()).toEqual(expect.arrayContaining([PROJECTS_GET_TOOL_ID, PROJECTS_KNOWLEDGE_SEARCH_TOOL_ID]));
  });

  it('projects.get reads one project in full with computed health, and refuses honestly', async () => {
    const orgId = await orgWithReader();
    const p = await createProject(TENANT, orgId, { name: 'Atlas' });
    await updateProject(TENANT, p.id, { charter: { goal: 'Ship it', health: 'on-track' } });
    await addProjectMember(TENANT, p.id, 'user:u-1092-reader', 'contributor');
    registerProjectHealthProvider('t', async () => ({ level: 'at-risk', reason: 'Late.', source: 'Test', asOf: '2027-01-25' }));
    expect((await run(PROJECTS_GET_TOOL_ID, { projectId: p.id }, 'u-owner')).members).toEqual([expect.objectContaining({ ref: 'user:u-1092-reader', name: 'Reader' })]);
    expect(await run(PROJECTS_GET_TOOL_ID, { projectId: p.id }, 'u-owner')).toMatchObject({ id: p.id, name: 'Atlas', access: 'write', charter: { goal: 'Ship it', health: 'on-track' }, computedHealth: { level: 'at-risk', providerId: 't' } });
    expect(await run(PROJECTS_GET_TOOL_ID, { projectId: p.id }, 'u-1092-reader')).toMatchObject({ access: 'read' });
    expect(await run(PROJECTS_GET_TOOL_ID, { projectId: p.id })).toMatchObject({ error: { code: 'acting_user_required' } });
    expect(await run(PROJECTS_GET_TOOL_ID, {}, 'u-owner')).toMatchObject({ error: { code: 'validation_error' } });
    expect(await run(PROJECTS_GET_TOOL_ID, { projectId: 'nope' }, 'u-owner')).toMatchObject({ error: { code: 'not_found' } });
    await setProjectVisibility(TENANT, p.id, 'private');
    // A member still reads a private project; an org reader who isn't a member gets not-found.
    expect(await run(PROJECTS_GET_TOOL_ID, { projectId: p.id }, 'u-1092-reader')).toMatchObject({ id: p.id });
    expect(await run(PROJECTS_GET_TOOL_ID, { projectId: p.id }, 'u-1092-other')).toMatchObject({ error: { code: 'not_found' } });
  });

  it("projects.knowledge.search reads the project's memory behind the same gate", async () => {
    const orgId = await orgWithReader();
    const p = await createProject(TENANT, orgId, { name: 'Harbor' });
    await addSubjectNote(TENANT, projectSubject(p.id), 'The client prefers unlacquered brass fittings.');
    const out = await run(PROJECTS_KNOWLEDGE_SEARCH_TOOL_ID, { projectId: p.id, query: 'unlacquered brass' }, 'u-owner');
    expect(out.projectId).toBe(p.id);
    expect(out.chunks).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'memory' })]));
    expect(Array.isArray(out.failedSources)).toBe(true);
    expect(await run(PROJECTS_KNOWLEDGE_SEARCH_TOOL_ID, { projectId: p.id, query: '  ' }, 'u-owner')).toMatchObject({ error: { code: 'validation_error' } });
    expect(await run(PROJECTS_KNOWLEDGE_SEARCH_TOOL_ID, { projectId: p.id, query: 'x' })).toMatchObject({ error: { code: 'acting_user_required' } });
    await setProjectVisibility(TENANT, p.id, 'private');
    expect(await run(PROJECTS_KNOWLEDGE_SEARCH_TOOL_ID, { projectId: p.id, query: 'x' }, 'u-1092-reader')).toMatchObject({ error: { code: 'not_found' } });
  });
});
