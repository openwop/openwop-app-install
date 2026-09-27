/**
 * Production Planner chat tools (ADR 0172 / ADR 0308 seam; CFP-1 remediation).
 *
 * The pre-remediation Production Planner pack allowlisted two node typeIds
 * (`feature.production.nodes.{context-build,plan-generate}`) that NO host
 * registrant projected as a conversational tool, so `resolveAgentTools` dropped
 * them and the agent was offered ZERO tools — "Plan with AI" produced only a
 * prose hallucination. These two `registerFeatureAgentTool` registrations make
 * the exchange real:
 *
 *  - `openwop:production.get-vendors` — a READ tool: the Vendor Directory through
 *    the SAME `listVendors` service the routes use, WITH the `vendorRedaction`
 *    field-redaction the routes/surface/KB apply (`priceRanges` visible only to a
 *    caller holding `host:members:manage`), projecting the internal columns out.
 *    Shares the routes' authority: `workspace:read` in the path org. Fails EMPTY
 *    (`{ vendors: [] }`) without an acting user / scope / an enabled toggle (the
 *    ADR 0308 read-tool rule — a scheduled/system turn never enumerates vendors).
 *
 *  - `openwop:production.plan` — an ACTION tool: because plan generation is an AI
 *    call + a durable write + an artifact emission (NOT a pure compute node), it
 *    IGNITES a run of the single-node `openwop-app.production.plan` workflow (the
 *    real `plan-generate` node) rather than fabricating a plan in the turn — so
 *    the plan is generated inside a run (recorded, replay/fork-safe, artifact
 *    emitted, persisted with the deterministic `pln:run:<runId>` key). Shares the
 *    routes' authority: `workspace:write` in the path org; fails TYPED without an
 *    acting user / scope / an enabled toggle.
 *
 * Authority parity (the CFP-1 hard rule): both tools resolve the caller's org
 * scope through the SAME `resolveEffectiveAccess` primitive + the SAME
 * `workspace:read`/`workspace:write` scope tokens that `requireOrgScope` (the
 * routes' `authorizeOrgScope` core) enforces, plus the SAME `getOrg`
 * tenant-in-org IDOR guard; pricing visibility rides the SHARED
 * `canSeeVendorPricing`/`redactVendorPricing` helper the routes call. A route and
 * a tool cannot drift on who may read a vendor or drive a plan.
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { getOrg, listOrgs, resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { startWorkflowRun, type StartRunDeps } from '../../host/runStarter.js';
import { claimIgnition, recordIgnitionRun, releaseIgnition, ignitionKey } from '../../host/ignitionGuard.js';
import { makeTurn } from '../../host/conversation.js';
import { persistExchangedPair } from '../../host/exchange/persistExchange.js';
import { loadTurns } from '../../host/exchange/loadTurns.js';
import { getConversationMeta } from '../../host/conversationStore.js';
import { createLogger } from '../../observability/logger.js';
import { listVendors } from './productionService.js';
import { canSeeVendorPricing, redactVendorPricing } from './vendorRedaction.js';
import { PRODUCTION_PLAN_WORKFLOW_ID } from './builtinWorkflows.js';

const log = createLogger('production.agent-tools');

export const PRODUCTION_GET_VENDORS_TOOL_ID = 'openwop:production.get-vendors';
export const PRODUCTION_PLAN_TOOL_ID = 'openwop:production.plan';

/** The Production Planner's FIXED agentId (SSoT: `feature.production.agents`
 *  pack) — used only to attribute the inline `workflow_run` turn. */
const PLANNER_AGENT_ID = 'feature.production.agents.production-planner';

type ToolResult = { content: string; isError?: boolean };

/** Structured tool error — the agent loop surfaces `content` verbatim to the
 *  model, so the message must say what failed and what to do next. */
function toolError(error: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return { content: JSON.stringify({ error, message, ...(extra ?? {}) }), isError: true };
}

/** Per-call toggle honesty (ADR 0308 D2): per-tenant, dynamic, fail-closed. */
async function productionEnabled(tenantId: string, actingUserId: string | undefined): Promise<boolean> {
  const assignment = await resolveOne('production', { tenantId, ...(actingUserId ? { userId: actingUserId } : {}) }).catch(() => null);
  return Boolean(assignment?.enabled);
}

/** Internal columns the surface strips from vendor projections (recorded in the
 *  event log, never model-facing). Parity with `surface.ts`'s `project`. */
const INTERNAL = new Set(['tenantId', 'createdBy', 'updatedBy']);
function projectVendor(v: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) if (!INTERNAL.has(k)) out[k] = val;
  return out;
}

/**
 * Resolve the caller's org scope EXACTLY as the routes' `requireOrgScope` core
 * does — acting user required, org-in-tenant IDOR guard (`getOrg`), and the
 * `resolveEffectiveAccess` scope check — but from a chat tool scope (subject +
 * tenant) instead of a Request. `orgIdInput` is explicit or the workspace's sole
 * org (the app-builder deliverable-tool convention). Returns the resolved
 * `{ orgId, actingUserId }` or a `ToolResult` describing the failure; the caller
 * decides whether a read failure is EMPTY or an action failure is TYPED.
 */
async function resolveOrgScope(
  scope: BundleScope,
  orgIdInput: string | undefined,
  needed: Extract<Scope, 'workspace:read' | 'workspace:write'>,
): Promise<{ orgId: string; actingUserId: string } | { failure: ToolResult }> {
  const actingUserId = scope.actingUserId;
  if (!actingUserId) {
    return { failure: toolError('acting_user_required', 'Production vendors and plans can only be read or driven from a human-initiated turn.') };
  }
  const orgs = await listOrgs(scope.tenantId);
  const orgId = orgIdInput ?? (orgs.length === 1 ? orgs[0]!.orgId : undefined);
  if (!orgId) {
    return { failure: toolError('org_required', `This workspace has ${orgs.length} organizations — pass \`orgId\` (ask the user which).`) };
  }
  // Org-in-tenant IDOR guard (the `requireOrgScope` 404 posture).
  const org = await getOrg(orgId);
  if (!org || org.tenantId !== scope.tenantId) {
    return { failure: toolError('not_found', 'Organization not found in this workspace.') };
  }
  const access = await resolveEffectiveAccess(scope.tenantId, { subject: actingUserId, orgId });
  if (!access.scopes.includes(needed)) {
    return { failure: toolError('forbidden_scope', `The user does not have ${needed === 'workspace:write' ? 'write' : 'read'} access to that organization.`) };
  }
  return { orgId, actingUserId };
}

/**
 * Append a server-side `workflow_run` conversation turn so the chat renders the
 * dispatched plan run inline (a tool-dispatched run does NOT auto-render — the
 * `conversationExchange` run-mention precedent). Best-effort: the run has already
 * started, so a persistence miss must never fail the tool. Modeled on the
 * KickTodo tool helper (`kicktodo-creator/agentTools.ts`).
 */
async function appendWorkflowRunTurn(
  storage: StartRunDeps['storage'],
  tenantId: string,
  conversationId: string,
  runId: string,
  agentId: string,
): Promise<void> {
  try {
    const meta = await getConversationMeta(tenantId, conversationId);
    const backingRunId = meta?.conversationRunId;
    if (!backingRunId) return; // no materialized conversation run yet — nothing to append to
    const turns = await loadTurns(storage, backingRunId, conversationId);
    const nextIndex = turns.reduce((max, t) => Math.max(max, t.turnIndex), -1) + 1;
    const turn = makeTurn({
      conversationId,
      turnIndex: nextIndex,
      role: 'agent',
      from: agentId,
      content: { kind: 'workflow_run', runId, agentId },
      ts: Date.now(),
      groupId: conversationId,
      agent: { agentId },
      speakerId: agentId,
    });
    await persistExchangedPair({ runId: backingRunId, nodeId: 'production-plan-run', conversationId, entries: [[nextIndex, turn]] });
  } catch (err) {
    log.warn('plan_run_turn_persist_failed', { conversationId, runId, error: err instanceof Error ? err.message : String(err) });
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * READ — the Vendor Directory for the planner to GROUND on before recommending a
 * route. Fails EMPTY (`{ vendors: [] }`) on any authority/toggle miss (the read
 * tool contract). Exported for direct authz testing.
 */
async function runGetVendorsTool(input: Record<string, unknown>, scope: BundleScope): Promise<ToolResult> {
  const empty: ToolResult = { content: JSON.stringify({ vendors: [] }) };
  if (!(await productionEnabled(scope.tenantId, scope.actingUserId))) return empty;
  const resolved = await resolveOrgScope(scope, str(input.orgId), 'workspace:read');
  if ('failure' in resolved) return empty; // reads fail EMPTY, never typed
  const { orgId, actingUserId } = resolved;
  const vendors = await listVendors(scope.tenantId, orgId);
  // Pricing redaction parity — the SAME helper the routes/surface/KB apply.
  const showPricing = await canSeeVendorPricing(scope.tenantId, orgId, actingUserId);
  const projected = vendors.map((v) => projectVendor(redactVendorPricing({ ...v } as Record<string, unknown>, showPricing)));
  return { content: JSON.stringify({ orgId, vendors: projected }) };
}

/**
 * ACTION — ignite a run of the single-node production-plan workflow (the real
 * `plan-generate` node). Fails TYPED on any authority/toggle miss (the action
 * tool contract). Persists the inline `workflow_run` turn. `deps` (the
 * run-starter) is closure-bound at registration; exposed as the first argument
 * for direct testing.
 */
async function runPlanTool(deps: StartRunDeps, input: Record<string, unknown>, scope: BundleScope): Promise<ToolResult> {
  if (!(await productionEnabled(scope.tenantId, scope.actingUserId))) {
    return toolError('feature_disabled', 'Production Intelligence is not enabled for this workspace — tell the user you cannot generate a production plan here.');
  }
  const resolved = await resolveOrgScope(scope, str(input.orgId), 'workspace:write');
  if ('failure' in resolved) return resolved.failure;
  const { orgId, actingUserId } = resolved;

  const channels = strArr(input.channels);
  const assets = strArr(input.assets);
  const briefId = str(input.briefId);

  // HIGH-1 ignition dedup — a repeated identical plan call (same org + channels +
  // assets + brief) inside the window reuses the run already started.
  const key = ignitionKey('production.plan', orgId, [...channels].sort().join(','), [...assets].sort().join(','), briefId);
  const claim = await claimIgnition(scope.tenantId, key);
  if (!claim.claimed) {
    return { content: JSON.stringify({ runId: claim.existingRunId ?? null, ignited: false, note: 'an identical run was started moments ago — reusing it' }) };
  }

  const runId = await startWorkflowRun(deps, {
    tenantId: scope.tenantId,
    workflowId: PRODUCTION_PLAN_WORKFLOW_ID,
    inputs: {
      orgId,
      channels,
      assets,
      ...(briefId ? { briefId } : {}),
    },
    metadata: {
      actingUserId,
      ...(scope.conversationId ? { chatSessionId: scope.conversationId } : {}),
      productionPlan: { orgId, agentId: PLANNER_AGENT_ID },
    },
  }).catch((err) => {
    // DATA-4 — a startWorkflowRun THROW must also release the claim; coerce to
    // null so the shared failure handler below runs.
    log.warn('production_plan_dispatch_threw', { tenantId: scope.tenantId, orgId, error: err instanceof Error ? err.message : String(err) });
    return null;
  });
  if (!runId) {
    // CFPT-2 / DATA-4 — the run never started (null OR a throw); release the claim
    // so an honest retry isn't blocked for the dedup window by a latch over a failure.
    await releaseIgnition(scope.tenantId, key);
    return toolError('dispatch_failed', 'The production-plan workflow could not start.');
  }
  await recordIgnitionRun(scope.tenantId, key, runId);
  if (scope.conversationId) {
    await appendWorkflowRunTurn(deps.storage, scope.tenantId, scope.conversationId, runId, PLANNER_AGENT_ID);
  }
  log.info('production_plan_dispatched', { tenantId: scope.tenantId, orgId, runId });
  return {
    content: JSON.stringify({
      runId,
      orgId,
      note: 'Generating the production plan now — it appears as a plan artifact in this chat and in the Plans tab when the run finishes. The plan is advisory: recommend, then let the human approve it. Do not invent the routes; wait for the run.',
    }),
  };
}

/**
 * ADR 0308 D2 registration — process-wide (per-tenant toggle honesty lives in
 * each tool's `run`); the run-starter deps ride the closure since a chat-time
 * tool scope carries no `storage`/`hostSuite`.
 */
export function registerProductionAgentTools(deps: StartRunDeps): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: PRODUCTION_GET_VENDORS_TOOL_ID,
      description:
        'List the org\'s Vendor Directory (external contractors/agencies) with their type, capabilities, quality ratings, '
        + 'region, contract status, and — only if you have members-manage access — price ranges. Use it to GROUND a '
        + 'production plan in the vendors that actually exist before recommending a contractor or agency route. Pass '
        + '`orgId` when the workspace has more than one organization. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' },
        },
        additionalProperties: false,
      },
    },
    run: runGetVendorsTool,
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: PRODUCTION_PLAN_TOOL_ID,
      description:
        'Generate a production plan: a per-asset execution route (internal / contractor / agency / hybrid) with a budget '
        + 'and timeline, ranking the team and vendors by channel fit. This IGNITES a workflow run — the plan is generated, '
        + 'persisted, and rendered as a `production.plan` artifact in this chat (it never publishes or commits budget). '
        + 'Pass the `channels` the campaign uses and, optionally, the `assets` to produce (or a `briefId` to resolve them). '
        + 'The plan is advisory; the human approves it. Returns the started `runId`.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' },
          channels: { type: 'array', items: { type: 'string' }, description: 'The enabled campaign channels (e.g. landing_page, ad_variants, email_sequence).' },
          assets: { type: 'array', items: { type: 'string' }, description: 'Optional explicit asset list to produce; inferred from the channels when omitted.' },
          briefId: { type: 'string', description: 'Optional campaign brief to resolve org + enabled channels from.' },
        },
        additionalProperties: false,
      },
    },
    run: (input, scope) => runPlanTool(deps, input, scope),
  });
}
