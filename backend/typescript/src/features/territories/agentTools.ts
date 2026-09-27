/**
 * Territory Planner chat tools (CFP-1 repair — CHAT-FIRST-PORT-AUDIT finding #1;
 * D9 field-sales port map row 1 "RIDES").
 *
 * The `feature.territories.agents` Territory Planner used to allowlist raw node
 * typeIds (`openwop:feature.territories.nodes.list-models`, …) that NO host
 * registrant projects into a conversational tool — so `resolveAgentTools`
 * silently dropped every one and the persona loaded toothless. These register the
 * READ surface the advisory agent actually needs, over the SAME entity accessors
 * the HTTP routes call, behind the SAME predicate (toggle `territories` ON + the
 * caller's RFC 0049 `workspace:read` in the named org — `resolveEffectiveAccess`,
 * the primitive `requireOrgScope` uses).
 *
 * Advisory-read posture (D9): these are read-only projections — the agent answers
 * coverage/quota/re-org questions and PROPOSES; a human disposes through the
 * governed admin routes. There is deliberately NO activate/set-quota tool here
 * (those stay human-gated — the port map's Phases 3-4, not this repair).
 *
 * Vuln posture (the kicktodo-core precedent): a read FAILS EMPTY without an
 * acting user — a scheduled/system turn with no human principal must never
 * enumerate an org's territory model. An unknown/unauthorized org is likewise a
 * fail-closed empty read (no existence leak). A disabled feature is a typed
 * `feature_disabled` (capability honesty, the app-builder precedent).
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveFeatureToggle } from '../../host/agentToolKit.js';
import { listOrgs, resolveEffectiveAccess } from '../../host/accessControlService.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { listModels, listTerritories, getActiveModelId } from './entities/territories.js';
import { listRules, previewModel } from './entities/assignment.js';
import { listQuotas, computeAttainment } from './entities/quota.js';

export const TERRITORIES_LIST_MODELS_TOOL_ID = 'openwop:territories.list-models';
export const TERRITORIES_ACTIVE_MODEL_TOOL_ID = 'openwop:territories.active-model';
export const TERRITORIES_LIST_TERRITORIES_TOOL_ID = 'openwop:territories.list-territories';
export const TERRITORIES_LIST_RULES_TOOL_ID = 'openwop:territories.list-rules';
export const TERRITORIES_LIST_QUOTAS_TOOL_ID = 'openwop:territories.list-quotas';
export const TERRITORIES_PREVIEW_TOOL_ID = 'openwop:territories.preview';
export const TERRITORIES_ATTAINMENT_TOOL_ID = 'openwop:territories.attainment';

type ToolResult = { content: string; isError?: boolean };

/** Structured tool error — the agent loop surfaces `content` verbatim, so the
 *  message must say what failed and what to do next. */
function toolError(error: string, message: string): ToolResult {
  return { content: JSON.stringify({ error, message }), isError: true };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Per-call toggle honesty (the app-builder precedent): per-tenant, dynamic,
 *  fail-closed. */
async function territoriesEnabled(scope: BundleScope): Promise<boolean> {
  return resolveFeatureToggle('territories', scope);
}

type ReadScope =
  | { kind: 'ok'; orgId: string; viewer: string }
  | { kind: 'empty' } // no acting user, or unknown/unauthorized org → fail-closed empty read
  | { kind: 'error'; result: ToolResult }; // feature disabled, or org ambiguous

/**
 * The SAME access decision the read routes make (`authorizeOrgScope` → toggle +
 * `requireOrgScope`'s `resolveEffectiveAccess` `workspace:read` in the org), for a
 * chat-tool scope: fail EMPTY without an acting user; typed `feature_disabled`
 * when off; typed `org_required` when the workspace has several orgs and none was
 * named; fail-closed EMPTY for an unknown org or a caller lacking read scope.
 */
async function resolveTerritoryRead(scope: BundleScope, orgIdInput?: string): Promise<ReadScope> {
  const viewer = scope.actingUserId;
  if (!viewer) return { kind: 'empty' };
  if (!(await territoriesEnabled(scope))) {
    return { kind: 'error', result: toolError('feature_disabled', 'The Sales Territories feature is not enabled for this workspace — tell the user you cannot answer territory questions here.') };
  }
  const orgs = await listOrgs(scope.tenantId);
  const orgId = orgIdInput ?? (orgs.length === 1 ? orgs[0]!.orgId : undefined);
  if (!orgId) return { kind: 'error', result: toolError('org_required', `This workspace has ${orgs.length} organizations — pass \`orgId\` (ask the user which).`) };
  if (!orgs.some((o) => o.orgId === orgId)) return { kind: 'empty' };
  const access = await resolveEffectiveAccess(scope.tenantId, { subject: viewer, orgId });
  if (!access.scopes.includes('workspace:read')) return { kind: 'empty' };
  return { kind: 'ok', orgId, viewer };
}

/** A required-string model id — invalid model input is a TYPED error, never a
 *  success-with-empty (CFP-1 hard rule #2). */
function requireModelId(input: Record<string, unknown>): string | ToolResult {
  const modelId = str(input.modelId);
  if (!modelId) return toolError('validation_error', 'Pass the `modelId` to read (get it from list-models).');
  return modelId;
}

export function registerTerritoryAgentTools(): void {
  const orgProp = { orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' } };

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: TERRITORIES_LIST_MODELS_TOOL_ID,
      description: "List the org's territory models (planning/active/archived) with the currently-active model id. Read-only. Start here to ground any territory question.",
      inputSchema: { type: 'object', properties: { ...orgProp }, additionalProperties: false },
    },
    async run(input, scope) {
      const r = await resolveTerritoryRead(scope, str(input.orgId));
      if (r.kind === 'empty') return { content: JSON.stringify({ models: [], activeModelId: null }) };
      if (r.kind === 'error') return r.result;
      return { content: JSON.stringify({ models: await listModels(scope.tenantId, r.orgId), activeModelId: await getActiveModelId(scope.tenantId, r.orgId) }) };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: TERRITORIES_ACTIVE_MODEL_TOOL_ID,
      description: "The org's currently-active territory model id (the model driving CRM record visibility and quota rollup), or null if none is active. Read-only.",
      inputSchema: { type: 'object', properties: { ...orgProp }, additionalProperties: false },
    },
    async run(input, scope) {
      const r = await resolveTerritoryRead(scope, str(input.orgId));
      if (r.kind === 'empty') return { content: JSON.stringify({ activeModelId: null }) };
      if (r.kind === 'error') return r.result;
      return { content: JSON.stringify({ activeModelId: await getActiveModelId(scope.tenantId, r.orgId) }) };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: TERRITORIES_LIST_TERRITORIES_TOOL_ID,
      description: "The territory hierarchy (regions/divisions/territories) for one model. Read-only. Pass the `modelId` from list-models.",
      inputSchema: { type: 'object', properties: { ...orgProp, modelId: { type: 'string', description: 'The territory model to read.' } }, required: ['modelId'], additionalProperties: false },
    },
    async run(input, scope) {
      const r = await resolveTerritoryRead(scope, str(input.orgId));
      if (r.kind === 'empty') return { content: JSON.stringify({ territories: [] }) };
      if (r.kind === 'error') return r.result;
      const modelId = requireModelId(input);
      if (typeof modelId !== 'string') return modelId;
      return { content: JSON.stringify({ territories: await listTerritories(scope.tenantId, r.orgId, modelId) }) };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: TERRITORIES_LIST_RULES_TOOL_ID,
      description: "The filter-based auto-assignment rules for one territory model. Read-only. Pass the `modelId` from list-models.",
      inputSchema: { type: 'object', properties: { ...orgProp, modelId: { type: 'string', description: 'The territory model to read.' } }, required: ['modelId'], additionalProperties: false },
    },
    async run(input, scope) {
      const r = await resolveTerritoryRead(scope, str(input.orgId));
      if (r.kind === 'empty') return { content: JSON.stringify({ rules: [] }) };
      if (r.kind === 'error') return r.result;
      const modelId = requireModelId(input);
      if (typeof modelId !== 'string') return modelId;
      return { content: JSON.stringify({ rules: await listRules(scope.tenantId, r.orgId, modelId) }) };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: TERRITORIES_LIST_QUOTAS_TOOL_ID,
      description: "Per-territory quotas for one model, optionally for a single period (YYYY-Qn or YYYY-MM). Read-only. Pass the `modelId` from list-models.",
      inputSchema: { type: 'object', properties: { ...orgProp, modelId: { type: 'string', description: 'The territory model to read.' }, period: { type: 'string', description: 'Optional period filter (YYYY-Qn or YYYY-MM).' } }, required: ['modelId'], additionalProperties: false },
    },
    async run(input, scope) {
      const r = await resolveTerritoryRead(scope, str(input.orgId));
      if (r.kind === 'empty') return { content: JSON.stringify({ quotas: [] }) };
      if (r.kind === 'error') return r.result;
      const modelId = requireModelId(input);
      if (typeof modelId !== 'string') return modelId;
      return { content: JSON.stringify({ quotas: await listQuotas(scope.tenantId, r.orgId, modelId, str(input.period)) }) };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: TERRITORIES_PREVIEW_TOOL_ID,
      description: "Dry-run a model's assignment rules: what would this model assign, with no writes. Use to evaluate a re-org scenario before proposing it. Read-only. Pass the `modelId` from list-models.",
      inputSchema: { type: 'object', properties: { ...orgProp, modelId: { type: 'string', description: 'The territory model to preview.' } }, required: ['modelId'], additionalProperties: false },
    },
    async run(input, scope) {
      const r = await resolveTerritoryRead(scope, str(input.orgId));
      if (r.kind === 'empty') return { content: JSON.stringify({ summary: null }) };
      if (r.kind === 'error') return r.result;
      const modelId = requireModelId(input);
      if (typeof modelId !== 'string') return modelId;
      return { content: JSON.stringify({ summary: await previewModel(scope.tenantId, r.orgId, modelId) }) };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: TERRITORIES_ATTAINMENT_TOOL_ID,
      // R2 TER2-B1 — the model reads these rows as facts, so the description must
      // carry the same caveat the console does. `attainment`/`coverage` are NULL
      // whenever the ratio cannot be stated honestly, and `ratioUnavailable` says
      // which case it is; there is no FX in this app, so a null is never a licence
      // to convert or to estimate one.
      description: "Quota attainment for one model — weighted pipeline + won against quota per territory, scoped to the acting user's territories. Read-only. Pass the `modelId` from list-models. `attainment` and `coverage` are null when the ratio cannot be stated (see `ratioUnavailable`: no-quota, mixed-deal-currencies, mixed-quota-currencies, quota-currency-mismatch) — report that reason, never convert currencies or estimate a percentage. Money sums carry `valueCurrency` only when every contributing deal agreed; `currency` is the QUOTA's currency and does not denominate them.",
      inputSchema: { type: 'object', properties: { ...orgProp, modelId: { type: 'string', description: 'The territory model to report on.' }, period: { type: 'string', description: 'Optional period (YYYY-Qn or YYYY-MM); defaults to the current period.' } }, required: ['modelId'], additionalProperties: false },
    },
    async run(input, scope) {
      const r = await resolveTerritoryRead(scope, str(input.orgId));
      if (r.kind === 'empty') return { content: JSON.stringify({ period: null, territories: [], unassigned: { weightedPipeline: 0, won: 0 } }) };
      if (r.kind === 'error') return r.result;
      const modelId = requireModelId(input);
      if (typeof modelId !== 'string') return modelId;
      // Viewer-scoped (A2) — attainment is computed against the acting user's territories.
      return { content: JSON.stringify(await computeAttainment(scope.tenantId, r.orgId, modelId, str(input.period), r.viewer)) };
    },
  });
}
