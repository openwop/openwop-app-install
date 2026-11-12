/**
 * ADR 1036 D2 + D8 — the job-search workflow surface and the listings chat tool
 * ask what their HTTP doors ask.
 *
 *  - D2: `recordOutcome` moves an application's stage. Its HTTP twin needs
 *    `workspace:write`; the surface registered no `orgPolicy`, so the ADR 0832
 *    floor asked `workspace:read` and a VIEWER's run moved deal stages. The
 *    surface header claimed the org "comes from the run's own scope"; it comes
 *    from node input, and the floor is what stands in front of it.
 *  - D8: `listings.read` checked only the toggle and an acting user, while its
 *    route runs `authorizeOrgScope(…, 'workspace:read')`. A tenant member with no
 *    org membership read the listings.
 *
 * Sabotage-witnessed (row 81): dropping `methodScopes.recordOutcome` from
 * `JOB_SEARCH_SURFACE_POLICY` reds the viewer case; restoring the old
 * toggle-only check in the listings tool reds the outsider case.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg, createMember } from '../src/host/accessControlService.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import { upsertListing } from '../src/features/job-search/boards/listing.js';
import { createUser } from '../src/features/users/usersService.js';
import { createDeal } from '../src/features/crm/crmEntitiesService.js';
import { ensureApplicationPipeline } from '../src/features/job-search/domain/applications.js';

const T = `tenant-adr1036-${Date.now()}`;
let ORG = '';

const exec = async (name: string, input: Record<string, unknown>, actingUserId: string) => {
  const { createAgentToolProvider } = await import('../src/host/agentToolProvider.js');
  const out = await createAgentToolProvider({ tenantId: T, runId: 'run-adr1036', actingUserId }).executeTool({ name, input });
  return JSON.parse(out.content) as { listings?: Array<{ title: string }>; applications?: Array<{ title: string; mine: boolean }>; note?: string };
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  for (const id of ['users', 'crm', 'job-search']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  ORG = (await createOrg({ tenantId: T, createdBy: 'owner', name: 'Search' })).orgId;
  await createMember({ orgId: ORG, tenantId: T, displayName: 'Viewer', subject: 'viewer', roles: ['viewer'] });
  await createMember({ orgId: ORG, tenantId: T, displayName: 'Editor', subject: 'editor', roles: ['editor'] });
  await upsertListing(T, 'editor', {
    title: 'adr1036-listing', companyName: 'Acme', location: null, sourceBoard: 'greenhouse',
    sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    ext: { skills: [], requirements: [], responsibilities: [], descriptionExcerpt: '' },
  });
});

describe('ADR 1036 D2 — recordOutcome needs workspace:write at the surface floor', () => {
  it("a VIEWER's run is refused; an EDITOR's run passes the floor", async () => {
    const asViewer = buildFeatureSurfaces({ tenantId: T, runId: 'run-v', actingUserId: 'viewer' })['job-search']!;
    await expect(asViewer.recordOutcome!({ orgId: ORG, dealId: 'deal:none', stage: 'Applied' }))
      .rejects.toMatchObject({ code: 'forbidden_scope' });
    const asEditor = buildFeatureSurfaces({ tenantId: T, runId: 'run-e', actingUserId: 'editor' })['job-search']!;
    // Past the floor, the honest "no such deal" answer.
    await expect(asEditor.recordOutcome!({ orgId: ORG, dealId: 'deal:none', stage: 'Applied' })).resolves.toMatchObject({ moved: false });
  });

  it('reads stay at the read tier: a viewer may still list applications', async () => {
    const asViewer = buildFeatureSurfaces({ tenantId: T, runId: 'run-v2', actingUserId: 'viewer' })['job-search']!;
    await expect(asViewer.listApplications!({ orgId: ORG })).resolves.toMatchObject({ applications: [] });
  });
});

describe('ADR 1036 D8 — listings.read shares its route gate', () => {
  it('a tenant member with no org membership reads EMPTY; a member reads the listings', async () => {
    const outsider = await exec('openwop:job-search.listings.read', { orgId: ORG }, 'outsider');
    expect(outsider.listings).toEqual([]);
    expect(outsider.note).toBe('You do not have read access to that organization.');
    const member = await exec('openwop:job-search.listings.read', { orgId: ORG }, 'viewer');
    expect(member.listings?.map((l) => l.title)).toEqual(['adr1036-listing']);
  });
});

describe('ADR 1036 D10 — the applications tool says which rows are the asker\'s, by CANONICAL id', () => {
  it('a turn carrying the legacy principal spelling still recognises its own application', async () => {
    const u = await createUser({ tenantId: T, principalId: 'oidc:legacy-reader' });
    await createMember({ orgId: ORG, tenantId: T, displayName: 'Legacy', subject: 'oidc:legacy-reader', roles: ['viewer'] });
    const pipeline = await ensureApplicationPipeline(T, ORG);
    await createDeal({ tenantId: T, orgId: ORG, title: 'mine-application', pipelineId: pipeline.pipelineId, createdBy: u.userId, validateCompany: async () => true, validateContact: async () => true });
    await createDeal({ tenantId: T, orgId: ORG, title: 'colleague-application', pipelineId: pipeline.pipelineId, createdBy: 'editor', validateCompany: async () => true, validateContact: async () => true });
    const r = await exec('openwop:job-search.applications.read', { orgId: ORG }, 'oidc:legacy-reader');
    const byTitle = Object.fromEntries((r.applications ?? []).map((a) => [a.title, a.mine]));
    expect(byTitle).toEqual({ 'mine-application': true, 'colleague-application': false });
  });
});
