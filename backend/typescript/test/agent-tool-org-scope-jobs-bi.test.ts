/**
 * JOBS-SCOPE-1 + BI-SCOPE-1 — two agent
 * tools did not share their HTTP route's org gate.
 *
 *  - `job-search.applications.read` passed the model-supplied orgId straight to
 *    `listApplications`: a member with no access to an org could list its job
 *    applications, and the first call created that org's pipeline.
 *  - `bi.run-metric` did the same, and an OMITTED orgId became '' — which
 *    `runMetric` reads as "no org filter", aggregating every org's rows.
 *
 * Both routes gate with `authorizeOrgScope(…, 'workspace:read')`; the tools now
 * use its tool-lane twin, `resolveReadOrgScope`. CLAUDE.md: a feature tool
 * SHARES its route's access predicate.
 *
 * TST-BLT-5. Org B carries a REAL application (a deal on its application
 * pipeline), which `sys-deal-count` also counts, so an ungated read would return
 * data; org C has nothing, so an ungated jobs read would MINT its pipeline.
 * Red when: the shared gate stops checking the caller's scope in the org
 * (`resolveReadOrgScope` access line), or an omitted orgId is resolved to ''
 * instead of a typed `org_required` (w65 probes).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg, createMember } from '../src/host/accessControlService.js';
import { createDeal, listPipelines } from '../src/features/crm/crmEntitiesService.js';
import { ensureApplicationPipeline } from '../src/features/job-search/domain/applications.js';

const T = `tenant-scope-${Date.now()}`;
let ORG_A = '';
let ORG_B = '';
let ORG_C = '';
const NO_ACCESS = 'You do not have read access to that organization.';

interface ToolBody {
  applications?: Array<{ title: string }>;
  note?: string;
  result?: unknown;
  /** A gate refusal is a bare code (`toolError`); a metric failure is `{ code, message }`. */
  error?: string | { code: string; message: string };
}

const exec = async (name: string, input: Record<string, unknown>, actingUserId: string) => {
  const { createAgentToolProvider } = await import('../src/host/agentToolProvider.js');
  const out = await createAgentToolProvider({ tenantId: T, runId: 'run-scope', actingUserId }).executeTool({ name, input });
  const body: ToolBody | null = (() => { try { return JSON.parse(out.content) as ToolBody; } catch { return null; } })();
  return { raw: out, body };
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  for (const id of ['users', 'crm', 'job-search', 'bi']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  ORG_A = (await createOrg({ tenantId: T, createdBy: 'owner', name: 'A' })).orgId;
  ORG_B = (await createOrg({ tenantId: T, createdBy: 'owner', name: 'B' })).orgId;
  ORG_C = (await createOrg({ tenantId: T, createdBy: 'owner', name: 'C' })).orgId;
  // Org B holds a real application: a deal on its job-search pipeline.
  const pipeline = await ensureApplicationPipeline(T, ORG_B);
  await createDeal({
    tenantId: T, orgId: ORG_B, title: 'org-b-secret-application', pipelineId: pipeline.pipelineId,
    ...(pipeline.stages[0] ? { stageId: pipeline.stages[0].stageId } : {}),
    createdBy: 'owner', validateCompany: async () => true, validateContact: async () => true,
  });
  // alice: a reader in org A only — no membership at all in org B.
  await createMember({ orgId: ORG_A, tenantId: T, displayName: 'Alice', subject: 'alice', roles: ['viewer'] });
});

describe('job-search.applications.read shares the route\'s org gate (JOBS-SCOPE-1)', () => {
  it('another org reads EMPTY and creates nothing there', async () => {
    // Org B HAS an application; alice has no access there.
    const r = await exec('openwop:job-search.applications.read', { orgId: ORG_B }, 'alice');
    expect(r.body).toEqual({ applications: [], note: NO_ACCESS });
    expect(JSON.stringify(r.raw)).not.toContain('org-b-secret-application');
    // Org C has no pipeline; a read there must not mint one.
    const c = await exec('openwop:job-search.applications.read', { orgId: ORG_C }, 'alice');
    expect(c.body).toEqual({ applications: [], note: NO_ACCESS });
    expect(await listPipelines(T, ORG_C)).toEqual([]);
  });

  it('the caller\'s own org still works', async () => {
    const r = await exec('openwop:job-search.applications.read', { orgId: ORG_A }, 'alice');
    expect(r.body?.applications).toEqual([]);
    expect(r.body?.note).toBeUndefined();
    expect((await listPipelines(T, ORG_A)).length).toBe(1);
  });
});

describe('bi.run-metric shares the route\'s org gate (BI-SCOPE-1)', () => {
  it('another org reads EMPTY (the metric never runs)', async () => {
    // sys-deal-count over org B would count its application deal.
    const r = await exec('openwop:bi.run-metric', { metricId: 'sys-deal-count', orgId: ORG_B }, 'alice');
    expect(r.body).toEqual({ result: null, note: NO_ACCESS });
  });

  it('an omitted orgId in a multi-org workspace is a typed org_required, never a workspace-wide aggregate', async () => {
    const r = await exec('openwop:bi.run-metric', { metricId: 'sys-deal-count' }, 'alice');
    expect(r.raw.isError).toBe(true);
    expect(r.body?.error).toBe('org_required');
  });

  it('the caller\'s own org passes the gate (reaching the metric lookup)', async () => {
    const r = await exec('openwop:bi.run-metric', { metricId: 'no-such-metric', orgId: ORG_A }, 'alice');
    expect(r.body?.error).toMatchObject({ code: 'not_found' });
  });
});
