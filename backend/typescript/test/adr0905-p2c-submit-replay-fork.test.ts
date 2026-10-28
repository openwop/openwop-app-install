/**
 * ADR 0905 P2c (D5, architect X2) — a REPLAY fork of a run that submitted a campaign for
 * send review must not submit again: `feature.email.nodes.submit-for-review` is classified
 * `side-effect` + `side-effectful`, so the real executor serves the source's recorded
 * outcome instead of re-executing it.
 *
 * The discriminator: after the source run, the review is WITHDRAWN (campaign back to
 * draft, row closed). A fork that re-executed the node would open a SECOND review cycle
 * (a new approval row, the campaign `in_review` again). A served fork leaves both alone.
 *
 * Sabotage-witnessed: dropping `side-effectful` + `role:"side-effect"` from the node (and
 * regenerating the floor) reds the "no second row" assertion.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { fromWireRunId } from '../src/host/v2Ids.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { createOrg, createMember, listOrgs } from '../src/host/accessControlService.js';
import { ERASED_SUBJECT_SENTINEL, eraseApprovalSubject, getEmailSendApprovalHandler, listApprovals } from '../src/host/approvalService.js';
import { startWorkflowRun } from '../src/host/runStarter.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { createTemplate, createCampaign, setSenderAddress, getCampaign } from '../src/features/email/emailService.js';
import { withdrawReview } from '../src/features/email/sendApproval.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

const TOKEN = 'dev-token';
const TENANT = 'default';
/** The acting subject a `dev-token` run carries (`run.metadata.actingUserId`); it must be a
 *  writer in the org, because `submitForReview` is held to `workspace:write` (ADR 0832). */
const DEV_SUBJECT = 'bearer:dev-toke';
let BASE: string;
let server: http.Server;
let storage: Storage;
let hostSuite: HostAdapterSuite;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  hostSuite = app.locals.hostSuite;
  for (const id of ['crm', 'email']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'OpenWOP-Version': '2' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
async function settle(runId: string): Promise<RunRecord | null> {
  let run: RunRecord | null = null;
  await vi.waitFor(async () => {
    run = await storage.getRun(runId);
    if (!run || !TERMINAL.has(run.status)) throw new Error(`run ${runId} not terminal yet`);
  }, { timeout: 10_000, interval: 25 });
  return run;
}
const rowsFor = async (campaignId: string) => (await listApprovals(TENANT)).filter((a) => a.kind === 'email-campaign-send' && a.emailSend?.campaignId === campaignId);

describe('ADR 0905 D5 — submit-for-review through the real executor', () => {
  it('an actual actorless run records its causing admin only as a self-approval disqualifier; another admin can approve', async () => {
    const orgId = (await createOrg({ tenantId: TENANT, createdBy: 'test', name: 'Email Cause', ownerSubject: DEV_SUBJECT })).orgId;
    const other = 'email-cause-other-admin';
    await createMember({ tenantId: TENANT, orgId, subject: other, displayName: 'Other admin', roles: ['admin'] });
    const reviewer = 'email-cause-independent-admin';
    await createMember({ tenantId: TENANT, orgId, subject: reviewer, displayName: 'Independent admin', roles: ['admin'] });
    await setSenderAddress(TENANT, orgId, 'news@acme.test', 'test');
    const tpl = await createTemplate({ tenantId: TENANT, orgId, name: 'Cause', subject: 'S', body: 'B', createdBy: 'test' });
    const cmp = await createCampaign({ tenantId: TENANT, orgId, templateId: tpl.templateId, createdBy: 'test' });
    const workflowId = 'wf.adr0905.cause-submit';
    registerWorkflow({ workflowId, nodes: [{ nodeId: 'submit', typeId: 'feature.email.nodes.submit-for-review', config: { orgId, campaignId: cmp.campaignId } }], edges: [] });
    const gate = getToggleDefault('email-approval-gate');
    if (!gate) throw new Error('email approval toggle missing');
    await saveConfig({ ...gate, status: 'on' }, 'test');
    try {
      const runId = await startWorkflowRun({ storage, hostSuite }, { tenantId: TENANT, workflowId, orgScopeSubject: DEV_SUBJECT });
      if (!runId) throw new Error('fixture did not start');
      const run = await settle(runId);
      expect(run?.status, JSON.stringify(run)).toBe('completed');
      expect(run?.metadata).toMatchObject({ orgScopeSubject: DEV_SUBJECT });
      expect(run?.metadata?.actingUserId).toBeUndefined();
      const [review] = await rowsFor(cmp.campaignId);
      expect(review?.submitters).toBeUndefined();
      expect(review?.submitterCauses).toEqual([DEV_SUBJECT]);
      expect((await getCampaign(TENANT, orgId, cmp.campaignId))?.review?.submittedBy).toBeUndefined();
      const secondRunId = await startWorkflowRun({ storage, hostSuite }, { tenantId: TENANT, workflowId, orgScopeSubject: other });
      if (!secondRunId) throw new Error('second fixture run did not start');
      expect((await settle(secondRunId))?.status).toBe('completed');
      const [repinned] = await rowsFor(cmp.campaignId);
      expect(repinned?.approvalId).toBe(review?.approvalId);
      expect(repinned?.submitterCauses).toEqual([DEV_SUBJECT, other]);
      const decide = getEmailSendApprovalHandler();
      if (!review || !decide) throw new Error('review handler missing');
      await expect(decide(TENANT, review.approvalId, 'approved', { decidedByUserId: DEV_SUBJECT, expectedContentHash: review.emailSend?.reviewHash }))
        .rejects.toMatchObject({ httpStatus: 403, details: { reason: 'separation-of-duties' } });
      expect((await rowsFor(cmp.campaignId))[0]?.status).toBe('pending');
      await expect(decide(TENANT, review.approvalId, 'approved', { decidedByUserId: other, expectedContentHash: repinned?.emailSend?.reviewHash }))
        .rejects.toMatchObject({ httpStatus: 403, details: { reason: 'separation-of-duties' } });
      expect(await decide(TENANT, review.approvalId, 'approved', { decidedByUserId: reviewer, expectedContentHash: repinned?.emailSend?.reviewHash })).toMatchObject({ changed: true });
      expect((await getCampaign(TENANT, orgId, cmp.campaignId))?.status).toBe('approved');
      await eraseApprovalSubject(TENANT, DEV_SUBJECT);
      expect((await rowsFor(cmp.campaignId))[0]?.submitterCauses).toEqual([ERASED_SUBJECT_SENTINEL, other]);
    } finally { await saveConfig({ ...gate, status: 'off' }, 'test'); }
  });

  it('the source run submits once; a replay fork serves the outcome and opens no second review', async () => {
    const orgId = (await listOrgs(TENANT)).find((o) => o.name === 'Email Replay')?.orgId
      ?? (await createOrg({ tenantId: TENANT, createdBy: 'test', name: 'Email Replay', ownerSubject: DEV_SUBJECT })).orgId;
    await setSenderAddress(TENANT, orgId, 'news@acme.test', 'test');
    const tpl = await createTemplate({ tenantId: TENANT, orgId, name: 'N', subject: 'S', body: 'B', createdBy: 'test' });
    const cmp = await createCampaign({ tenantId: TENANT, orgId, templateId: tpl.templateId, createdBy: 'test' });
    registerWorkflow({
      workflowId: 'wf.adr0905.submit-review',
      nodes: [{ nodeId: 'submit', typeId: 'feature.email.nodes.submit-for-review', config: { orgId, campaignId: cmp.campaignId } }],
      edges: [],
    });

    const start = await post('/runs', { workflowId: 'wf.adr0905.submit-review', inputs: {} });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const decoded = fromWireRunId(start.body.runId as string, TENANT);
    if (!decoded.ok) throw new Error('foreign run id');
    const run = await settle(decoded.runId);
    expect(run?.status, `source run: ${JSON.stringify(run)}`).toBe('completed');
    expect(await rowsFor(cmp.campaignId)).toHaveLength(1);
    expect((await getCampaign(TENANT, orgId, cmp.campaignId))?.status).toBe('in_review');

    await withdrawReview(TENANT, orgId, cmp.campaignId);
    expect((await getCampaign(TENANT, orgId, cmp.campaignId))?.status).toBe('draft');

    const fork = await post(`/runs/${encodeURIComponent(start.body.runId as string)}:fork`, { fromSeq: 0, mode: 'replay' });
    expect(fork.status, JSON.stringify(fork.body)).toBe(201);
    const forkDecoded = fromWireRunId(fork.body.runId as string, TENANT);
    if (!forkDecoded.ok) throw new Error('foreign fork id');
    const forked = await settle(forkDecoded.runId);
    expect(forked?.status, `fork: ${JSON.stringify(forked)}`).toBe('completed');
    expect(await rowsFor(cmp.campaignId), 'a replay fork re-submitted the campaign').toHaveLength(1);
    expect((await getCampaign(TENANT, orgId, cmp.campaignId))?.status).toBe('draft');
  });
});
