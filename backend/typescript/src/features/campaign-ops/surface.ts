/**
 * `ctx.features['campaign-ops']` (ADR 0921 D3, ADR 0922). P0 exposes reads only.
 *
 * Binding rules, stronger than the ADR 0832 floor:
 *  - every op takes `orgId`; there is no op keyed by a bare record id;
 *  - an actorless run is refused (`no_acting_user`): webhook and other
 *    authorless runs cannot read client assets (closes R8 for this surface);
 *  - the acting user must hold `workspace:read` on that exact client org;
 *  - when the run carries a campaign-ops stamp, its `orgId` must equal the
 *    argument (`wrong_client`). Execution runs (ADR 0925) always carry one.
 */
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { assertRunOrgScope } from '../../host/accessControlService.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { getAsset, listAssets } from './assetService.js';
import { failRequest, getRequest, recordInterpretation, requestSourceOf } from './requestService.js';
import { proposalContextOf, proposeChangeSet } from './changeSetService.js';
import { validateInterpretation } from './validation.js';
import { executeApprovedChangeSet } from './execution.js';
import { getApproval } from '../../host/approvalService.js';
import { getClient } from './clientService.js';
import { adapterFor } from './adapters/registry.js';

/** The run-metadata key a campaign-ops run is stamped with (host-namespaced). */
export const CAMPAIGN_OPS_RUN_STAMP = 'openwop-app.campaignOps';

/** The run's campaign-ops stamp, read from the stored run (the bundle scope
 *  carries no metadata). Absent for runs campaign-ops did not start. */
export async function runStampOf(scope: Pick<BundleScope, 'runId' | 'tenantId'>): Promise<{ orgId?: string; changeSetId?: string; changeSetHash?: string } | undefined> {
  if (!scope.runId) return undefined;
  const run = await hostExtStorage().getRun(scope.runId);
  if (!run || run.tenantId !== scope.tenantId) return undefined;
  const v = (run.metadata as Record<string, unknown> | undefined)?.[CAMPAIGN_OPS_RUN_STAMP];
  return v && typeof v === 'object' ? (v as { orgId?: string; changeSetId?: string; changeSetHash?: string }) : undefined;
}

/**
 * The person a campaign-ops run acts for: its acting user, else the member who
 * CAUSED it (`orgScopeSubject`, ADR 0832 D3 — the starter-launched runs the
 * campaign-ops routes start carry that, never an acting user). Either is checked
 * on the exact client org; neither grants anything by itself.
 */
export async function bindRunToClient(scope: BundleScope, orgId: string, need: 'workspace:read' | 'workspace:write' = 'workspace:read'): Promise<string> {
  if (!orgId) throw new OpenwopError('validation_error', '`orgId` is required.', 400, { field: 'orgId' });
  const person = scope.actingUserId ?? scope.orgScopeSubject;
  if (!person) {
    throw new OpenwopError('forbidden_scope', 'Campaign operations need a person behind the run.', 403, { reason: 'no_acting_user' });
  }
  const stamp = await runStampOf(scope);
  if (stamp?.orgId !== undefined && stamp.orgId !== orgId) {
    throw new OpenwopError('forbidden_scope', 'This run belongs to a different client.', 403, { reason: 'wrong_client' });
  }
  await assertRunOrgScope(scope.tenantId, person, orgId, need, { cause: !scope.actingUserId });
  if (!(await getClient(scope.tenantId, orgId))) throw new OpenwopError('not_found', 'Client not found.', 404, { orgId });
  return person;
}

export function buildCampaignOpsSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  /** The request at `version`, or a refusal when it moved on. */
  async function requestAt(orgId: string, requestId: string, version: number) {
    const req = await getRequest(tenantId, orgId, requestId);
    if (!req) throw new OpenwopError('not_found', 'Request not found.', 404, { requestId });
    if (req.version !== version) throw new OpenwopError('conflict', 'This request was edited; the old version is no longer worked on.', 409, { reason: 'request_changed' });
    return req;
  }
  const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));

  return {
    /** ADR 0923 D2 — what the planner interprets: the operator's words, the
     *  answers so far, and the labels of the assets in scope. */
    getRequestContext: async (args) => {
      const orgId = str(args.orgId);
      await bindRunToClient(scope, orgId);
      const req = await requestAt(orgId, str(args.requestId), num(args.version));
      const assets: Array<{ assetId: string; label: string }> = [];
      for (const id of req.assetIds) {
        const a = await getAsset(tenantId, orgId, id);
        if (a) assets.push({ assetId: id, label: a.label });
      }
      const asked = new Map((req.interpretation?.questions ?? []).map((q) => [q.id, q.prompt]));
      return {
        status: req.status,
        text: req.text,
        requestedAt: req.updatedAt,
        answers: req.answers.map((a) => ({ question: asked.get(a.questionId) ?? a.questionId, value: a.value })),
        assets,
      };
    },

    /** Validate and store an interpretation. Invalid output is returned as
     *  errors (the node's ONE repair uses them), never stored. */
    recordInterpretation: async (args) => {
      const orgId = str(args.orgId);
      await bindRunToClient(scope, orgId, 'workspace:write');
      const req = await requestAt(orgId, str(args.requestId), num(args.version));
      const checked = validateInterpretation(args.interpretation, requestSourceOf(req));
      if (!checked.ok) return { ok: false, errors: checked.errors };
      const saved = await recordInterpretation(tenantId, orgId, req.requestId, req.version, checked.value);
      return { ok: true, status: saved.status };
    },

    failRequest: async (args) => {
      const orgId = str(args.orgId);
      await bindRunToClient(scope, orgId, 'workspace:write');
      const saved = await failRequest(tenantId, orgId, str(args.requestId), num(args.version), { code: str(args.code) || 'failed', message: str(args.message) });
      return { status: saved?.status ?? null };
    },

    /** ADR 0923 D5 — read before write: the current text of every editable
     *  field of every asset in scope, plus the validated intents. */
    getProposalContext: async (args) => {
      const orgId = str(args.orgId);
      await bindRunToClient(scope, orgId);
      const req = await requestAt(orgId, str(args.requestId), num(args.version));
      if (req.status !== 'proposing' || !req.interpretation) return { ready: false, status: req.status };
      const assets = await proposalContextOf(tenantId, orgId, req.assetIds);
      return {
        ready: true,
        intents: req.interpretation.intents,
        assets: assets.map((a) => ({ assetId: a.assetId, label: a.label, editableFields: [...a.editableFields], fields: a.fields })),
      };
    },

    /** ADR 0923 D4/D5 — mint the change set, idempotent on `idempotencyKey`. */
    proposeChangeSet: async (args) => {
      const orgId = str(args.orgId);
      const person = await bindRunToClient(scope, orgId, 'workspace:write');
      const out = await proposeChangeSet({
        tenantId, orgId,
        requestId: str(args.requestId),
        version: num(args.version),
        proposal: args.proposal,
        idempotencyKey: str(args.idempotencyKey),
        createdBy: person,
        model: { ...(optStr(args.provider) ? { provider: optStr(args.provider) } : {}), ...(optStr(args.model) ? { model: optStr(args.model) } : {}) },
      });
      if (out.kind === 'invalid') return { ok: false, errors: out.errors };
      if (out.kind === 'no_changes') return { ok: true, noChanges: true };
      return { ok: true, changeSetId: out.changeSet.changeSetId, hash: out.changeSet.hash, entries: out.changeSet.entries.length };
    },

    /** ADR 0925 — run the approved change set. Only a run campaign-ops started
     *  for THIS approval may call it: the run's stamp must name the same client,
     *  approval and change-set hash. */
    executeChangeSet: async (args) => {
      const orgId = str(args.orgId);
      const approvalId = str(args.approvalId);
      await bindRunToClient(scope, orgId, 'workspace:write');
      const stamp = await runStampOf(scope) as { approvalId?: string; changeSetHash?: string } | undefined;
      const approval = await getApproval(approvalId);
      if (!stamp || stamp.approvalId !== approvalId || !approval || stamp.changeSetHash !== approval.changeSetHash) {
        throw new OpenwopError('forbidden', 'Only the run started for this approval can carry it out.', 403, { reason: 'not_the_approved_run' });
      }
      const job = await executeApprovedChangeSet(tenantId, orgId, approvalId);
      return { jobId: job.jobId, status: job.status, outcome: job.outcome ?? null };
    },

    listAssets: async (args) => {
      const orgId = str(args.orgId);
      await bindRunToClient(scope, orgId);
      return { assets: await listAssets(tenantId, orgId, optStr(args.campaignId)) };
    },
    readAsset: async (args) => {
      const orgId = str(args.orgId);
      await bindRunToClient(scope, orgId);
      const asset = await getAsset(tenantId, orgId, str(args.assetId));
      if (!asset) return { found: false };
      const current = await adapterFor(asset.destination)?.read(asset, { tenantId });
      return { found: true, asset, current: current ?? null };
    },
  };
}
