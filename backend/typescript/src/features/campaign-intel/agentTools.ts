/**
 * Campaign Intelligence Analyst chat tools (CFP-1 repair; ADR 0308 D2 seam) —
 * the analyst's REAL grounding over the performance store.
 *
 * Born of the CHAT-FIRST-PORT-AUDIT #1 finding (docs/chat-first-port/
 * e4-campaign-connectors-intel.md, C14 THEATER): the pack allowlisted three
 * node typeIds — `openwop:feature.campaign-intel.nodes.{budget-optimize,
 * forecast,plan-budget}` — that NO host registrant provides, so
 * `compileAgentTools` silently dropped them and the Analyst ran in the ONE chat
 * with zero tools, answering budget/forecast questions from hallucinated
 * numbers. These intel nodes are SURFACE-backed (they hard-require
 * `ctx.features['campaign-intel']`), not pure compute, so the node-projection
 * lane (`PROJECTABLE_COMPUTE_NODE_TYPE_IDS`) is the wrong lane by construction
 * (BLOCKER 1). This bridges the intel SURFACE into chat via the sanctioned
 * per-feature `registerFeatureAgentTool` seam instead — the same path
 * `goals`/`app-builder`/`kicktodo` use.
 *
 * Authority parity: each tool shares the routes' `orgScopeGranted`
 * predicate (routes.ts) — the SAME `resolveEffectiveAccess` check, so route and
 * tool can never drift. Read tools FAIL EMPTY without an acting user (the goals
 * / kicktodo precedent — a scheduled/system turn with no human principal must
 * not enumerate a workspace's spend). Invalid MODEL input (missing orgId,
 * non-positive goal numbers) is a TYPED error the agent loop repairs from
 * (never success-with-empty). Toggle honesty lives inside each `run` (per-tenant
 * dynamic; disabled ⇒ typed `feature_disabled`). Read-only — the money math is
 * deterministic and never LLM-made; no durable rows, no egress, no new wire.
 *
 * @see docs/chat-first-port/e4-campaign-connectors-intel.md
 * @see docs/adr/0160-campaign-studio-intelligence.md
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveFeatureToggle } from '../../host/agentToolKit.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { listRecords } from '../campaign-connectors/performanceService.js';
import { optimizeBudget, forecastCampaigns } from './intelligence.js';
import { planBudget } from './budgetPlanner.js';
import { buildPacing } from './pacing.js';
import { buildAttribution } from './attribution.js';
import { orgScopeGranted } from './routes.js';

export const CAMPAIGN_INTEL_BUDGET_OPTIMIZE_TOOL_ID = 'openwop:campaign-intel.budget-optimize';
export const CAMPAIGN_INTEL_FORECAST_TOOL_ID = 'openwop:campaign-intel.forecast';
export const CAMPAIGN_INTEL_PLAN_BUDGET_TOOL_ID = 'openwop:campaign-intel.plan-budget';
export const CAMPAIGN_INTEL_PACING_TOOL_ID = 'openwop:campaign-intel.pacing';
export const CAMPAIGN_INTEL_ATTRIBUTION_TOOL_ID = 'openwop:campaign-intel.attribution';

type ToolResult = { content: string; isError?: boolean };

/** Structured tool error — the agent loop surfaces `content` verbatim to the
 *  model, so the message must be actionable (what failed, what to do next). */
function toolError(error: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return { content: JSON.stringify({ error, message, ...(extra ?? {}) }), isError: true };
}

/** Per-call toggle honesty (ADR 0308 D2): per-tenant, dynamic, fail-closed. */
async function campaignIntelEnabled(scope: BundleScope): Promise<boolean> {
  return resolveFeatureToggle('campaign-intel', scope);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * The shared read gate every analyst tool runs first. Returns the narrowed
 * `{ orgId, actingUserId }` on success, or an EMPTY-read / typed-error
 * `ToolResult` the caller returns verbatim:
 *  - toggle off ⇒ typed `feature_disabled`;
 *  - no acting user ⇒ FAIL EMPTY (the caller's `emptyResult`, never isError);
 *  - missing `orgId` ⇒ typed `org_required` (invalid model input);
 *  - not authorized ⇒ typed `forbidden_scope` (via the routes' predicate).
 */
async function readGate(
  scope: BundleScope,
  orgIdInput: unknown,
  emptyResult: ToolResult,
): Promise<{ orgId: string; actingUserId: string } | ToolResult> {
  if (!(await campaignIntelEnabled(scope))) {
    return toolError('feature_disabled', 'Campaign Intelligence is not enabled for this workspace — tell the user you cannot analyze campaigns here.');
  }
  const actingUserId = scope.actingUserId;
  if (!actingUserId) return emptyResult; // FAIL EMPTY — no human principal.
  const orgId = str(orgIdInput);
  if (!orgId) return toolError('org_required', 'Pass the `orgId` of the workspace whose campaigns to analyze.');
  if (!(await orgScopeGranted(scope.tenantId, actingUserId, orgId, 'workspace:read'))) {
    return toolError('forbidden_scope', 'The user does not have read access to that organization.', { requiredScope: 'workspace:read', orgId });
  }
  return { orgId, actingUserId };
}

const isResult = (v: { orgId: string } | ToolResult): v is ToolResult => 'content' in v;

/** Positive-finite goal coercion, mirroring the `/plan-budget` route guard —
 *  NaN/zero/negative goals must never reach the money math. Returns the floored
 *  int or a typed error for the agent loop to repair from. */
function positiveInt(v: unknown, field: string): number | ToolResult {
  const x = Number(v);
  if (!Number.isFinite(x) || x <= 0) return toolError('validation_error', `\`${field}\` MUST be a positive number.`, { field });
  return Math.floor(x);
}

export function registerCampaignIntelAgentTools(): void {
  // ── Budget reallocation (read): rank platforms by ROAS, recommend a shift. ──
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CAMPAIGN_INTEL_BUDGET_OPTIMIZE_TOOL_ID,
      description:
        'Recommend budget REALLOCATIONS across ad platforms from the workspace\'s ACTUAL performance store — shift spend '
        + 'toward higher-ROAS platforms, with the projected gain. Use it before answering "how should I allocate my budget?"; '
        + 'never invent ROAS/spend numbers. Returns { totalSpend, reallocations[], projectedRoasGain, note }. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'The organization whose campaigns to analyze.' },
          campaignId: { type: 'string', description: 'Optional — scope to a single campaign.' },
        },
        required: ['orgId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const gate = await readGate(scope, input.orgId, { content: JSON.stringify({ totalSpend: 0, reallocations: [], projectedRoasGain: 0, note: 'No acting user — nothing to analyze.' }) });
      if (isResult(gate)) return gate;
      const records = await listRecords(scope.tenantId, gate.orgId, str(input.campaignId));
      return { content: JSON.stringify(optimizeBudget(records)) };
    },
  });

  // ── Forecast + creative-fatigue (read). ─────────────────────────────────────
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CAMPAIGN_INTEL_FORECAST_TOOL_ID,
      description:
        'Per-campaign creative-fatigue detection (declining CTR across the run) + a linear outcome projection (spend + '
        + 'conversions to period end), computed over the ACTUAL performance store. Use it to flag fatiguing campaigns and '
        + 'answer "what will this period end at?". Returns { forecasts[] }. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'The organization whose campaigns to forecast.' },
          campaignId: { type: 'string', description: 'Optional — scope to a single campaign.' },
        },
        required: ['orgId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const gate = await readGate(scope, input.orgId, { content: JSON.stringify({ forecasts: [] }) });
      if (isResult(gate)) return gate;
      const records = await listRecords(scope.tenantId, gate.orgId, str(input.campaignId));
      return { content: JSON.stringify({ forecasts: forecastCampaigns(records) }) };
    },
  });

  // ── Goal-based budget planner ("$X → N conversions", deterministic). ────────
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CAMPAIGN_INTEL_PLAN_BUDGET_TOOL_ID,
      description:
        'Plan a budget to a GOAL: given a total budget and a target number of conversions, compute a deterministic, '
        + 'efficiency-weighted per-platform allocation with a feasibility verdict, pacing, and a confidence band, over the '
        + 'ACTUAL performance store. Money math is deterministic (never invented). All amounts use the planner\'s fixed-point '
        + 'convention: hundredths of a major unit (cents for USD) regardless of currency — NOT ISO minor units. '
        + 'Returns { plan }. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'The organization whose history informs the plan.' },
          totalBudgetMinor: { type: 'integer', minimum: 1, description: 'Total budget to allocate, in minor units (cents).' },
          targetConversions: { type: 'integer', minimum: 1, description: 'The conversion goal for the horizon.' },
          horizonDays: { type: 'integer', minimum: 1, description: 'Planning horizon in days (default 90).' },
          platforms: { type: 'array', items: { type: 'string' }, description: 'Optional — restrict the plan to these platforms.' },
        },
        required: ['orgId', 'totalBudgetMinor', 'targetConversions'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const gate = await readGate(scope, input.orgId, { content: JSON.stringify({ plan: null }) });
      if (isResult(gate)) return gate;
      const totalBudgetMinor = positiveInt(input.totalBudgetMinor, 'totalBudgetMinor');
      if (typeof totalBudgetMinor !== 'number') return totalBudgetMinor;
      const targetConversions = positiveInt(input.targetConversions, 'targetConversions');
      if (typeof targetConversions !== 'number') return targetConversions;
      const horizonDays = positiveInt(input.horizonDays ?? 90, 'horizonDays');
      if (typeof horizonDays !== 'number') return horizonDays;
      const records = await listRecords(scope.tenantId, gate.orgId);
      const plan = planBudget(records, {
        totalBudgetMinor,
        targetConversions,
        horizonDays,
        ...(Array.isArray(input.platforms) ? { platforms: input.platforms.filter((x): x is string => typeof x === 'string') } : {}),
      });
      return { content: JSON.stringify({ plan }) };
    },
  });

  // ── R2 CI-SP-10 — pacing + attribution reads. The page deep-links "Ask the
  // Analyst" from EXACTLY these sections, but the Analyst had no tool that
  // could read either: "which campaigns are over budget?" got ungrounded
  // numbers (the CFP-1 hallucination shape, one lane over). Same readGate,
  // same fail-empty posture as the three tools above. ───────────────────────
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CAMPAIGN_INTEL_PACING_TOOL_ID,
      description:
        'Read the budget-pacing report: per-campaign spend vs its planned budget with a band (ok | warning | over), spent '
        + 'percentage, and projected monthly spend, from the ACTUAL performance store. Use it before answering "which '
        + 'campaigns are over/near budget?" — never invent pacing numbers. Returns { rows[], unplanned, computedAt }. Read-only.',
      inputSchema: {
        type: 'object',
        properties: { orgId: { type: 'string', description: 'The organization whose campaigns to check.' } },
        required: ['orgId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const gate = await readGate(scope, input.orgId, { content: JSON.stringify({ rows: [], unplanned: 0, note: 'No acting user — nothing to read.' }) });
      if (isResult(gate)) return gate;
      return { content: JSON.stringify(await buildPacing(scope.tenantId, gate.orgId)) };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CAMPAIGN_INTEL_ATTRIBUTION_TOOL_ID,
      description:
        'Read the attribution report: per-campaign spend, platform vs web conversions (side by side, never summed), '
        + 'attributed CPA, and revenue, with per-row currency, from the ACTUAL performance + conversion stores. Use it '
        + 'before answering "what did campaign X actually convert?". Returns the attribution report. Read-only.',
      inputSchema: {
        type: 'object',
        properties: { orgId: { type: 'string', description: 'The organization to report on.' } },
        required: ['orgId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const gate = await readGate(scope, input.orgId, { content: JSON.stringify({ rows: [], email: [], unattributedConversions: 0, note: 'No acting user — nothing to read.' }) });
      if (isResult(gate)) return gate;
      return { content: JSON.stringify(await buildAttribution(scope.tenantId, gate.orgId)) };
    },
  });
}
