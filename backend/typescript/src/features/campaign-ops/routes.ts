/**
 * Campaign ops routes — host extension under `/v1/host/openwop-app/campaign-ops/*`
 * (ADR 0921 P0, ADR 0922 P0). No RFC, nothing advertised.
 *
 * Authority (ADR 0921 D2), fail-closed:
 *  - an AGENCY ADMIN holds `host:members:manage` on the workspace ROOT org row
 *    itself (or owns their personal workspace). This is an exact-row check, on
 *    purpose: the tenant-wide scope UNION (`callerHoldsTenantScope`) would make an
 *    admin of client A an agency admin. This also answers ADR 0921 Q1: a root
 *    admin's org-scoped access to a client with no row is NOT relied on.
 *  - everyone else is judged on the exact CLIENT org row (`requireOrgScope`).
 *  - a client org with no `ClientAccount`, and a client the caller cannot read,
 *    are the same 404.
 */
import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { assertOrgScope, resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { isDurableCaller, isOwnPersonalWorkspace } from '../../host/requestSubject.js';
import { requireFeatureEnabled, requireOrgScope, tenantOf } from '../featureRoute.js';
import { resolveCallerUser } from '../users/usersGuards.js';
import { createClient, getClient, listClients, updateClient } from './clientService.js';
import { addAsset, getAsset, listAssets, refreshAsset, removeAsset } from './assetService.js';
import { adapterFor } from './adapters/registry.js';
import type { ClientAccount, ClientMode, ClientStatus } from './types.js';
import { personalTenantOf } from '../../host/requestSubject.js';
import { answerQuestions, createRequest, editRequest, getRequest, listRequests } from './requestService.js';
import { diffOf, getChangeSet, listChangeSets, markStaleForRequest } from './changeSetService.js';
import { startChangeRequestRun } from './runLauncher.js';
import { requestChangeSetApproval } from './approval.js';
import { getJob, listJobs, jobIdOf } from './execution.js';

export const CAMPAIGN_OPS_TOGGLE = 'campaign-ops';
const LABEL = 'Campaign operations';
const BASE = '/host/openwop-app/campaign-ops';
const STATUSES: readonly ClientStatus[] = ['active', 'paused', 'archived'];
const MODES: readonly ClientMode[] = ['preview', 'live'];

async function callerUserId(req: Request): Promise<string> {
  return (await resolveCallerUser(req)).userId;
}

/** `host:members:manage` on the workspace ROOT row, exactly. */
export async function isAgencyAdmin(req: Request): Promise<boolean> {
  const tenantId = tenantOf(req);
  // An anon sandbox owns its personal tenant too, but it is not an agency admin.
  if (isOwnPersonalWorkspace(req)) return isDurableCaller(req);
  try {
    await assertOrgScope(tenantId, await callerUserId(req), tenantId, 'host:members:manage');
    return true;
  } catch {
    return false;
  }
}

async function requireAgencyAdmin(req: Request): Promise<void> {
  if (!(await isAgencyAdmin(req))) {
    throw new OpenwopError('forbidden_scope', 'Only an agency admin can do this.', 403, { requiredScope: 'host:members:manage' });
  }
}

/** The client of `req.params.orgId`, authorized for `scope`; 404 when it is not a client. */
async function authorizeClient(req: Request, scope: Scope): Promise<{ client: ClientAccount; tenantId: string; userId: string }> {
  await requireFeatureEnabled(req, CAMPAIGN_OPS_TOGGLE, LABEL);
  const tenantId = tenantOf(req);
  const orgId = req.params.orgId;
  let userId: string;
  if (await isAgencyAdmin(req)) {
    userId = await callerUserId(req);
  } else {
    try {
      userId = (await requireOrgScope(req, scope)).user.userId;
    } catch (err) {
      // A client the caller cannot even read is indistinguishable from none.
      if (err instanceof OpenwopError && err.code === 'forbidden_scope' && scope !== 'workspace:read') {
        const canRead = (await resolveEffectiveAccess(tenantId, { subject: await callerUserId(req), orgId })).scopes.includes('workspace:read');
        if (canRead) throw err;
      }
      throw new OpenwopError('not_found', 'Client not found.', 404, { orgId });
    }
  }
  const client = await getClient(tenantId, orgId);
  if (!client) throw new OpenwopError('not_found', 'Client not found.', 404, { orgId });
  return { client, tenantId, userId };
}

export function registerCampaignOpsRoutes(deps: RouteDeps): void {
  const { app } = deps;

  // ADR 0921 D5 — the switcher lists only the clients the caller can read.
  app.get(`${BASE}/clients`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, CAMPAIGN_OPS_TOGGLE, LABEL);
      const tenantId = tenantOf(req);
      const all = await listClients(tenantId);
      if (await isAgencyAdmin(req)) { res.json({ clients: all, agencyAdmin: true }); return; }
      const subject = await callerUserId(req);
      const visible: ClientAccount[] = [];
      for (const c of all) {
        const access = await resolveEffectiveAccess(tenantId, { subject, orgId: c.orgId });
        if (access.scopes.includes('workspace:read')) visible.push(c);
      }
      res.json({ clients: visible, agencyAdmin: false });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/clients`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, CAMPAIGN_OPS_TOGGLE, LABEL);
      await requireAgencyAdmin(req);
      const body = (req.body ?? {}) as { name?: unknown; orgId?: unknown };
      const client = await createClient({
        tenantId: tenantOf(req),
        name: typeof body.name === 'string' ? body.name : '',
        ...(typeof body.orgId === 'string' && body.orgId ? { orgId: body.orgId } : {}),
        createdBy: await callerUserId(req),
      });
      res.status(201).json({ client });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/clients/:orgId`, async (req, res, next) => {
    try {
      const { client } = await authorizeClient(req, 'workspace:read');
      res.json({ client });
    } catch (err) { next(err); }
  });

  // Status / mode / name. Switching to `live` is the client-level preview switch
  // (ADR 0926 D3), so it is an admin act on the client, never a run flag.
  app.patch(`${BASE}/clients/:orgId`, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeClient(req, 'host:members:manage');
      const body = (req.body ?? {}) as { status?: unknown; mode?: unknown; name?: unknown };
      if (body.status !== undefined && !STATUSES.includes(body.status as ClientStatus)) {
        throw new OpenwopError('validation_error', `status MUST be one of ${STATUSES.join(', ')}.`, 400, { field: 'status' });
      }
      if (body.mode !== undefined && !MODES.includes(body.mode as ClientMode)) {
        throw new OpenwopError('validation_error', `mode MUST be one of ${MODES.join(', ')}.`, 400, { field: 'mode' });
      }
      const client = await updateClient(tenantId, req.params.orgId, {
        ...(body.status !== undefined ? { status: body.status as ClientStatus } : {}),
        ...(body.mode !== undefined ? { mode: body.mode as ClientMode } : {}),
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
      });
      if (!client) throw new OpenwopError('not_found', 'Client not found.', 404, {});
      res.json({ client });
    } catch (err) { next(err); }
  });

  // ── Change requests and change sets (ADR 0923) ──

  const launch = async (req: Request, tenantId: string, orgId: string, requestId: string, version: number, userId: string): Promise<string> =>
    startChangeRequestRun({ storage: deps.storage, hostSuite: deps.hostSuite }, {
      tenantId, orgId, requestId, version, causedBy: userId,
      ...(personalTenantOf(req) ? { personalTenant: personalTenantOf(req) } : {}),
    });

  app.get(`${BASE}/clients/:orgId/requests`, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeClient(req, 'workspace:read');
      res.json({ requests: await listRequests(tenantId, req.params.orgId) });
    } catch (err) { next(err); }
  });

  /** ADR 0923 D1/D3 — a new request. A duplicate is stored and NOT executed
   *  unless the body carries `overrideDuplicate: { reason }`. */
  app.post(`${BASE}/clients/:orgId/requests`, async (req, res, next) => {
    try {
      const { tenantId, userId } = await authorizeClient(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const override = body.overrideDuplicate && typeof body.overrideDuplicate === 'object'
        ? (body.overrideDuplicate as { reason?: unknown }).reason : undefined;
      if (body.overrideDuplicate !== undefined && (typeof override !== 'string' || !override.trim())) {
        throw new OpenwopError('validation_error', 'Overriding a duplicate needs a reason.', 400, { field: 'overrideDuplicate.reason' });
      }
      const request = await createRequest({
        tenantId, orgId: req.params.orgId, text: body.text, assetIds: body.assetIds,
        ...(typeof body.campaignId === 'string' && body.campaignId ? { campaignId: body.campaignId } : {}),
        createdBy: userId,
        ...(typeof override === 'string' ? { overrideDuplicate: { reason: override } } : {}),
      });
      if (request.status === 'duplicate') { res.status(200).json({ request, duplicate: true }); return; }
      const runId = await launch(req, tenantId, req.params.orgId, request.requestId, request.version, userId);
      res.status(202).json({ request: (await getRequest(tenantId, req.params.orgId, request.requestId)) ?? request, runId });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/clients/:orgId/requests/:requestId`, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeClient(req, 'workspace:read');
      const request = await getRequest(tenantId, req.params.orgId, req.params.requestId);
      if (!request) throw new OpenwopError('not_found', 'Request not found.', 404, { requestId: req.params.requestId });
      const changeSet = request.changeSetId ? await getChangeSet(tenantId, req.params.orgId, request.changeSetId) : null;
      res.json({ request, changeSet });
    } catch (err) { next(err); }
  });

  /** ADR 0923 D1 — an edit is a new version; the old change set goes stale. */
  app.patch(`${BASE}/clients/:orgId/requests/:requestId`, async (req, res, next) => {
    try {
      const { tenantId, userId } = await authorizeClient(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { before, after } = await editRequest(tenantId, req.params.orgId, req.params.requestId, { text: body.text, ...(body.assetIds !== undefined ? { assetIds: body.assetIds } : {}) }, userId);
      await markStaleForRequest(tenantId, req.params.orgId, before.changeSetId);
      const runId = await launch(req, tenantId, req.params.orgId, after.requestId, after.version, userId);
      res.status(202).json({ request: (await getRequest(tenantId, req.params.orgId, after.requestId)) ?? after, runId });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/clients/:orgId/requests/:requestId/answers`, async (req, res, next) => {
    try {
      const { tenantId, userId } = await authorizeClient(req, 'workspace:write');
      const request = await answerQuestions(tenantId, req.params.orgId, req.params.requestId, (req.body ?? {}).answers, userId);
      const runId = await launch(req, tenantId, req.params.orgId, request.requestId, request.version, userId);
      res.status(202).json({ request: (await getRequest(tenantId, req.params.orgId, request.requestId)) ?? request, runId });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/clients/:orgId/change-sets`, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeClient(req, 'workspace:read');
      res.json({ changeSets: await listChangeSets(tenantId, req.params.orgId) });
    } catch (err) { next(err); }
  });

  /** ADR 0923 D7 — the change set with its per-asset field diff. */
  app.get(`${BASE}/clients/:orgId/change-sets/:changeSetId`, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeClient(req, 'workspace:read');
      const changeSet = await getChangeSet(tenantId, req.params.orgId, req.params.changeSetId);
      if (!changeSet) throw new OpenwopError('not_found', 'Change set not found.', 404, { changeSetId: req.params.changeSetId });
      res.json({ changeSet, diff: await diffOf(tenantId, changeSet) });
    } catch (err) { next(err); }
  });

  /** ADR 0924 — send a proposed change set to review (opens its one approval row). */
  app.post(`${BASE}/clients/:orgId/change-sets/:changeSetId/request-approval`, async (req, res, next) => {
    try {
      const { tenantId, userId } = await authorizeClient(req, 'workspace:write');
      const out = await requestChangeSetApproval(tenantId, req.params.orgId, req.params.changeSetId, userId);
      res.status(201).json({ changeSet: out.changeSet, approvalId: out.approval.approvalId, approval: { status: out.approval.status, changeSetHash: out.approval.changeSetHash } });
    } catch (err) { next(err); }
  });

  // ── Jobs (ADR 0925) ──

  app.get(`${BASE}/clients/:orgId/jobs`, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeClient(req, 'workspace:read');
      res.json({ jobs: await listJobs(tenantId, req.params.orgId) });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/clients/:orgId/jobs/:jobId`, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeClient(req, 'workspace:read');
      const job = await getJob(tenantId, req.params.orgId, req.params.jobId);
      if (!job) throw new OpenwopError('not_found', 'Job not found.', 404, { jobId: req.params.jobId });
      res.json({ job });
    } catch (err) { next(err); }
  });

  /** The job an approval produced (the inbox follows the approval to its job). */
  app.get(`${BASE}/clients/:orgId/approvals/:approvalId/job`, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeClient(req, 'workspace:read');
      const job = await getJob(tenantId, req.params.orgId, jobIdOf(tenantId, req.params.approvalId));
      res.json({ job: job ?? null });
    } catch (err) { next(err); }
  });

  // ── Assets (ADR 0922 D1) ──

  app.get(`${BASE}/clients/:orgId/assets`, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeClient(req, 'workspace:read');
      const campaignId = typeof req.query.campaignId === 'string' && req.query.campaignId ? req.query.campaignId : undefined;
      res.json({ assets: await listAssets(tenantId, req.params.orgId, campaignId) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/clients/:orgId/assets`, async (req, res, next) => {
    try {
      const { tenantId, userId } = await authorizeClient(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const asset = await addAsset({
        tenantId,
        orgId: req.params.orgId,
        destination: body.destination,
        locator: body.locator,
        label: body.label,
        editableFields: body.editableFields,
        ...(typeof body.campaignId === 'string' && body.campaignId ? { campaignId: body.campaignId } : {}),
        createdBy: userId,
      });
      res.status(201).json({ asset });
    } catch (err) { next(err); }
  });

  /** The asset plus a CURRENT read of its target (fields, version, hash). */
  app.get(`${BASE}/clients/:orgId/assets/:assetId`, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeClient(req, 'workspace:read');
      const asset = await getAsset(tenantId, req.params.orgId, req.params.assetId);
      if (!asset) throw new OpenwopError('not_found', 'Asset not found.', 404, { assetId: req.params.assetId });
      const snapshot = await adapterFor(asset.destination)?.read(asset, { tenantId });
      res.json({ asset, current: snapshot ?? null });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/clients/:orgId/assets/:assetId/refresh`, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeClient(req, 'workspace:write');
      res.json({ asset: await refreshAsset(tenantId, req.params.orgId, req.params.assetId) });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/clients/:orgId/assets/:assetId`, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeClient(req, 'workspace:write');
      if (!(await removeAsset(tenantId, req.params.orgId, req.params.assetId))) {
        throw new OpenwopError('not_found', 'Asset not found.', 404, { assetId: req.params.assetId });
      }
      res.status(204).end();
    } catch (err) { next(err); }
  });
}
