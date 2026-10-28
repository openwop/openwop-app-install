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
import { listAgentBindings } from './agentBindingService.js';
import { listClientNotes, proposeClientNote } from './clientMemory.js';
import { clientContextForRun } from './clientContext.js';
import { mcpCampaignPerformance, mcpExplain, mcpGetCampaign, mcpListCampaigns, mcpPendingGates, mcpRequestChange, mcpRunStatus } from './externalRead.js';

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

    /** ADR 0943 D2 — the client's agent bindings, read only. What a run
     *  ACTUALLY uses is the map frozen on it at start, not this live list. */
    listAgentBindings: async (args) => {
      const orgId = str(args.orgId);
      await bindRunToClient(scope, orgId);
      return {
        bindings: (await listAgentBindings(tenantId, orgId)).map((b) => ({
          bindingId: b.bindingId, pinnedAgentId: b.pinnedAgentId, agentId: b.agentId,
          ...(b.workflowId ? { workflowId: b.workflowId } : {}),
          ...(b.nodeId ? { nodeId: b.nodeId } : {}),
          ...(b.model ? { model: { provider: b.model.provider, model: b.model.model } } : {}),
        })),
      };

    },

    /** ADR 0944 D4 — read before proposing: the client's curated notes. Bound to
     *  the run's client like every op here (a run stamped A asking for B is
     *  refused `wrong_client` before anything is read). */
    listClientNotes: async (args) => {
      const orgId = str(args.orgId);
      await bindRunToClient(scope, orgId);
      const notes = await listClientNotes(tenantId, orgId);
      return { notes: notes.map((n) => ({ id: n.id, content: n.content, createdAt: n.createdAt })) };
    },

    /** ADR 0944 D5 — the run's frozen client context block (the same text its
     *  agents receive). Bound to the run's client; a run with no client context,
     *  or one whose client binding no longer holds, gets `available:false`. */
    clientContext: async (args) => {
      const orgId = str(args.orgId);
      await bindRunToClient(scope, orgId);
      const out = scope.runId ? await clientContextForRun(tenantId, scope.runId) : null;
      if (!out || 'refused' in out || out.snapshot.orgId !== orgId) return { available: false };
      return { available: true, block: out.snapshot.block, sources: out.snapshot.sources, omitted: out.snapshot.omitted };
    },

    /** ADR 0944 D4 — an agent never writes a trusted client fact: it proposes
     *  one, and a person with write on the client decides it. */
    proposeClientNote: async (args) => {
      const orgId = str(args.orgId);
      await bindRunToClient(scope, orgId);
      if (!scope.runId) throw new OpenwopError('forbidden_scope', 'Only a run can propose a client note.', 403, { reason: 'no_run' });
      const { proposal, created } = await proposeClientNote({
        tenantId, orgId, content: args.content, rationale: args.rationale,
        proposedBy: { runId: scope.runId, nodeId: optStr(args.nodeId) ?? 'unknown', ...(optStr(args.agentId) ? { agentId: optStr(args.agentId) } : {}) },
      });
      return { proposalId: proposal.proposalId, status: proposal.status, created };
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

    /** ADR 0957 D2 `compute-snapshot`: run the definition's section sources for
     *  the client and store a draft report. The run's id is recorded on it. */
    computeReportSnapshot: async (args) => {
      const orgId = str(args.orgId);
      const person = await bindRunToClient(scope, orgId, 'workspace:write');
      await requireClientReports(tenantId);
      const { getDefinition, resolvePeriod, createReport } = await import('./reports/reportService.js');
      const def = await getDefinition(tenantId, orgId, str(args.definitionId));
      if (!def) throw new OpenwopError('not_found', 'Report definition not found.', 404, { definitionId: str(args.definitionId) });
      // D2 — a scheduled run pins the version it started with; an edit since then
      // is a typed failure, never a report of a definition nobody scheduled.
      if (args.definitionVersion !== undefined && args.definitionVersion !== null && Number(args.definitionVersion) !== def.version) {
        throw new OpenwopError('conflict', 'The report definition changed after this run was scheduled.', 409, { reason: 'report_definition_changed', pinned: Number(args.definitionVersion), current: def.version });
      }
      const period = resolvePeriod(def.period.kind, { start: optStr(args.periodStart), end: optStr(args.periodEnd) });
      const report = await createReport(def, period, person, scope.runId ? { runId: scope.runId } : {});
      return { reportId: report.reportId, snapshot: report.snapshot, snapshotHash: report.snapshotHash };
    },
    /** ADR 0957 D3 `report-snapshot-read`: a stored report's frozen numbers. */
    readReportSnapshot: async (args) => {
      const orgId = str(args.orgId);
      await bindRunToClient(scope, orgId);
      await requireClientReports(tenantId);
      const { getReport } = await import('./reports/reportService.js');
      const report = await getReport(tenantId, orgId, str(args.reportId));
      if (!report) return { found: false };
      return { found: true, reportId: report.reportId, periodStart: report.periodStart, periodEnd: report.periodEnd, snapshot: report.snapshot, snapshotHash: report.snapshotHash };
    },
    /** ADR 0957 D2 step 5 `publish-report`. Publishing must follow the ADR 0942
     *  `report.publish` gate's approval of THIS snapshot. That gate cannot yet
     *  freeze a policy for a client-bound run, so the node REFUSES (typed) until
     *  it can: otherwise a hand-built workflow chaining compute-snapshot into
     *  publish-report would publish numbers nobody reviewed. The CAS itself is
     *  `reportService.publishReport`, which the gated chain will call. */
    publishReport: async (args) => {
      const orgId = str(args.orgId);
      await bindRunToClient(scope, orgId, 'workspace:write');
      await requireClientReports(tenantId);
      throw new OpenwopError('conflict', 'Publishing a client report needs its review approval, which is not available yet.', 409, { reason: 'report_publish_unavailable', reportId: str(args.reportId) });
    },
    // ── ADR 0962 P1 — the external-agent read door (MCP tools). Each binds first
    // (`externalRead.bindExternalRead`: access on THIS client, `externalAgents`,
    // the client stamp). Aggregates and ids only.
    mcpListCampaigns: async (args) => mcpListCampaigns(scope, str(args.clientId)),
    mcpGetCampaign: async (args) => mcpGetCampaign(scope, str(args.clientId), str(args.campaignId)),
    mcpCampaignPerformance: async (args) => mcpCampaignPerformance(scope, str(args.clientId), str(args.campaignId)),
    mcpPendingGates: async (args) => mcpPendingGates(scope, str(args.clientId)),
    mcpRunStatus: async (args) => mcpRunStatus(scope, str(args.clientId), str(args.runId)),
    mcpExplain: async (args) => mcpExplain(scope, str(args.clientId), str(args.runId)),
    // ADR 0962 P2 — a request: writes a request row and starts the governed chain.
    mcpRequestChange: async (args) => mcpRequestChange(scope, {
      clientId: str(args.clientId), text: args.text, assetIds: args.assetIds, ...(optStr(args.campaignId) ? { campaignId: optStr(args.campaignId)! } : {}),
    }),
  };
}

/** The client-reports sub-toggle, checked on the tenant (ADR 0941 D5). */
async function requireClientReports(tenantId: string): Promise<void> {
  const { resolveOne } = await import('../../host/featureToggles/service.js');
  const t = await resolveOne('campaign-ops.client-reports', { tenantId });
  if (!t?.enabled) throw new OpenwopError('not_found', 'Client reports is not enabled for this tenant.', 404, { feature: 'campaign-ops.client-reports' });
}
