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
import { tenantToggleSubject } from '../../host/operatorPlanExemption.js';
import { getClient } from './clientService.js';
import { createRequest } from './requestService.js';
import { CAMPAIGN_OPS_RUN_STAMP, bindRunToClient } from './surface.js';
import { fenceUntrustedBlock, neutralizeUntrusted } from '../../host/untrustedContent.js';
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
  // CC-MCP-1 (ADR 1108): both feature checks resolve with the RUN's tenant-only
  // toggle subject, so the listed operator's plan exemption reaches them while its
  // stamp holds. With `{ tenantId }` alone, every read in a free-plan workspace was
  // the not-found below, whatever the client's `externalAgents` said.
  const subject = tenantToggleSubject(scope);
  if (!(await resolveOne('campaign-ops', subject).catch(() => null))?.enabled) throw notFound();
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
  if (await featureAccessRefusal('campaign-orchestration', scope.tenantId, subject)) throw notFound();
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
  // CC-MCP-1 residue (ADR 1108): the performance source check resolves with the
  // run's tenant-only toggle subject too, or a plan-exempt operator is refused a
  // feature the workspace has switched on (observed on prod f1b882654).
  if (await featureAccessRefusal('campaign-connectors', scope.tenantId, tenantToggleSubject(scope))) {
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
          inbox: '/inbox',
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

// ── ADR 0962 P2 — `campaign_propose_budget_change`. A PROPOSAL, never a spend:
// it writes one ADR 0952 reallocation plan in `proposed` state and opens ONE
// campaign-spend approval over it. Nothing here, and no node in its chain,
// applies a plan. A person at the client approves it in the Inbox, then applies
// it from Campaign Intelligence on their own connections (the existing route).
//
// Who may decide is bound at propose time: the client's ADR 0942 policy for
// `ads.budget`, resolved through the ONE chokepoint helper on this MCP run (its
// MCP-origin floor clamps `auto` to `approve`; a `blocked` policy refuses), or the
// default owner/admin approvers when the run carries no policy. The approval names
// those approvers, lists the person behind the key as a requester and points at
// this run, so the decide-time check (`autonomyPolicy/spendEligibility.ts`) refuses
// that person with no sole-admin escape (ADR 0942 D10.2, ADR 0962 D4.2).

/** Bounds on one requested daily budget, minor units. The floor is the
 *  reallocation module's own (a scale-down never zeroes a campaign). */
export const MCP_BUDGET_MIN_DAILY_MINOR = 100;
export const MCP_BUDGET_MAX_DAILY_MINOR = 100_000_000;
const MCP_BUDGET_MAX_CHANGES = 20;
const MCP_BUDGET_NOTE_MAX = 500;
const BUDGET_PLATFORMS = new Set(['meta', 'google']);

const invalidChange = (message: string, reason: string, field: string): OpenwopError =>
  new OpenwopError('validation_error', message, 400, { reason, field });

/** Closed-world validation of the agent's requested changes. A bad amount is a
 *  typed failure, never a silently dropped op. */
function parseBudgetChanges(raw: unknown): Array<{ platform: string; campaignId: string; toDailyMinor: number }> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MCP_BUDGET_MAX_CHANGES) {
    throw invalidChange(`\`changes\` must list 1 to ${MCP_BUDGET_MAX_CHANGES} budget changes.`, 'invalid_budget_change', 'changes');
  }
  const seen = new Set<string>();
  return raw.map((c, i) => {
    const row = (c ?? {}) as { platform?: unknown; platformCampaignId?: unknown; toDailyMinor?: unknown };
    const platform = typeof row.platform === 'string' ? row.platform : '';
    const campaignId = typeof row.platformCampaignId === 'string' ? row.platformCampaignId.trim() : '';
    if (!BUDGET_PLATFORMS.has(platform)) throw invalidChange(`changes[${i}].platform must be meta or google.`, 'invalid_budget_change', `changes[${i}].platform`);
    if (!campaignId || campaignId.length > 200) throw invalidChange(`changes[${i}].platformCampaignId is required.`, 'invalid_budget_change', `changes[${i}].platformCampaignId`);
    const to = row.toDailyMinor;
    if (typeof to !== 'number' || !Number.isSafeInteger(to) || to < MCP_BUDGET_MIN_DAILY_MINOR || to > MCP_BUDGET_MAX_DAILY_MINOR) {
      throw invalidChange(
        `changes[${i}].toDailyMinor must be a whole number of minor units from ${MCP_BUDGET_MIN_DAILY_MINOR} to ${MCP_BUDGET_MAX_DAILY_MINOR}.`,
        'invalid_budget_amount', `changes[${i}].toDailyMinor`,
      );
    }
    const key = `${platform}:${campaignId}`;
    if (seen.has(key)) throw invalidChange(`changes[${i}] repeats a campaign.`, 'invalid_budget_change', `changes[${i}]`);
    seen.add(key);
    return { platform, campaignId, toDailyMinor: to };
  });
}

/** A refused or empty proposal as ONE typed failure. Most fundamental first. */
function budgetRefusal(dropped: ReadonlyArray<{ reason: string }>): OpenwopError {
  const count = (p: (r: string) => boolean): number => dropped.filter((d) => p(d.reason)).length;
  const notOrg = count((r) => r === 'not_an_org_campaign');
  if (notOrg) return new OpenwopError('not_found', `${notOrg} of the requested campaigns are not this client's ad campaigns. Nothing was proposed.`, 404, { reason: 'budget_change_target_not_found' });
  const invalid = count((r) => r === 'invalid_budget');
  if (invalid) return invalidChange(`${invalid} of the requested budgets are not valid amounts. Nothing was proposed.`, 'invalid_budget_amount', 'changes');
  const unreadable = count((r) => r.startsWith('budget_unreadable'));
  if (unreadable) return new OpenwopError('conflict', `The current budget of ${unreadable} campaign(s) could not be read, so no change can be proposed for them. Nothing was proposed.`, 409, { reason: 'budget_unreadable' });
  const capped = count((r) => r.startsWith('cap_'));
  if (capped) return new OpenwopError('conflict', `A spend cap does not allow ${capped} of the requested increases. Nothing was proposed.`, 409, { reason: 'budget_change_cap_blocked' });
  return invalidChange('The requested budgets already match the live ones; there is nothing to propose.', 'budget_change_no_change', 'changes');
}

export async function mcpProposeBudgetChange(
  scope: BundleScope,
  args: { clientId: string; changes?: unknown; campaignId?: string; note?: unknown },
): Promise<Record<string, unknown>> {
  // Fails EMPTY without a person: live budgets are read on the acting person's
  // ad connections, exactly as the propose route requires a signed-in caller.
  if (!scope.actingUserId) {
    throw new OpenwopError('forbidden_scope', 'A budget change needs a person behind the run.', 403, { reason: 'no_acting_user' });
  }
  // The route's access predicate: workspace:write on the CLIENT (`bindRunToClient`
  // → assertRunOrgScope), not-found first, then `externalAgents === 'request'`.
  const person = await bindExternal(scope, args.clientId, 'request');
  if (await featureAccessRefusal('campaign-intel', scope.tenantId, tenantToggleSubject(scope))) {
    throw new OpenwopError('forbidden_scope', 'Budget changes are unavailable because Campaign Intelligence is off for this workspace.', 403, { reason: 'source_feature_unavailable', feature: 'campaign-intel' });
  }
  const campaignId = args.campaignId ? (await campaignOf(scope.tenantId, args.clientId, args.campaignId)).id : undefined;
  const changes = parseBudgetChanges(args.changes);
  if (args.note !== undefined && args.note !== null && (typeof args.note !== 'string' || args.note.length > MCP_BUDGET_NOTE_MAX)) {
    throw invalidChange(`\`note\` must be text of at most ${MCP_BUDGET_NOTE_MAX} characters.`, 'invalid_budget_change', 'note');
  }
  const note = typeof args.note === 'string' ? neutralizeUntrusted(args.note) : '';
  // ADR 0962 D5 — the note is data from outside the app. It reaches the approval
  // text (which people AND assistants read) only inside the untrusted fence.
  const externalNote = note ? fenceUntrustedBlock(note, 'an outside agent (MCP)') : undefined;

  const storage = hostExtStorage();
  const { makeAdsAdapter } = await import('../../host/adsAdapter.js');
  const { proposeReallocation, reallocationApprovers } = await import('../campaign-intel/reallocation.js');
  const runId = scope.runId ?? `hostext:mcp-budget:${args.clientId}`;
  const adapter = makeAdsAdapter({ storage, tenantId: scope.tenantId, runId, actingUserId: person, orgId: args.clientId });

  const out = await proposeReallocation(adapter, scope.tenantId, args.clientId, {
    ...(changes ? { ops: changes } : {}),
    ...(campaignId ? { campaignId } : {}),
    runId, actor: person,
    allOrNothing: changes !== undefined,
    requestedVia: { protocol: 'mcp', ...(scope.runId ? { runId: scope.runId } : {}) },
    ...(externalNote ? { externalNote } : {}),
    // The ONE binding every proposing lane uses (ADR 1022 CP71WF-23). The MCP run
    // is the approval's source, so its MCP-origin floor closes the sole-admin escape.
    bindApproval: reallocationApprovers({
      tenantId: scope.tenantId, orgId: args.clientId, requester: person,
      ...(scope.runId ? { policyRunId: scope.runId, sourceRunId: scope.runId } : {}),
    }),
  });
  if (out.outcome === 'no_change') throw budgetRefusal(out.dropped);
  const plan = out.plan;
  return {
    clientId: args.clientId, planId: plan.planId, approvalId: plan.approvalId ?? null, status: 'awaiting-input',
    // Ids and amounts only (D5): no campaign names, account details or other clients.
    changes: plan.ops.map((o) => ({ platform: o.platform, platformCampaignId: o.campaignId, fromDailyMinor: o.fromDailyMinor, toDailyMinor: o.toDailyMinor })),
    leftOut: plan.dropped.map((d) => ({ platform: d.platform, platformCampaignId: d.campaignId, reason: d.reason })),
    expiresAt: plan.expiresAt,
    next: 'The plan waits for an approver at the client to approve it in the Inbox and then apply it in the app. No budget changes until then, and you cannot approve it.',
    inbox: '/inbox',
  };
}
