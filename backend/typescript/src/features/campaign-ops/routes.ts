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
import { publicBaseUrl, requireByokManage, requireFeatureEnabled, requireOrgScope, tenantOf } from '../featureRoute.js';
import { clientIp } from '../../host/clientIp.js';
import { suspendCollaboratorsForOrg } from '../../host/externalCollaborators.js';
import { resolveCallerUser } from '../users/usersGuards.js';
import { createClient, getClient, listClients, updateClient } from './clientService.js';
import { addAsset, getAsset, listAssets, refreshAsset, removeAsset } from './assetService.js';
import { adapterFor } from './adapters/registry.js';
import { APPROVAL_POLICY_MODES, EXTERNAL_AGENTS_LEVELS, type ApprovalPolicyMode, type ClientAccount, type ClientMode, type ClientStatus, type ExternalAgentsAccess } from './types.js';
import { addApprover, countActiveApprovers, decideFromPortal, listApprovers, portalEnabled, revokeAllLinksForClient, revokeApprover, sendApprovalLinks } from './portal.js';
import { personalTenantOf } from '../../host/requestSubject.js';
import { answerQuestions, createRequest, editRequest, getRequest, listRequests } from './requestService.js';
import { diffOf, getChangeSet, listChangeSets, markStaleForRequest } from './changeSetService.js';
import { startChangeRequestRun } from './runLauncher.js';
import { requestChangeSetApproval } from './approval.js';
import { getJob, listJobs, jobIdOf } from './execution.js';
import { AUTONOMY_TOGGLE, AUTONOMY_TOGGLE_LABEL, applyPolicyChange, describePolicy, parsePolicyBody } from '../../host/autonomyPolicy/index.js';

import { deleteAgentBinding, listAgentBindings, pinsStoredKey, upsertAgentBinding } from './agentBindingService.js';
import {
  addClientNote, decideClientNoteProposal, listClientNoteProposals, listClientNotes, listClientRecall, purgeClientMemory, removeClientNote,
  type ClientNoteProposalStatus,
} from './clientMemory.js';
import { getClientContextSources, setClientContextSources } from './clientContext.js';
import { getClientTeam } from './teamService.js';
import { listRunReadReceipts } from '../../host/memoryReadReceipts.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { runClientStamp } from '../../host/runClientOrg.js';
import { listCollections } from '../kb/kbService.js';

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
export async function authorizeClient(req: Request, scope: Scope): Promise<{ client: ClientAccount; tenantId: string; userId: string }> {
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
      const body = (req.body ?? {}) as { status?: unknown; mode?: unknown; name?: unknown; approvalPolicy?: unknown; externalAgents?: unknown };
      if (body.status !== undefined && !STATUSES.includes(body.status as ClientStatus)) {
        throw new OpenwopError('validation_error', `status MUST be one of ${STATUSES.join(', ')}.`, 400, { field: 'status' });
      }
      if (body.mode !== undefined && !MODES.includes(body.mode as ClientMode)) {
        throw new OpenwopError('validation_error', `mode MUST be one of ${MODES.join(', ')}.`, 400, { field: 'mode' });
      }
      if (body.approvalPolicy !== undefined && !APPROVAL_POLICY_MODES.includes(body.approvalPolicy as ApprovalPolicyMode)) {
        throw new OpenwopError('validation_error', `approvalPolicy MUST be one of ${APPROVAL_POLICY_MODES.join(', ')}.`, 400, { field: 'approvalPolicy' });
      }
      // ADR 0924 D4 — `client` needs the portal and someone at the client to decide.
      if (body.approvalPolicy === 'client') {
        if (!(await portalEnabled(tenantId))) {
          throw new OpenwopError('validation_error', 'Turn on the client approval portal first.', 409, { reason: 'portal_off' });
        }
        if ((await countActiveApprovers(tenantId, req.params.orgId)) === 0) {
          throw new OpenwopError('validation_error', 'Add a client approver first.', 409, { reason: 'no_client_approver' });
        }
      }
      // ADR 0962 D7 — what outside agents may do for this client (an admin act, like `mode`).
      if (body.externalAgents !== undefined && !EXTERNAL_AGENTS_LEVELS.includes(body.externalAgents as ExternalAgentsAccess)) {
        throw new OpenwopError('validation_error', `externalAgents MUST be one of ${EXTERNAL_AGENTS_LEVELS.join(', ')}.`, 400, { field: 'externalAgents' });
      }
      const client = await updateClient(tenantId, req.params.orgId, {
        ...(body.externalAgents !== undefined ? { externalAgents: body.externalAgents as ExternalAgentsAccess } : {}),
        ...(body.status !== undefined ? { status: body.status as ClientStatus } : {}),
        ...(body.mode !== undefined ? { mode: body.mode as ClientMode } : {}),
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(body.approvalPolicy !== undefined ? { approvalPolicy: body.approvalPolicy as ApprovalPolicyMode } : {}),
      });
      if (!client) throw new OpenwopError('not_found', 'Client not found.', 404, {});
      // ADR 0921 Q2 — archiving a client ends every approval link it has out,
      // and (ADR 0958 D7) suspends its signed-in collaborators, so un-archiving
      // brings none back without an agency member reactivating them.
      if (client.status === 'archived') {
        await revokeAllLinksForClient(tenantId, client.orgId);
        await suspendCollaboratorsForOrg(tenantId, client.orgId, 'system:client-archived');
      }
      res.json({ client });
    } catch (err) { next(err); }
  });

  // ── ADR 0942 P0 — the client's default autonomy policy ──
  // The sub-toggle's parent is `campaign-orchestration` (ADR 0941 D5), so it is
  // AND-gated here in code as well.
  const requireAutonomyToggles = async (req: Request): Promise<void> => {
    await requireFeatureEnabled(req, 'campaign-orchestration', 'Campaign Studio');
    await requireFeatureEnabled(req, AUTONOMY_TOGGLE, AUTONOMY_TOGGLE_LABEL);
  };
  // AND-gated: campaign-ops (inside authorizeClient), then the
  // `campaign-orchestration.autonomy` sub-toggle. Reading needs workspace:read on
  // the client; setting it is an agency-admin act in either direction (D9), and
  // a loosen is audited and tells the client org's admins.

  app.get(`${BASE}/clients/:orgId/autonomy-default`, async (req, res, next) => {
    try {
      const { tenantId, client } = await authorizeClient(req, 'workspace:read');
      await requireAutonomyToggles(req);
      res.json(await describePolicy(tenantId, client.orgId));
    } catch (err) { next(err); }
  });

  app.put(`${BASE}/clients/:orgId/autonomy-default`, async (req, res, next) => {
    try {
      const { tenantId, client, userId } = await authorizeClient(req, 'workspace:read');
      await requireAutonomyToggles(req);
      await requireAgencyAdmin(req);
      const { input, ifMatch } = parsePolicyBody(req.body);
      const result = await applyPolicyChange({
        tenantId, orgId: client.orgId, input, ...(ifMatch !== undefined ? { ifMatch } : {}), actor: userId,
        authorize: async () => { /* agency admin, checked above, may move the default either way */ },
      });
      res.json({ ...(await describePolicy(tenantId, client.orgId)), direction: result.direction, loosened: result.loosened });
    } catch (err) { next(err); }
  });

  // ── Client memory (ADR 0944 D4) ──
  // Curated notes are the trusted lane into the client's shared agent memory:
  // read on `workspace:read`, written and removed on `workspace:write` of THAT
  // client. Agent proposals wait outside memory until a person decides them.

  app.get(`${BASE}/clients/:orgId/memory/notes`, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeClient(req, 'workspace:read');
      res.json({ notes: await listClientNotes(tenantId, req.params.orgId) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/clients/:orgId/memory/notes`, async (req, res, next) => {
    try {
      const { tenantId, userId } = await authorizeClient(req, 'workspace:write');
      const { id } = await addClientNote(tenantId, req.params.orgId, (req.body as { content?: unknown } | undefined)?.content, userId);
      res.status(201).json({ noteId: id });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/clients/:orgId/memory/notes/:noteId`, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeClient(req, 'workspace:write');
      const out = await removeClientNote(tenantId, req.params.orgId, req.params.noteId);
      if (!out.removed) throw new OpenwopError('not_found', 'Note not found.', 404, { noteId: req.params.noteId });
      // A durable delete whose recall index lagged is reported, never a bare 204.
      if (!out.recallCleared) { res.json({ recallCleared: false }); return; }
      res.status(204).end();
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/clients/:orgId/memory/proposals`, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeClient(req, 'workspace:read');
      const status = typeof req.query.status === 'string' && ['pending', 'approved', 'rejected'].includes(req.query.status)
        ? req.query.status as ClientNoteProposalStatus : undefined;
      res.json({ proposals: await listClientNoteProposals(tenantId, req.params.orgId, status) });
    } catch (err) { next(err); }
  });

  // ADR 0944 D4 — what the agents wrote (turn summaries, untrusted), for review.
  app.get(`${BASE}/clients/:orgId/memory/recall`, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeClient(req, 'workspace:read');
      res.json({ entries: await listClientRecall(tenantId, req.params.orgId) });
    } catch (err) { next(err); }
  });

  // ADR 0944 D8 — client off-boarding: empty this client's memory everywhere.
  // An agency-admin act (it destroys a client's institutional memory).
  app.delete(`${BASE}/clients/:orgId/memory`, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeClient(req, 'workspace:read');
      await requireAgencyAdmin(req);
      res.json({ report: await purgeClientMemory(tenantId, req.params.orgId) });
    } catch (err) { next(err); }
  });

  // ADR 0944 D5 — which of the client's knowledge collections its campaign
  // agents search (Q5: an explicit list, never "every collection in the org").
  app.get(`${BASE}/clients/:orgId/memory/sources`, async (req, res, next) => {
    try {
      const { tenantId, userId } = await authorizeClient(req, 'workspace:read');
      // Preserve the KB service's subject gate for project-bound collections.
      const available = (await listCollections(tenantId, req.params.orgId, { subject: userId })).map((c) => ({ collectionId: c.collectionId, name: c.name }));
      const readable = new Set(available.map((c) => c.collectionId));
      res.json({ collectionIds: (await getClientContextSources(tenantId, req.params.orgId)).filter((id) => readable.has(id)), available });
    } catch (err) { next(err); }
  });

  app.put(`${BASE}/clients/:orgId/memory/sources`, async (req, res, next) => {
    try {
      const { tenantId, userId } = await authorizeClient(req, 'workspace:write');
      const ids = await setClientContextSources(tenantId, req.params.orgId, (req.body as { collectionIds?: unknown } | undefined)?.collectionIds, userId);
      res.json({ collectionIds: ids });
    } catch (err) { next(err); }
  });

  // ADR 0944 D6 — "what did the agent recall?": a client run's read receipts
  // (ids and a content hash, never content). Only this client's receipts.
  app.get(`${BASE}/clients/:orgId/runs/:runId/memory-receipts`, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeClient(req, 'workspace:read');
      const run = await hostExtStorage().getRun(req.params.runId);
      const client = runClientStamp(run?.metadata);
      if (!run || run.tenantId !== tenantId || !client || 'refused' in client || client.orgId !== req.params.orgId) {
        throw new OpenwopError('not_found', 'Run not found.', 404, { runId: req.params.runId });
      }
      const rows = (await listRunReadReceipts(tenantId, req.params.runId)).filter((r) => r.orgId === req.params.orgId);
      res.json({ receipts: rows.map(({ key: _key, ...r }) => r) });
    } catch (err) { next(err); }
  });

  for (const decision of ['approve', 'reject'] as const) {
    app.post(`${BASE}/clients/:orgId/memory/proposals/:proposalId/${decision}`, async (req, res, next) => {
      try {
        const { tenantId, userId } = await authorizeClient(req, 'workspace:write');
        res.json({ proposal: await decideClientNoteProposal(tenantId, req.params.orgId, req.params.proposalId, decision, userId) });
      } catch (err) { next(err); }
    });
  }

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

  // ── Client approvers and the portal (ADR 0924 D5, P1) ──

  app.get(`${BASE}/clients/:orgId/approvers`, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeClient(req, 'workspace:read');
      res.json({ approvers: await listApprovers(tenantId, req.params.orgId), portalEnabled: await portalEnabled(tenantId) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/clients/:orgId/approvers`, async (req, res, next) => {
    try {
      const { tenantId, userId } = await authorizeClient(req, 'host:members:manage');
      if (!(await portalEnabled(tenantId))) {
        throw new OpenwopError('validation_error', 'Turn on the client approval portal first.', 409, { reason: 'portal_off' });
      }
      const body = (req.body ?? {}) as { email?: unknown; displayName?: unknown };
      const approver = await addApprover({ tenantId, orgId: req.params.orgId, email: body.email, displayName: body.displayName, createdBy: userId });
      res.status(201).json({ approver });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/clients/:orgId/approvers/:approverId`, async (req, res, next) => {
    try {
      const { tenantId, userId, client } = await authorizeClient(req, 'host:members:manage');
      const approver = await revokeApprover(tenantId, client, req.params.approverId, userId);
      if (!approver) throw new OpenwopError('not_found', 'Approver not found.', 404, {});
      res.json({ approver });
    } catch (err) { next(err); }
  });

  /** Mint one link per active approver for an in-review change set. The URLs are
   *  returned once; the operator sends them (no email in v1). The sender is the
   *  agency authority the approved change is written under. */
  app.post(`${BASE}/clients/:orgId/change-sets/:changeSetId/approval-links`, async (req, res, next) => {
    try {
      const { tenantId, userId, client } = await authorizeClient(req, 'workspace:write');
      const links = await sendApprovalLinks({ tenantId, client, changeSetId: req.params.changeSetId, sentBy: userId, baseUrl: publicBaseUrl(req) });
      res.status(201).json({ links });
    } catch (err) { next(err); }
  });

  // The client approver's decision. Public (PUBLIC_PATH_PREFIXES); the token is
  // the authority and the source of tenant, org and change set. The package
  // itself is read through the sharing viewer (`/shared/:token`).
  app.post('/host/openwop-app/public-campaign-approval/:token/decision', async (req, res, next) => {
    try {
      res.json(await decideFromPortal({ token: req.params.token, ip: clientIp(req), body: req.body }));
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

  // ── Agent bindings (ADR 0943 D2) ──
  // A client's replacement for an agent a chain pins. Frozen into each run at
  // start; editing one never changes a run that already exists.

  app.get(`${BASE}/clients/:orgId/agent-bindings`, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeClient(req, 'workspace:read');
      res.json({ bindings: await listAgentBindings(tenantId, req.params.orgId) });
    } catch (err) { next(err); }
  });

  /** ADR 0943 P4 — the Team tab: each role, the agent it runs as for this client,
   *  and the last workspace eval. `canEdit` is decided HERE with the write
   *  predicate the PUT/DELETE routes use, never inferred by the browser. */
  app.get(`${BASE}/clients/:orgId/team`, async (req, res, next) => {
    try {
      const { tenantId, userId } = await authorizeClient(req, 'workspace:read');
      const canEdit = await authorizeClient(req, 'workspace:write').then(() => true, () => false);
      res.json({ ...(await getClientTeam(tenantId, req.params.orgId, { userId })), canEdit });
    } catch (err) { next(err); }
  });

  /** Create or replace the binding for one (pin, workflow?, node?) scope. A
   *  binding that pins a stored key spends the agency's key, so it also needs
   *  the ONE BYOK write predicate (`requireByokManage`, ADR 0943 D6). */
  app.put(`${BASE}/clients/:orgId/agent-bindings`, async (req, res, next) => {
    try {
      const { tenantId, userId } = await authorizeClient(req, 'workspace:write');
      if (pinsStoredKey(req.body)) await requireByokManage(req);
      const binding = await upsertAgentBinding({ tenantId, orgId: req.params.orgId, body: req.body, updatedBy: userId });
      res.json({ binding });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/clients/:orgId/agent-bindings/:bindingId`, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeClient(req, 'workspace:write');
      if (!(await deleteAgentBinding(tenantId, req.params.orgId, req.params.bindingId))) {
        throw new OpenwopError('not_found', 'Binding not found.', 404, { bindingId: req.params.bindingId });
      }
      res.status(204).end();
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
