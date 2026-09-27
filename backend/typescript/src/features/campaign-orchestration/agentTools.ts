/**
 * Campaign Strategist chat tools (CFP-1 / ADR 0308 seam, ADR 0158 spine) — the
 * two tools that let the named Campaign Strategist READ campaign readiness and
 * IGNITE the registered orchestration workflow from the ONE chat.
 *
 * WHY this file exists (the CFP-1 finding it repairs): the strategist pack used
 * to allowlist node typeIds (`feature.campaign-*.nodes.*`). Node typeIds are NOT
 * conversational tools on this host — only `BUILTINS` entries resolve
 * (`agentToolProvider.ts` `resolveTool`), and an unresolved allowlist id is
 * SILENTLY DROPPED at dispatch (`agentDispatch.ts`). So the strategist was
 * offered ZERO tools while its prompt claimed ten. This module registers the two
 * tools it can honestly drive, via `registerFeatureAgentTool` (the ADR 0308 D2
 * dependency-inversion seam), and the pack allowlist is pruned to exactly these.
 *
 * The honest execution surface is the DECLARATIVE spine, not a hand-called node
 * soup: `run` ignites `campaign-studio.campaign-orchestration` (validate → kernel
 * → kernel-approve → 5-channel fan-out → consistency → finalize). The kernel
 * approval and each channel approval render INLINE in the run through the
 * existing `core.approvalGate` HITL cards — the strategist narrates; it does not
 * re-implement HITL in prose.
 *
 * Authorization is the ROUTE's predicate, shared: both tools resolve the target
 * brief and call the SAME `resolveEffectiveAccess` scope check the Campaign
 * Studio routes use (`routes.ts` `hasOrgScope`) — read needs `workspace:read`,
 * the igniter needs `workspace:write` on the brief's org. The READ tool fails
 * EMPTY without an acting human / access; the ACTION tool fails TYPED.
 *
 * @see docs/adr/0158-campaign-studio-orchestration.md
 * @see docs/adr/0308-tool-grounded-deliverables.md
 * @see docs/chat-first-port/e3-campaign-generation-journeys.md
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { startWorkflowRun, type StartRunDeps } from '../../host/runStarter.js';
import { claimIgnition, recordIgnitionRun, releaseIgnition, ignitionKey } from '../../host/ignitionGuard.js';
import { surfaceDispatchedRun } from '../../host/turnRunDispatch.js';
import { createLogger } from '../../observability/logger.js';
import { getBrief } from '../campaign-brief/briefService.js';
import type { CampaignBrief } from '../campaign-brief/types.js';
import { getCampaignByBrief, listCampaigns } from './campaignService.js';
import { ORCHESTRATION_ID } from './orchestrationWorkflow.js';

const log = createLogger('campaign-orchestration.strategist-tools');

export const CAMPAIGN_ORCH_STATUS_TOOL_ID = 'openwop:campaign-orchestration.status';
export const CAMPAIGN_ORCH_RUN_TOOL_ID = 'openwop:campaign-orchestration.run';

/** The named agent this pack ships — the fallback speaker on the inline run turn
 *  when the dispatch scope carries no explicit agent profile. */
const STRATEGIST_AGENT_ID = 'feature.campaign-orchestration.agents.campaign-strategist';
const TOGGLE_ID = 'campaign-orchestration';

type ToolResult = { content: string; isError?: boolean };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
function toolError(error: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return { content: JSON.stringify({ error, message, ...(extra ?? {}) }), isError: true };
}

/** Per-call toggle honesty (ADR 0308 D2): per-tenant, dynamic, fail-closed. */
async function orchestrationEnabled(tenantId: string, actingUserId: string | undefined): Promise<boolean> {
  const assignment = await resolveOne(TOGGLE_ID, { tenantId, ...(actingUserId ? { userId: actingUserId } : {}) }).catch(() => null);
  return Boolean(assignment?.enabled);
}

/** The SAME predicate the Campaign Studio routes enforce (`routes.ts`
 *  `hasOrgScope`) — `resolveEffectiveAccess` on the brief's org. */
async function hasOrgScope(tenantId: string, subject: string | undefined, orgId: string, scope: Scope): Promise<boolean> {
  const access = await resolveEffectiveAccess(tenantId, { subject, orgId });
  return access.scopes.includes(scope);
}

/** The setup-check semantic (ADR 0356 P4), read-only: which campaign assets the
 *  brief still lacks. Mirrors the orchestration node's `setupCheck`. */
function setupOf(brief: CampaignBrief): { missing: Array<{ slot: string; hint: string }>; ready: boolean } {
  const missing: Array<{ slot: string; hint: string }> = [];
  if (!brief.brandId) missing.push({ slot: 'brand', hint: 'Bind a brand so voice + guardrails apply.' });
  if (!Array.isArray(brief.personaIds) || brief.personaIds.length === 0) missing.push({ slot: 'persona', hint: 'Pick at least one persona to target.' });
  if (!brief.kbCollectionId) missing.push({ slot: 'kb', hint: 'Bind a knowledge collection so generation is grounded.' });
  return { missing, ready: missing.length === 0 };
}

/** A compact model-facing readiness projection for a brief (grounds the run). */
async function projectBrief(tenantId: string, brief: CampaignBrief): Promise<Record<string, unknown>> {
  const existing = await getCampaignByBrief(tenantId, brief.id);
  return {
    briefId: brief.id,
    orgId: brief.orgId,
    name: brief.name,
    status: brief.status,
    hasKernel: Boolean(brief.kernel),
    kernelStale: brief.kernelStale,
    enabledChannels: brief.channels.filter((c) => c.enabled).map((c) => c.type),
    setup: setupOf(brief),
    existingCampaign: existing ? { id: existing.id, status: existing.status, channels: existing.channels } : null,
  };
}

/**
 * READ — campaign readiness. With `briefId`: the brief's kernel/setup/enabled
 * channels + any existing campaign (grounds the run). Else: the org's campaigns.
 * Fails EMPTY without an acting human, access, or the feature toggle.
 * Exported for direct authz testing.
 */
export async function runStatusTool(input: Record<string, unknown>, scope: BundleScope): Promise<ToolResult> {
  const empty = JSON.stringify({ campaigns: [], brief: null });
  if (!scope.actingUserId) return { content: empty };
  if (!(await orchestrationEnabled(scope.tenantId, scope.actingUserId))) return { content: empty };

  const briefId = str(input.briefId);
  if (briefId) {
    const brief = await getBrief(scope.tenantId, briefId);
    if (!brief || !(await hasOrgScope(scope.tenantId, scope.actingUserId, brief.orgId, 'workspace:read'))) {
      return { content: empty };
    }
    return { content: JSON.stringify({ campaigns: [], brief: await projectBrief(scope.tenantId, brief) }) };
  }

  const orgId = str(input.orgId);
  if (!orgId) return { content: JSON.stringify({ campaigns: [], brief: null, note: 'Pass `briefId` (to check readiness) or `orgId` (to list campaigns).' }) };
  if (!(await hasOrgScope(scope.tenantId, scope.actingUserId, orgId, 'workspace:read'))) return { content: empty };
  const campaigns = await listCampaigns(scope.tenantId, orgId);
  return {
    content: JSON.stringify({
      campaigns: campaigns.map((c) => ({ id: c.id, name: c.name, status: c.status, channels: c.channels, briefId: c.briefId })),
      brief: null,
    }),
  };
}

/**
 * ACTION — ignite the full campaign orchestration spine for a confirmed brief.
 * Requires an acting human with `workspace:write` on the brief's org, else a
 * typed error. The spine GENERATES + approves the kernel and each channel inline
 * (`core.approvalGate` cards), so NO pre-existing kernel is required (that is
 * what distinguishes this from the thin REST `/finalize` adapter). `deps` (the
 * run-starter) is closure-bound at registration; exposed for direct testing.
 */
export async function runOrchestrationRunTool(deps: StartRunDeps, input: Record<string, unknown>, scope: BundleScope): Promise<ToolResult> {
  if (!scope.actingUserId) return toolError('acting_user_required', 'A campaign can only be run from a human-initiated turn.');
  if (!(await orchestrationEnabled(scope.tenantId, scope.actingUserId))) return toolError('feature_disabled', 'Campaign Studio is turned off for this workspace.');

  const briefId = str(input.briefId);
  if (!briefId) return toolError('validation_error', 'Pass the `briefId` of the confirmed brief to run.');
  const brief = await getBrief(scope.tenantId, briefId);
  if (!brief) return toolError('not_found', `Brief not found: ${briefId}`);
  if (!(await hasOrgScope(scope.tenantId, scope.actingUserId, brief.orgId, 'workspace:write'))) {
    return toolError('forbidden', 'You need write access to this brief\'s workspace to run its campaign.');
  }

  // HIGH-1 ignition dedup — a repeated identical run call inside the window
  // reuses the run already started rather than igniting the spine again.
  const key = ignitionKey('campaign-orchestration.run', briefId);
  const claim = await claimIgnition(scope.tenantId, key);
  if (!claim.claimed) {
    return { content: JSON.stringify({ runId: claim.existingRunId ?? null, ignited: false, note: 'an identical run was started moments ago — reusing it' }) };
  }

  const runId = await startWorkflowRun(deps, {
    tenantId: scope.tenantId,
    workflowId: ORCHESTRATION_ID,
    inputs: { briefId, createdBy: scope.actingUserId },
    metadata: {
      actingUserId: scope.actingUserId,
      ...(scope.conversationId ? { chatSessionId: scope.conversationId } : {}),
      campaignOrchestration: { briefId, agentId: scope.agentProfileId ?? STRATEGIST_AGENT_ID },
    },
  }).catch((err) => {
    // DATA-4 — a startWorkflowRun THROW (not just a null return) must also release
    // the claim; coerce it to null so the shared failure handler below runs.
    log.warn('campaign_orchestration_dispatch_threw', { tenantId: scope.tenantId, briefId, error: err instanceof Error ? err.message : String(err) });
    return null;
  });
  if (!runId) {
    // CFPT-2 / DATA-4 — the run never started (null OR a throw); release the claim
    // so an honest retry isn't blocked for the dedup window by a latch over a failure.
    await releaseIgnition(scope.tenantId, key);
    return toolError('dispatch_failed', 'The campaign orchestration workflow could not start.');
  }
  await recordIgnitionRun(scope.tenantId, key, runId);
  await surfaceDispatchedRun(scope, deps.storage, { runId, agentId: scope.agentProfileId ?? STRATEGIST_AGENT_ID, workflowId: ORCHESTRATION_ID, workflowName: 'Campaign orchestration' }, 'campaign-orchestration-run');
  log.info('campaign_orchestration_dispatched', { tenantId: scope.tenantId, briefId, runId });
  return { content: JSON.stringify({ runId, briefId, workflowId: ORCHESTRATION_ID }) };
}

/** ADR 0308 D2 — register the strategist's two tools. Called from `feature.ts`
 *  init with the run-starter deps (chat-time tool scopes carry no storage). */
export function registerCampaignOrchestrationAgentTools(deps: StartRunDeps): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CAMPAIGN_ORCH_STATUS_TOOL_ID,
      description:
        'Read campaign readiness. Pass a `briefId` to see its messaging-kernel state, the enabled channels, which setup '
        + 'assets (brand / persona / KB) it still needs, and any campaign already finalized from it — call this BEFORE running '
        + 'a campaign. Pass an `orgId` instead to list the workspace\'s campaigns (id, name, status, channels). Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          briefId: { type: 'string', description: 'A confirmed brief to check readiness for.' },
          orgId: { type: 'string', description: 'A workspace org to list campaigns for (when no briefId).' },
        },
        additionalProperties: false,
      },
    },
    run: runStatusTool,
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CAMPAIGN_ORCH_RUN_TOOL_ID,
      description:
        'Run the full multi-channel campaign for a confirmed brief. Starts the orchestration workflow: validate → generate '
        + 'the messaging kernel → the human APPROVES the kernel on an inline card → generate every enabled channel (each with '
        + 'its own inline approval) → cross-asset consistency check → finalize the marketing campaign. Nothing publishes or '
        + 'spends: the run pauses at each approval gate for the human. Pass the confirmed `briefId`. Returns the started `runId`.',
      inputSchema: {
        type: 'object',
        properties: {
          briefId: { type: 'string', description: 'The confirmed brief to orchestrate a campaign from.' },
        },
        required: ['briefId'],
        additionalProperties: false,
      },
    },
    run: (input, scope) => runOrchestrationRunTool(deps, input, scope),
  });
}
