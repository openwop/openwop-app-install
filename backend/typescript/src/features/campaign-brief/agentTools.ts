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

import { strictCurrencyExponent } from '../../host/currencyUnits.js';
import type { BriefBudget } from './types.js';
import { isTerminalRunStatus } from '@openwop/openwop';
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { startWorkflowRun, type StartRunDeps } from '../../host/runStarter.js';
import { claimIgnition, recordIgnitionRun, releaseIgnition, ignitionKey, reclaimAfterFinishedRun } from '../../host/ignitionGuard.js';
import { surfaceDispatchedRun, type TurnRunDispatchSink } from '../../host/turnRunDispatch.js';
import { createLogger } from '../../observability/logger.js';
import { orgScopeGranted } from './routes.js';
import { getBrief, validateBrief } from './briefService.js';
import { isTargetingPlatform, TARGETING_PLATFORMS } from './targetingService.js';
import { MARKET_INTEL_WORKFLOW_ID, KERNEL_WORKFLOW_ID } from './intelWorkflows.js';
import { untrustedToolError, launchRefusalResult } from '../../host/agentToolKit.js';

const log = createLogger('campaign-brief.agent-tools');

const TOGGLE_ID = 'campaign-brief';
const STRATEGIST_AGENT_ID = 'vendor.openwop-app.campaign-brief.agents.brief-strategist';

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

type ToolResult = { content: string; isError?: boolean; hostMessage?: true };

function toolError(error: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return { content: JSON.stringify({ ...extra, error, message }), isError: true, hostMessage: true };
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

/** Host-derived monetary grounding; stored budgets remain ISO minor units.
 * Decimal insertion preserves safe integer precision without floating-point
 * division or runtime-dependent Intl display exponents. */
type PresentedAmount =
  | { status: 'available'; major: string }
  | { status: 'unavailable'; reason: 'amount_missing' | 'invalid_amount' | 'currency_missing' | 'unsupported_currency' };

function presentBudget(budget: BriefBudget | undefined) {
  if (!budget) return null;
  const currency = budget.currency ?? null;
  const exponent = strictCurrencyExponent(budget.currency);
  const amount = (minor: number | undefined): PresentedAmount => {
    if (minor === undefined) return { status: 'unavailable', reason: 'amount_missing' };
    if (!Number.isSafeInteger(minor) || minor < 0) return { status: 'unavailable', reason: 'invalid_amount' };
    if (!currency) return { status: 'unavailable', reason: 'currency_missing' };
    if (exponent === null) return { status: 'unavailable', reason: 'unsupported_currency' };
    const digits = String(minor).padStart(exponent + 1, '0');
    return { status: 'available', major: exponent === 0 ? digits : `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}` };
  };
  return {
    unit: 'major_currency_units',
    currency,
    minorUnitExponent: exponent,
    total: amount(budget.totalMinor),
    perChannel: Object.fromEntries(Object.entries(budget.perChannel ?? {}).map(([channel, minor]) => [channel, amount(minor)])),
  };
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
        // ADR 1020 D8 — a stale kernel is not used by generation; say so.
        kernelStale: b.kernelStale === true,
      },
      budgetPresentation: presentBudget(b.budget),
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
    return { ok: false, result: untrustedToolError('not_found', 'That brief (id below) was not found.', briefId) };
  }
  return { ok: true, briefId, orgId: loaded.brief.orgId };
}

// ── ACTION: research.run (ignite the market-intel pipeline) ──────────────────
export async function runResearchRunTool(deps: StartRunDeps, input: Record<string, unknown>, scope: ToolScope): Promise<ToolResult> {
  const guard = await guardBriefAction(input, scope);
  if (!guard.ok) return guard.result;
  const platformInput = typeof input.platform === 'string' ? input.platform.trim().toLowerCase() : '';
  // ADR 1020 (CS70WF-18) — an unknown platform is a typed refusal; it used to
  // become `meta` silently. Absent still defaults to meta, as the tool says.
  if (platformInput && !isTargetingPlatform(platformInput)) {
    return toolError('validation_error', 'Pass a `platform` this tool supports, or leave it out for meta.', { validPlatforms: [...TARGETING_PLATFORMS] });
  }
  const platform = isTargetingPlatform(platformInput) ? platformInput : 'meta';
  // ADR 1020 (grade-ux H3) — angles argue the APPROVED, current kernel. Refuse
  // before starting, rather than after the evidence step has already saved.
  const current = await getBrief(scope.tenantId, guard.briefId);
  if (!current?.kernel) {
    return toolError('kernel_required', 'This brief has no approved messaging kernel yet. Generate and approve the kernel first; research angles argue it.');
  }
  if (current.kernelStale) {
    return toolError('kernel_stale', 'The brief changed after its messaging kernel was approved. Regenerate and approve the kernel first; research angles argue it.');
  }
  // HIGH-1 ignition dedup — a repeated research.run on the same brief AND
  // platform inside the window reuses the run already started. (The key used to
  // omit the platform, so a google run within the window returned the meta run.)
  const key = ignitionKey('campaign-brief.research.run', guard.briefId, platform);
  const claim = await claimIgnition(scope.tenantId, key);
  if (!claim.claimed) {
    return { content: JSON.stringify({ runId: claim.existingRunId ?? null, ignited: false, note: 'an identical run was started moments ago — reusing it' }) };
  }
  let startError: unknown;
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
    startError = err;
    return null;
  });
  if (!runId) {
    // CFPT-2 / DATA-4 — the run never started (null OR a throw); release the claim
    // so an honest retry isn't blocked for the dedup window by a latch over a failure.
    await releaseIgnition(scope.tenantId, key);
    // ADR 1020 D5 — a plan, budget or run-limit refusal keeps its code.
    const refused = launchRefusalResult(startError);
    if (refused) return refused;
    return toolError('dispatch_failed', 'The market-intel workflow could not start.');
  }
  await recordIgnitionRun(scope.tenantId, key, runId);
  const agentId = scope.agentProfileId ?? STRATEGIST_AGENT_ID;
  await surfaceDispatchedRun(scope, deps.storage, { runId, agentId, workflowId: MARKET_INTEL_WORKFLOW_ID, workflowName: 'Market intel research' }, 'campaign-brief-agent-run');
  log.info('market_intel_dispatched', { tenantId: scope.tenantId, briefId: guard.briefId, platform, runId });
  return { content: JSON.stringify({ runId, briefId: guard.briefId, platform, note: 'Research pipeline started (VOC → angles → targeting → your review). Each result is saved to the brief\'s Intel tab as it is found; curate it there.' }) };
}

// ── ACTION: generate-kernel (ignite the messaging-kernel workflow) ──────────
export async function runGenerateKernelTool(deps: StartRunDeps, input: Record<string, unknown>, scope: ToolScope): Promise<ToolResult> {
  const guard = await guardBriefAction(input, scope);
  if (!guard.ok) return guard.result;
  // HIGH-1 ignition dedup — a repeated generate-kernel on the same brief inside
  // the window reuses the run already started.
  const key = ignitionKey('campaign-brief.generate-kernel', guard.briefId);
  let claim = await claimIgnition(scope.tenantId, key);
  // ADR 1020 (grade-ux H2) — "reject it and ask the Strategist to regenerate"
  // must start a NEW run: the dedup window only covers a run that is still going.
  if (!claim.claimed && claim.existingRunId) {
    const prior = await deps.storage.getRun(claim.existingRunId).catch(() => null);
    if (prior && isTerminalRunStatus(prior.status) && (await reclaimAfterFinishedRun(scope.tenantId, key, prior.runId))) {
      claim = { claimed: true };
    }
  }
  if (!claim.claimed) {
    return { content: JSON.stringify({ runId: claim.existingRunId ?? null, ignited: false, note: 'an identical run was started moments ago — reusing it' }) };
  }
  let startError: unknown;
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
    startError = err;
    return null;
  });
  if (!runId) {
    // CFPT-2 / DATA-4 — the run never started (null OR a throw); release the claim
    // so an honest retry isn't blocked for the dedup window by a latch over a failure.
    await releaseIgnition(scope.tenantId, key);
    // ADR 1020 D5 — a plan, budget or run-limit refusal keeps its code.
    const refused = launchRefusalResult(startError);
    if (refused) return refused;
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
    effect: 'read',
    def: {
      name: CAMPAIGN_BRIEF_GET_TOOL_ID,
      description:
        'Read a campaign brief\'s full body — product, personas, brand, KB collection, channels, and the messaging kernel '
        + '(if generated) — plus its completeness validation. Ground revisions and kernel work in the ACTUAL brief instead '
        + 'of a summary. Raw budget.totalMinor and budget.perChannel values are ISO minor units, not amounts to quote directly. '
        + 'Use budgetPresentation available major decimal strings with its currency when summarizing money; '
        + 'report unavailable values as unavailable and never infer a currency or amount. Read-only.',
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
    effect: 'read',
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
    effect: 'write',
    def: {
      name: CAMPAIGN_BRIEF_RESEARCH_RUN_TOOL_ID,
      description:
        'Ignite the market-intel research pipeline for a brief: extract voice-of-customer evidence from its knowledge base → '
        + 'generate cited ad angles → build a platform targeting pack → STOP at a human review checkpoint. Each result is saved '
        + 'to the brief\'s Intel tab as it is found (the human curates it there); every item cites its source. Requires '
        + 'workspace:write. Pass a `platform` ('
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
    effect: 'write',
    def: {
      name: CAMPAIGN_BRIEF_GENERATE_KERNEL_TOOL_ID,
      description:
        'Generate the messaging kernel for a brief — the headline, supporting statement, proof points, CTAs, and tone every '
        + 'channel echoes — grounded in the brief\'s knowledge base (with citations) and brand voice. Validate the brief '
        + 'first. Requires workspace:write. The run stops at an approval gate showing the generated kernel; it is saved onto '
        + 'the brief only if the human approves it (a rejection saves nothing), and finalizing into a campaign stays a '
        + 'separate human act. Returns the started `runId`.',
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
