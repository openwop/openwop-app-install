/**
 * ADR 0957 P1 security review (2026-11-19) — the one defect it found: the
 * scheduled-report fire gate never asked whether the member the run acts for
 * may still write THIS client.
 *
 * A scheduled run acts for `metadata.orgScopeSubject` (the member who last saved
 * the schedule), and compute re-checks them on the client (`bindRunToClient` →
 * `assertRunOrgScope`). A member demoted or removed on the client while still in
 * the workspace is not caught by ADR 0815's removal pause, so before this fix
 * every slot started a run, spent autonomous-run budget and failed at compute.
 * The gate now refuses the slot first, as `client-access-lost`.
 *
 * Pins:
 *  - a member with write on the client passes the new check (positive control);
 *  - the same job is `client-access-lost` once that member is a viewer there, and
 *    when the job names no member at all;
 *  - restoring the member's role lets the slot through again (non-destructive).
 *
 * Red witness (NOT RUN at authoring; the parent session runs it): delete the
 * `assertRunOrgScope` block in `reportFireGate` (reports/schedule.ts) → the demoted
 * and subject-less cases return `workflow-unresolved` or `null`, not
 * `client-access-lost`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember, createOrg, createWorkspace, updateMember } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { createClient } from '../src/features/campaign-ops/clientService.js';
import { createDefinition } from '../src/features/campaign-ops/reports/reportService.js';
import { reportFireGate, reportJobId, REPORT_JOB_PURPOSE, CLIENT_REPORT_CHAIN_ID } from '../src/features/campaign-ops/reports/schedule.js';
import type { ScheduledJob } from '../src/host/schedulingService.js';

let server: http.Server;
let TENANT: string;
let orgA: string;
let schedulerId: string;
let schedulerMemberOnA: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  for (const id of ['cms', 'campaign-ops', 'campaign-ops.client-reports', 'campaign-connectors']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  TENANT = (await createWorkspace({ name: 'Northwind Agency', ownerSubject: 'oidc:rsec-owner' })).tenantId;
  schedulerId = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:rsec-scheduler', source: 'oidc' })).userId;
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: schedulerId, displayName: 'Scheduler', roles: ['viewer'] });
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A' })).orgId;
  schedulerMemberOnA = (await createMember({ tenantId: TENANT, orgId: orgA, subject: schedulerId, displayName: 'Scheduler', roles: ['editor'] })).memberId;
  await createClient({ tenantId: TENANT, orgId: orgA, name: 'Client A', createdBy: 'seed' });
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The job `syncReportSchedule` would arm, built by hand so the case does not
 *  depend on the chain pack being mounted (the gate's LAST check). */
function jobFor(definitionId: string, version: number, orgScopeSubject?: string): ScheduledJob {
  const job: ScheduledJob = {
    jobId: reportJobId(TENANT, orgA, definitionId), tenantId: TENANT, cronExpr: '0 9 1 * *', lastFiredTick: null, enabled: true,
    workflowId: CLIENT_REPORT_CHAIN_ID, featureId: 'campaign-ops', timezone: 'UTC',
    metadata: { purpose: REPORT_JOB_PURPOSE, orgId: orgA, definitionId, ...(orgScopeSubject ? { orgScopeSubject } : {}) },
    inputs: { orgId: orgA, definitionId, definitionVersion: version },
    createdAt: new Date().toISOString(),
  };
  return job;
}

describe('ADR 0957 P1 security review — the fire gate asks about the person', () => {
  it('a member who lost write on the client stops the slot before any run', async () => {
    const def = await createDefinition(TENANT, orgA, {
      title: 'Monthly results', campaignIds: 'all', sections: [{ kind: 'kpi', key: 'kpi', params: {} }],
      period: { kind: 'month', timezone: 'UTC' }, brand: 'agency', narrative: false, schedule: { cron: '0 9 1 * *' },
    }, schedulerId);
    const job = jobFor(def.definitionId, def.version, schedulerId);

    expect(await reportFireGate(job), 'an editor on the client passes the person check').not.toBe('client-access-lost');
    expect(await reportFireGate(jobFor(def.definitionId, def.version)), 'a job that names nobody').toBe('client-access-lost');

    await updateMember(schedulerMemberOnA, { roles: ['viewer'] });
    try {
      expect(await reportFireGate(job)).toBe('client-access-lost');
    } finally {
      await updateMember(schedulerMemberOnA, { roles: ['editor'] });
    }
    expect(await reportFireGate(job), 'restoring the role resumes the schedule').not.toBe('client-access-lost');
  });
});
