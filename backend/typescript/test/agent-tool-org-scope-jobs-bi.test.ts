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
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg, createMember } from '../src/host/accessControlService.js';
import { listPipelines } from '../src/features/crm/crmEntitiesService.js';

const T = `tenant-scope-${Date.now()}`;
let ORG_A = '';
let ORG_B = '';

const exec = async (name: string, input: Record<string, unknown>, actingUserId: string) => {
  const { createAgentToolProvider } = await import('../src/host/agentToolProvider.js');
  const out = await createAgentToolProvider({ tenantId: T, runId: 'run-scope', actingUserId }).executeTool({ name, input });
  return { raw: out, body: (() => { try { return JSON.parse(String((out as { content?: unknown }).content ?? '')); } catch { return null; } })() };
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  for (const id of ['users', 'crm', 'job-search', 'bi']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  ORG_A = (await createOrg({ tenantId: T, createdBy: 'owner', name: 'A' })).orgId;
  ORG_B = (await createOrg({ tenantId: T, createdBy: 'owner', name: 'B' })).orgId;
  // alice: a reader in org A only — no membership at all in org B.
  await createMember({ orgId: ORG_A, tenantId: T, displayName: 'Alice', subject: 'alice', roles: ['viewer'] });
});

describe('job-search.applications.read shares the route\'s org gate (JOBS-SCOPE-1)', () => {
  it('another org reads EMPTY and creates nothing there', async () => {
    const r = await exec('openwop:job-search.applications.read', { orgId: ORG_B }, 'alice');
    expect(r.body?.applications).toEqual([]);
    expect(await listPipelines(T, ORG_B)).toEqual([]); // no pipeline minted in B
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
    const r = await exec('openwop:bi.run-metric', { metricId: 'any', orgId: ORG_B }, 'alice');
    expect(r.body).toMatchObject({ result: null });
  });

  it('an omitted orgId in a multi-org workspace is a typed org_required, never a workspace-wide aggregate', async () => {
    const r = await exec('openwop:bi.run-metric', { metricId: 'any' }, 'alice');
    expect(JSON.stringify(r.raw)).toContain('org_required');
  });

  it('the caller\'s own org passes the gate (reaching the metric lookup)', async () => {
    const r = await exec('openwop:bi.run-metric', { metricId: 'no-such-metric', orgId: ORG_A }, 'alice');
    expect(JSON.stringify(r.raw)).toContain('not_found');
  });
});
