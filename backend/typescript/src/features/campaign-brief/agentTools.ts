/**
 * Campaign Brief Strategist chat tools (CFP-1 / CHAT-FIRST-PORT-AUDIT #1; the
 * ADR 0308 seam, the `creative-briefs.list` + kicktodo-creator precedents).
 *
 * Before CFP-1 the Strategist pack allowlisted raw `feature.campaign-brief.nodes.*`
 * typeIds that project into NO conversational tool, so the agent resolved zero
 * tools and fell back to a bare narrating completion — and the flagship
 * "generate the messaging kernel" plus the whole market-intel pipeline had NO
 * igniter anywhere (not a route, not the scheduler, not a chat tool). These tools
 * make the persona ACT:
 *   - READS (fail EMPTY without an acting user): `get-brief`, `validate`.
 *   - ACTIONS (fail TYPED): `research.run` → `startWorkflowRun(MARKET_INTEL)`,
 *     `generate-kernel` → `startWorkflowRun(KERNEL)`. Both emit the authoritative
 *     `workflow_run` conversation turn so the dispatched run renders inline; the
 *     workflow's `core.approvalGate` renders in the PARENT run (gates are invisible
 *     from child runs — keep them top-level).
 *
 * Authority parity (hard rule #1): every tool shares the campaign-brief ROUTES'
 * predicate — `orgScopeGranted(... scope)` in the brief's own org (the
 * no-existence-leak `loadBriefScoped` shape: reads need `workspace:read`, the
 * pipeline actions need `workspace:write`). Toggle honesty (campaign-brief is OFF
 * by default) lives in each tool's `run` — a disabled feature has no surface, so
 * every tool fails closed FIRST with the SAME subject shape as the route gate.
 *
 * The run-starter `deps` ride the registration closure (the kicktodo-creator
 * pattern) since a chat-time tool scope carries no `storage`/`hostSuite`.
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { startWorkflowRun, type StartRunDeps } from '../../host/runStarter.js';
import { claimIgnition, recordIgnitionRun, releaseIgnition, ignitionKey } from '../../host/ignitionGuard.js';
import { surfaceDispatchedRun, type TurnRunDispatchSink } from '../../host/turnRunDispatch.js';
import { createLogger } from '../../observability/logger.js';
import { orgScopeGranted } from './routes.js';
import { getBrief, validateBrief } from './briefService.js';
import { isTargetingPlatform, TARGETING_PLATFORMS } from './targetingService.js';
import { MARKET_INTEL_WORKFLOW_ID, KERNEL_WORKFLOW_ID } from './intelWorkflows.js';

const log = createLogger('campaign-brief.agent-tools');

const TOGGLE_ID = 'campaign-brief';
const STRATEGIST_AGENT_ID = 'feature.campaign-brief.agents.brief-strategist';

export const CAMPAIGN_BRIEF_GET_TOOL_ID = 'openwop:campaign-brief.get-brief';
export const CAMPAIGN_BRIEF_VALIDATE_TOOL_ID = 'openwop:campaign-brief.validate';
export const CAMPAIGN_BRIEF_RESEARCH_RUN_TOOL_ID = 'openwop:campaign-brief.research.run';
export const CAMPAIGN_BRIEF_GENERATE_KERNEL_TOOL_ID = 'openwop:campaign-brief.generate-kernel';

/** The scope every conversational tool call carries (the ADR 0324 composer). */
export interface ToolScope {
  tenantId: string;
  actingUserId?: string | undefined;
  agentProfileId?: string | undefined;
  conversationId?: string | undefined;
  runId?: string | undefined;
  /** Present on the conversation transport — see `host/turnRunDispatch.ts`. */
  onRunDispatched?: TurnRunDispatchSink | undefined;
}

type ToolResult = { content: string; isError?: boolean };

function toolError(error: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return { content: JSON.stringify({ error, message, ...extra }), isError: true };
}

/** Per-call toggle honesty (ADR 0308 D2) — fail-closed FIRST, SAME subject shape
 *  as the route gate so a user-bucketed rollout can't disagree between route and
 *  tool. */
async function featureEnabled(scope: ToolScope): Promise<boolean> {
  const assignment = await resolveOne(TOGGLE_ID, {
    tenantId: scope.tenantId,
    ...(scope.actingUserId ? { userId: scope.actingUserId } : {}),
  }).catch(() => null);
  return Boolean(assignment?.enabled);
}

/**
 * Load a brief and gate the acting user in the brief's org — the `loadBriefScoped`
 * route shape. Returns `{ ok: false, empty }` when the brief is absent OR
 * unreadable (uniform not-found, no existence leak). For actions, `scope` is
 * `workspace:write` — a reader who lacks write gets `forbidden` (not `empty`).
 */
async function loadBriefForTool(
  tenantId: string,
  actingUserId: string,
  briefId: string,
  requiredScope: 'workspace:read' | 'workspace:write',
): Promise<{ ok: true; brief: NonNullable<Awaited<ReturnType<typeof getBrief>>> } | { ok: false; reason: 'not_found' | 'forbidden' }> {
  const brief = await getBrief(tenantId, briefId);
  if (!brief || !(await orgScopeGranted(tenantId, actingUserId, brief.orgId, 'workspace:read'))) {
    return { ok: false, reason: 'not_found' };
  }
  if (requiredScope === 'workspace:write' && !(await orgScopeGranted(tenantId, actingUserId, brief.orgId, 'workspace:write'))) {
    return { ok: false, reason: 'forbidden' };
  }
  return { ok: true, brief };
}

// ── READ: get-brief ──────────────────────────────────────────────────────────
export async function runGetBriefTool(input: Record<string, unknown>, scope: ToolScope): Promise<ToolResult> {
  if (!(await featureEnabled(scope))) {
    return toolError('feature_disabled', 'The Personas & Campaign Brief feature is not enabled for this workspace.');
  }
  const actingUserId = scope.actingUserId;
  if (!actingUserId) {
    return { content: JSON.stringify({ brief: null, note: 'No acting user on this turn — brief access is resolved per signed-in user.' }) };
  }
  const briefId = typeof input.briefId === 'string' ? input.briefId.trim() : '';
  if (!briefId) return toolError('validation_error', '`briefId` is required.');
  const loaded = await loadBriefForTool(scope.tenantId, actingUserId, briefId, 'workspace:read');
  if (!loaded.ok) return { content: JSON.stringify({ brief: null, note: 'Brief not found, or you lack read access to it.' }) };
  const b = loaded.brief;
  return {
    content: JSON.stringify({
      brief: {
        id: b.id,
        orgId: b.orgId,
        name: b.name,
        // R2 CB-SP-10 — the projection omitted the very sections the tool tells
        // the model to ground in ("the ACTUAL brief"): the human-authored value
        // prop, proof points, objective and status were invisible to the
        // strategist iterating on the kernel.
        status: b.status,
        objective: b.objective ?? null,
        productName: b.productName,
        productDescription: b.productDescription ?? null,
        industryVertical: b.industryVertical,
        messaging: b.messaging,
        groundingPolicy: b.groundingPolicy ?? null,
        competitors: b.competitors ?? [],
        budget: b.budget ?? null,
        brandId: b.brandId ?? null,
        kbCollectionId: b.kbCollectionId ?? null,
        personaIds: b.personaIds,
        channels: b.channels,
        kernel: b.kernel ?? null,
      },
      validation: validateBrief(b),
    }),
  };
}

// ── READ: validate ─────────────────────────────────────────────────────────
export async function runValidateTool(input: Record<string, unknown>, scope: ToolScope): Promise<ToolResult> {
  if (!(await featureEnabled(scope))) {
    return toolError('feature_disabled', 'The Personas & Campaign Brief feature is not enabled for this workspace.');
  }
  const actingUserId = scope.actingUserId;
  if (!actingUserId) {
    return { content: JSON.stringify({ valid: false, issues: [], enabledChannels: [], note: 'No acting user on this turn — brief access is resolved per signed-in user.' }) };
  }
  const briefId = typeof input.briefId === 'string' ? input.briefId.trim() : '';
  if (!briefId) return toolError('validation_error', '`briefId` is required.');
  const loaded = await loadBriefForTool(scope.tenantId, actingUserId, briefId, 'workspace:read');
  if (!loaded.ok) return { content: JSON.stringify({ valid: false, issues: [], enabledChannels: [], note: 'Brief not found, or you lack read access to it.' }) };
  return { content: JSON.stringify(validateBrief(loaded.brief)) };
}

/** Shared action preamble: toggle + acting user + write-scope gate on the brief. */
async function guardBriefAction(
  input: Record<string, unknown>,
  scope: ToolScope,
): Promise<{ ok: true; briefId: string; orgId: string } | { ok: false; result: ToolResult }> {
  if (!(await featureEnabled(scope))) {
    return { ok: false, result: toolError('feature_disabled', 'The Personas & Campaign Brief feature is not enabled for this workspace.') };
  }
  if (!scope.actingUserId) {
    return { ok: false, result: toolError('acting_user_required', 'This action can only run from a human-initiated turn.') };
  }
  const briefId = typeof input.briefId === 'string' ? input.briefId.trim() : '';
  if (!briefId) return { ok: false, result: toolError('validation_error', '`briefId` is required.') };
  const loaded = await loadBriefForTool(scope.tenantId, scope.actingUserId, briefId, 'workspace:write');
  if (!loaded.ok) {
    if (loaded.reason === 'forbidden') {
      return { ok: false, result: toolError('forbidden', 'You need workspace:write in this brief\'s organization to run this.') };
    }
    return { ok: false, result: toolError('not_found', `Brief '${briefId}' not found.`) };
  }
  return { ok: true, briefId, orgId: loaded.brief.orgId };
}

// ── ACTION: research.run (ignite the market-intel pipeline) ──────────────────
export async function runResearchRunTool(deps: StartRunDeps, input: Record<string, unknown>, scope: ToolScope): Promise<ToolResult> {
  const guard = await guardBriefAction(input, scope);
  if (!guard.ok) return guard.result;
  const platformInput = typeof input.platform === 'string' ? input.platform.trim() : '';
  const platform = isTargetingPlatform(platformInput) ? platformInput : 'meta';
  // HIGH-1 ignition dedup — a repeated research.run on the same brief inside the
  // window reuses the run already started.
  const key = ignitionKey('campaign-brief.research.run', guard.briefId);
  const claim = await claimIgnition(scope.tenantId, key);
  if (!claim.claimed) {
    return { content: JSON.stringify({ runId: claim.existingRunId ?? null, ignited: false, note: 'an identical run was started moments ago — reusing it' }) };
  }
  const runId = await startWorkflowRun(deps, {
    tenantId: scope.tenantId,
    workflowId: MARKET_INTEL_WORKFLOW_ID,
    inputs: { briefId: guard.briefId, platform },
    metadata: {
      actingUserId: scope.actingUserId,
      ...(scope.conversationId ? { chatSessionId: scope.conversationId } : {}),
      campaignBrief: { briefId: guard.briefId, kind: 'market-intel' },
    },
  }).catch((err) => {
    // DATA-4 — a startWorkflowRun THROW must also release the claim; coerce to
    // null so the shared failure handler below runs.
    log.warn('market_intel_dispatch_threw', { tenantId: scope.tenantId, briefId: guard.briefId, error: err instanceof Error ? err.message : String(err) });
    return null;
  });
  if (!runId) {
    // CFPT-2 / DATA-4 — the run never started (null OR a throw); release the claim
    // so an honest retry isn't blocked for the dedup window by a latch over a failure.
    await releaseIgnition(scope.tenantId, key);
    return toolError('dispatch_failed', 'The market-intel workflow could not start.');
  }
  await recordIgnitionRun(scope.tenantId, key, runId);
  const agentId = scope.agentProfileId ?? STRATEGIST_AGENT_ID;
  await surfaceDispatchedRun(scope, deps.storage, { runId, agentId, workflowId: MARKET_INTEL_WORKFLOW_ID, workflowName: 'Market intel research' }, 'campaign-brief-agent-run');
  log.info('market_intel_dispatched', { tenantId: scope.tenantId, briefId: guard.briefId, platform, runId });
  return { content: JSON.stringify({ runId, briefId: guard.briefId, platform, note: 'Research pipeline started (VOC → angles → targeting → your approval). Curate the results in the brief\'s Intel tab.' }) };
}

// ── ACTION: generate-kernel (ignite the messaging-kernel workflow) ──────────
export async function runGenerateKernelTool(deps: StartRunDeps, input: Record<string, unknown>, scope: ToolScope): Promise<ToolResult> {
  const guard = await guardBriefAction(input, scope);
  if (!guard.ok) return guard.result;
  // HIGH-1 ignition dedup — a repeated generate-kernel on the same brief inside
  // the window reuses the run already started.
  const key = ignitionKey('campaign-brief.generate-kernel', guard.briefId);
  const claim = await claimIgnition(scope.tenantId, key);
  if (!claim.claimed) {
    return { content: JSON.stringify({ runId: claim.existingRunId ?? null, ignited: false, note: 'an identical run was started moments ago — reusing it' }) };
  }
  const runId = await startWorkflowRun(deps, {
    tenantId: scope.tenantId,
    workflowId: KERNEL_WORKFLOW_ID,
    inputs: { briefId: guard.briefId },
    metadata: {
      actingUserId: scope.actingUserId,
      ...(scope.conversationId ? { chatSessionId: scope.conversationId } : {}),
      campaignBrief: { briefId: guard.briefId, kind: 'messaging-kernel' },
    },
  }).catch((err) => {
    // DATA-4 — a startWorkflowRun THROW must also release the claim; coerce to
    // null so the shared failure handler below runs.
    log.warn('kernel_dispatch_threw', { tenantId: scope.tenantId, briefId: guard.briefId, error: err instanceof Error ? err.message : String(err) });
    return null;
  });
  if (!runId) {
    // CFPT-2 / DATA-4 — the run never started (null OR a throw); release the claim
    // so an honest retry isn't blocked for the dedup window by a latch over a failure.
    await releaseIgnition(scope.tenantId, key);
    return toolError('dispatch_failed', 'The messaging-kernel workflow could not start.');
  }
  await recordIgnitionRun(scope.tenantId, key, runId);
  const agentId = scope.agentProfileId ?? STRATEGIST_AGENT_ID;
  await surfaceDispatchedRun(scope, deps.storage, { runId, agentId, workflowId: KERNEL_WORKFLOW_ID, workflowName: 'Messaging kernel' }, 'campaign-brief-agent-run');
  log.info('kernel_dispatched', { tenantId: scope.tenantId, briefId: guard.briefId, runId });
  return { content: JSON.stringify({ runId, briefId: guard.briefId, note: 'Kernel generation started, grounded in the brief\'s knowledge base + brand voice. It stops at an approval gate — review the kernel before generating channel assets.' }) };
}

export function registerCampaignBriefAgentTools(deps: StartRunDeps): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CAMPAIGN_BRIEF_GET_TOOL_ID,
      description:
        'Read a campaign brief\'s full body — product, personas, brand, KB collection, channels, and the messaging kernel '
        + '(if generated) — plus its completeness validation. Ground revisions and kernel work in the ACTUAL brief instead '
        + 'of a summary. Read-only.',
      inputSchema: {
        type: 'object',
        properties: { briefId: { type: 'string', description: 'The campaign brief id.' } },
        required: ['briefId'],
        additionalProperties: false,
      },
    },
    run: runGetBriefTool,
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CAMPAIGN_BRIEF_VALIDATE_TOOL_ID,
      description:
        'Check a campaign brief\'s completeness and compute the enabled channel set. Run this before generating the kernel — '
        + 'if it is not valid, tell the user exactly which pieces are missing. Returns { valid, issues, enabledChannels }. Read-only.',
      inputSchema: {
        type: 'object',
        properties: { briefId: { type: 'string', description: 'The campaign brief id.' } },
        required: ['briefId'],
        additionalProperties: false,
      },
    },
    run: runValidateTool,
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CAMPAIGN_BRIEF_RESEARCH_RUN_TOOL_ID,
      description:
        'Ignite the market-intel research pipeline for a brief: extract voice-of-customer evidence from its knowledge base → '
        + 'generate cited ad angles → build a platform targeting pack → STOP at a human approval gate. Every item cites its '
        + 'source. Requires workspace:write. Pass a `platform` ('
        + `${TARGETING_PLATFORMS.join(', ')}; defaults to meta). Returns the started \`runId\`.`,
      inputSchema: {
        type: 'object',
        properties: {
          briefId: { type: 'string', description: 'The campaign brief to research.' },
          platform: { type: 'string', enum: [...TARGETING_PLATFORMS], description: 'Targeting platform for the pack (defaults to meta).' },
        },
        required: ['briefId'],
        additionalProperties: false,
      },
    },
    run: (input, scope) => runResearchRunTool(deps, input, scope),
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CAMPAIGN_BRIEF_GENERATE_KERNEL_TOOL_ID,
      description:
        'Generate the messaging kernel for a brief — the headline, supporting statement, proof points, CTAs, and tone every '
        + 'channel echoes — grounded in the brief\'s knowledge base (with citations) and brand voice. Validate the brief '
        + 'first. Requires workspace:write. The generated kernel is SAVED onto the brief for review; the run then stops at '
        + 'an approval gate before continuing, and finalizing into a campaign stays a separate human act. Returns the '
        + 'started `runId`.',
      inputSchema: {
        type: 'object',
        properties: { briefId: { type: 'string', description: 'The campaign brief to generate the kernel for.' } },
        required: ['briefId'],
        additionalProperties: false,
      },
    },
    run: (input, scope) => runGenerateKernelTool(deps, input, scope),
  });
}
