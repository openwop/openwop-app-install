/**
 * ADR 0962 P1 — the read door external agents (Claude, ChatGPT, Copilot over the
 * MCP mount) use: one client per call, the agency's RBAC, nothing that writes.
 *
 * Every read starts with `bindExternalRead(scope, clientId)`:
 *   1. a person must be behind the run, and they must hold `workspace:read` on
 *      THAT client; a foreign or unknown client is the SAME `not_found` (no
 *      existence leak), checked before anything else;
 *   2. D7 — an external-agent run (MCP-started, or untrusted) needs the client's
 *      `externalAgents` to be `read` or `request`. Absent or anything else is
 *      `off` (fail closed);
 *   3. D3 — the run is stamped with the ADR 0921 client stamp and
 *      `approverOrgId` on first bind (first writer wins, then verified), so every
 *      campaign MCP run is client-bound and its later gates resolve approvers on
 *      that client (ADR 0962 D4.1b).
 *
 * Outputs are aggregates and ids: no lead PII, no connection details, no other
 * client's names, no gate payload content (D5).
 */
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { OpenwopError, type RunRecord } from '../../types.js';
import { getCampaign, listCampaigns } from '../campaign-orchestration/campaignService.js';
import { listCampaignRuns } from '../campaign-orchestration/campaignRunTag.js';
import type { MarketingCampaign } from '../campaign-orchestration/types.js';
import { listRecords } from '../campaign-connectors/performanceService.js';
import { runClientStamp } from '../../host/runClientOrg.js';
import { featureAccessRefusal } from '../../host/workflowFeatureGate.js';
import { getClient } from './clientService.js';
import { createRequest } from './requestService.js';
import { CAMPAIGN_OPS_RUN_STAMP, bindRunToClient } from './surface.js';
import type { ExternalAgentsAccess } from './types.js';

const MCP_SOURCE = 'mcp-server-mount';
/** Bounds on the pending-gates walk (campaigns × runs per campaign). */
const MAX_CAMPAIGNS = 50;
const MAX_RUNS_PER_CAMPAIGN = 20;

const notFound = (): OpenwopError => new OpenwopError('not_found', 'Client not found.', 404, {});

export function externalAgentsOf(raw: unknown): ExternalAgentsAccess {
  return raw === 'read' || raw === 'request' ? raw : 'off';
}

async function runOf(scope: BundleScope): Promise<RunRecord | null> {
  if (!scope.runId) return null;
  const run = await hostExtStorage().getRun(scope.runId);
  return run && run.tenantId === scope.tenantId ? run : null;
}

function isExternalRun(run: RunRecord | null): boolean {
  const md = (run?.metadata ?? {}) as Record<string, unknown>;
  return md.source === MCP_SOURCE || md.trustBoundary === 'untrusted';
}

/** The one bind every external read starts with. Returns the acting person. */
export function bindExternalRead(scope: BundleScope, clientId: string): Promise<string> {
  return bindExternal(scope, clientId, 'read');
}

/**
 * ADR 0962 — the one bind for every external call. `read` needs `workspace:read`
 * on the client and `externalAgents` of `read` or `request`; `request` needs
 * `workspace:write` and `externalAgents === 'request'`. Not-found first, always.
 */
export async function bindExternal(scope: BundleScope, clientId: string, need: 'read' | 'request'): Promise<string> {
  if (!clientId) throw new OpenwopError('validation_error', '`clientId` is required.', 400, { field: 'clientId' });
  if (!(await resolveOne('campaign-ops', { tenantId: scope.tenantId }).catch(() => null))?.enabled) throw notFound();
  let person: string;
  try {
    person = await bindRunToClient(scope, clientId, need === 'request' ? 'workspace:write' : 'workspace:read');
  } catch (err) {
    // No person behind the run is its own, honest refusal. Every other refusal —
    // no access, unknown client, a run bound to another client — is one not-found.
    if (err instanceof OpenwopError && (err.details as { reason?: unknown } | undefined)?.reason === 'no_acting_user') throw err;
    if (err instanceof OpenwopError && (err.httpStatus === 403 || err.httpStatus === 404)) throw notFound();
    throw err;
  }
  const run = await runOf(scope);
  if (scope.runId && !run) throw notFound();
  const binding = runClientStamp(run?.metadata as Record<string, unknown> | undefined);
  if (binding && (!('orgId' in binding) || binding.orgId !== clientId)) throw notFound();
  if (await featureAccessRefusal('campaign-orchestration', scope.tenantId)) throw notFound();
  const client = await getClient(scope.tenantId, clientId);
  if (!client) throw notFound();
  const allowed = externalAgentsOf(client.externalAgents);
  if (isExternalRun(run) && allowed === 'off') {
    throw new OpenwopError('forbidden_scope', 'This client does not allow outside agents. An admin can change that in campaign operations.', 403, { reason: 'external_agents_off' });
  }
  if (need === 'request' && isExternalRun(run) && allowed !== 'request') {
    throw new OpenwopError('forbidden_scope', 'Outside agents may only read this client\'s campaigns. An admin can allow change requests in campaign operations.', 403, { reason: 'external_agents_read_only' });
  }
  if (run) await stampRunClient(run, clientId);
  return person;
}

/** D3 — first writer wins (`ifAbsentKey`), then verified. Never overwrites. */
async function stampRunClient(run: RunRecord, clientId: string): Promise<void> {
  const md = (run.metadata ?? {}) as Record<string, unknown>;
  const existingApprover = md.approverOrgId;
  if (typeof existingApprover === 'string' && existingApprover !== clientId) throw notFound();
  const storage = hostExtStorage();
  await storage.mergeRunMetadata(run.runId, { [CAMPAIGN_OPS_RUN_STAMP]: { orgId: clientId }, approverOrgId: clientId }, { ifAbsentKey: CAMPAIGN_OPS_RUN_STAMP });
  const bound = await storage.getRun(run.runId);
  const binding = runClientStamp(bound?.metadata as Record<string, unknown> | undefined);
  if (!bound || bound.tenantId !== run.tenantId || !binding || !('orgId' in binding) || binding.orgId !== clientId) throw notFound();
  await storage.mergeRunMetadata(run.runId, { approverOrgId: clientId }, { ifAbsentKey: 'approverOrgId' });
  const after = (((await storage.getRun(run.runId))?.metadata ?? {}) as Record<string, unknown>);
  const stamp = after[CAMPAIGN_OPS_RUN_STAMP] as { orgId?: unknown } | undefined;
  if (stamp?.orgId !== clientId || after.approverOrgId !== clientId) throw notFound();
}

async function campaignOf(tenantId: string, clientId: string, campaignId: string): Promise<MarketingCampaign> {
  const c = campaignId ? await getCampaign(tenantId, campaignId) : null;
  if (!c || c.orgId !== clientId) throw new OpenwopError('not_found', 'Campaign not found.', 404, {});
  return c;
}

/** A run of THIS client's campaigns (tag or client stamp), else not-found. */
async function clientRunOf(tenantId: string, clientId: string, runId: string): Promise<RunRecord> {
  const run = runId ? await hostExtStorage().getRun(runId) : null;
  const refuse = (): OpenwopError => new OpenwopError('not_found', 'Run not found.', 404, {});
  if (!run || run.tenantId !== tenantId) throw refuse();
  const md = (run.metadata ?? {}) as Record<string, unknown>;
  const binding = runClientStamp(md);
  if (!binding || !('orgId' in binding) || binding.orgId !== clientId) throw refuse();
  return run;
}

const campaignSummary = (c: MarketingCampaign): Record<string, unknown> => ({
  campaignId: c.id, name: c.name, status: c.status, channels: c.channels,
  finalized: Boolean(c.finalizedAt) || !c.ignitedAt, updatedAt: c.updatedAt,
});

export async function mcpListCampaigns(scope: BundleScope, clientId: string): Promise<Record<string, unknown>> {
  await bindExternalRead(scope, clientId);
  const campaigns = await listCampaigns(scope.tenantId, clientId);
  return { clientId, campaigns: campaigns.filter((c) => c.orgId === clientId).map(campaignSummary) };
}

export async function mcpGetCampaign(scope: BundleScope, clientId: string, campaignId: string): Promise<Record<string, unknown>> {
  await bindExternalRead(scope, clientId);
  const c = await campaignOf(scope.tenantId, clientId, campaignId);
  return {
    clientId,
    campaign: {
      ...campaignSummary(c), objective: c.objective, createdAt: c.createdAt,
      ...(c.kernel?.headline ? { kernelHeadline: c.kernel.headline } : {}),
      assetCount: c.assetIds?.length ?? 0,
      ...(c.goal ? { goal: c.goal } : {}),
    },
  };
}

export async function mcpCampaignPerformance(scope: BundleScope, clientId: string, campaignId: string): Promise<Record<string, unknown>> {
  await bindExternalRead(scope, clientId);
  const c = await campaignOf(scope.tenantId, clientId, campaignId);
  if (await featureAccessRefusal('campaign-connectors', scope.tenantId)) {
    throw new OpenwopError('forbidden_scope', 'Campaign performance is unavailable because its source cannot be used.', 403, { reason: 'source_feature_unavailable', feature: 'campaign-connectors' });
  }
  const rows = (await listRecords(scope.tenantId, clientId, c.id)).filter((r) => r.orgId === clientId);
  // Totals per platform AND currency: never summed across currencies. A null
  // conversion count is unknown, not zero, so it is reported as such.
  type Totals = { platform: string; currency: string | null; spend: number; impressions: number; clicks: number; conversions: number | null; days: number };
  const by = new Map<string, Totals>();
  for (const r of rows) {
    const currency = (r as { currency?: string }).currency ?? null;
    const key = `${r.platform}\u0000${currency ?? ''}`;
    const t = by.get(key) ?? { platform: r.platform, currency, spend: 0, impressions: 0, clicks: 0, conversions: 0, days: 0 };
    t.spend += r.spend; t.impressions += r.impressions; t.clicks += r.clicks; t.days += 1;
    t.conversions = t.conversions === null || r.conversions === null ? null : t.conversions + r.conversions;
    by.set(key, t);
  }
  const dates = rows.map((r) => r.date).sort();
  return { clientId, campaignId: c.id, from: dates[0] ?? null, to: dates[dates.length - 1] ?? null, totals: [...by.values()] };
}

export async function mcpPendingGates(scope: BundleScope, clientId: string): Promise<Record<string, unknown>> {
  await bindExternalRead(scope, clientId);
  const storage = hostExtStorage();
  const campaigns = (await listCampaigns(scope.tenantId, clientId)).filter((c) => c.orgId === clientId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  let truncated = campaigns.length > MAX_CAMPAIGNS;
  const gates: Array<Record<string, unknown>> = [];
  for (const c of campaigns.slice(0, MAX_CAMPAIGNS)) {
    const runs = await listCampaignRuns(scope.tenantId, c.id);
    if (runs.length > MAX_RUNS_PER_CAMPAIGN) truncated = true;
    for (const r of runs.slice(0, MAX_RUNS_PER_CAMPAIGN)) {
      // An index is a candidate list; the primary run remains the client authority.
      try { await clientRunOf(scope.tenantId, clientId, r.runId); }
      catch (err) { if (err instanceof OpenwopError && err.httpStatus === 404) continue; throw err; }
      for (const it of await storage.listOpenInterrupts(r.runId)) {
        if (it.kind !== 'approval') continue;
        const d = (it.data ?? {}) as { prompt?: unknown; title?: unknown; approverRoleRefs?: unknown; requiredApprovals?: unknown; timeoutMs?: unknown };
        gates.push({
          campaignId: c.id, campaignName: c.name, runId: r.runId,
          title: 'Approval', // D5: gate payload text can contain client PII or credentials.
          roles: Array.isArray(d.approverRoleRefs) ? d.approverRoleRefs.filter((x): x is string => typeof x === 'string') : [],
          requiredApprovals: typeof d.requiredApprovals === 'number' ? d.requiredApprovals : 1,
          ...(typeof d.timeoutMs === 'number' ? { expiresInMs: d.timeoutMs } : {}),
          inbox: '/approvals',
        });
      }
    }
  }
  return { clientId, gates, truncated };
}

export async function mcpRunStatus(scope: BundleScope, clientId: string, runId: string): Promise<Record<string, unknown>> {
  await bindExternalRead(scope, clientId);
  const run = await clientRunOf(scope.tenantId, clientId, runId);
  const open = await hostExtStorage().listOpenInterrupts(run.runId);
  return {
    clientId, runId: run.runId, status: run.status, updatedAt: run.updatedAt,
    waitingOn: open.filter((i) => i.kind === 'approval').map(() => 'Approval'), // D5: no payload text
  };
}

/** The 0942 gate decisions on a run: what the policy decided, by which rule. */
export async function mcpExplain(scope: BundleScope, clientId: string, runId: string): Promise<Record<string, unknown>> {
  await bindExternalRead(scope, clientId);
  const run = await clientRunOf(scope.tenantId, clientId, runId);
  const page = await hostExtStorage().listEvents(run.runId, { limit: 2001 });
  const events = page.slice(0, 2000);
  const decisions: Array<Record<string, unknown>> = [];
  for (const e of events) {
    const p = (e.payload ?? {}) as { outputs?: { decision?: unknown; ruleId?: unknown; layer?: unknown }; error?: { code?: unknown } };
    if (e.type === 'node.completed' && typeof p.outputs?.decision === 'string' && typeof p.outputs.ruleId === 'string') {
      decisions.push({ step: e.nodeId, decision: p.outputs.decision, ruleId: p.outputs.ruleId, ...(typeof p.outputs.layer === 'string' ? { layer: p.outputs.layer } : {}) });
    } else if (e.type === 'node.failed' && (p.error?.code === 'autonomy_blocked' || p.error?.code === 'autonomy_rejected')) {
      decisions.push({ step: e.nodeId, decision: p.error.code === 'autonomy_blocked' ? 'blocked' : 'rejected' });
    }
  }
  const open = await hostExtStorage().listOpenInterrupts(run.runId);
  const waiting = open.flatMap((i) => {
    const a = ((i.data ?? {}) as { autonomy?: { actionClass?: unknown; ruleId?: unknown } }).autonomy;
    return a && typeof a.ruleId === 'string' ? [{ step: i.nodeId, decision: 'waiting-for-approval', ruleId: a.ruleId, actionClass: a.actionClass }] : [];
  });
  return { clientId, runId: run.runId, status: run.status, decisions: [...decisions, ...waiting], truncated: page.length > 2000, runLink: `/runs/${encodeURIComponent(run.runId)}` };
}

// ── ADR 0962 P2 — request tools. A request WRITES only a request row and starts
// the governed chain; the effect waits on the ADR 0924 human approval (separation
// of duties: the person behind the key cannot approve it). Never "done".

type ChangeRequestStarter = (input: {
  tenantId: string; orgId: string; requestId: string; version: number; causedBy: string; metadata: Record<string, unknown>;
}) => Promise<string>;
let startChangeRequest: ChangeRequestStarter | null = null;
/** Registered from `feature.ts` (the surface has no storage/hostSuite). */
export function registerMcpChangeRequestStarter(fn: ChangeRequestStarter | null): void { startChangeRequest = fn; }

export const EXTERNAL_AGENT_METADATA_KEY = 'openwop-app.externalAgent';

export async function mcpRequestChange(scope: BundleScope, args: { clientId: string; text: unknown; assetIds?: unknown; campaignId?: string }): Promise<Record<string, unknown>> {
  const person = await bindExternal(scope, args.clientId, 'request');
  if (!startChangeRequest) throw new OpenwopError('host_capability_missing', 'Change requests are not available on this host.', 503, {});
  const run = await runOf(scope);
  const md = (run?.metadata ?? {}) as Record<string, unknown>;
  // Provenance is COPIED from the calling run, never asserted: a non-MCP caller of
  // this method cannot mint an "MCP" run, and an MCP caller cannot shed it. The
  // client stamp the starter writes makes the child a campaign run for ADR 0962
  // D4.1, and these keys keep it external for the ADR 0942 MCP-origin floor.
  const provenance: Record<string, unknown> = {
    ...(typeof md.source === 'string' ? { source: md.source } : {}),
    ...(typeof md.trustBoundary === 'string' ? { trustBoundary: md.trustBoundary } : {}),
    [EXTERNAL_AGENT_METADATA_KEY]: { protocol: 'mcp', ...(scope.runId ? { viaRunId: scope.runId } : {}) },
  };
  const request = await createRequest({
    tenantId: scope.tenantId, orgId: args.clientId, text: args.text, assetIds: args.assetIds ?? [],
    ...(args.campaignId ? { campaignId: args.campaignId } : {}),
    createdBy: person,
    via: { protocol: 'mcp', ...(scope.runId ? { runId: scope.runId } : {}) },
  });
  if (request.status === 'duplicate') {
    return { clientId: args.clientId, requestId: request.requestId, status: 'duplicate', duplicateOf: request.duplicateOf ?? null };
  }
  const runId = await startChangeRequest({
    tenantId: scope.tenantId, orgId: args.clientId, requestId: request.requestId, version: request.version, causedBy: person, metadata: provenance,
  });
  return {
    clientId: args.clientId, requestId: request.requestId, runId, status: 'awaiting-input',
    next: 'The change is planned, then waits for a person at the client to approve it in the app. Nothing changes until then.',
    inbox: '/campaign-ops',
  };
}
