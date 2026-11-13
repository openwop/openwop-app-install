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
import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { assertEffectAllowed } from '../../host/runEffectContext.js';
import { startWorkflowRun, type StartRunDeps } from '../../host/runStarter.js';
import { claimIgnition, recordIgnitionRun, releaseIgnition, ignitionKey } from '../../host/ignitionGuard.js';
import { surfaceDispatchedRun } from '../../host/turnRunDispatch.js';
import { createLogger } from '../../observability/logger.js';
import { getBrief } from '../campaign-brief/briefService.js';
import type { CampaignBrief } from '../campaign-brief/types.js';
import { ensureDraftCampaign, getCampaign, getCampaignByBrief, isFinalized, listCampaigns } from './campaignService.js';
import { readCampaignLinks } from './campaignLinks.js';
import { CAMPAIGN_RUN_TAG_KEY, stampCampaignRun } from './campaignRunTag.js';
import { ORCHESTRATION_ID } from './orchestrationWorkflow.js';
import { readableCampaignAutonomy } from './autonomyAccess.js';
import { AUTONOMY_TOGGLE, projectPolicyForModel } from '../../host/autonomyPolicy/index.js';
import { untrustedToolError, launchRefusalResult, resolveFeatureAccess, resolveFeatureToggle, featureUnavailable, type ToolAccessScope } from '../../host/agentToolKit.js';
import { forwardedPlanExemption, launchPlanExemptSubject } from '../../host/operatorPlanExemption.js';
import { assertWorkflowFeatureLaunchable, WorkflowFeatureRefusedError } from '../../host/workflowFeatureGate.js';
import { CHANNEL_WORKFLOW_IDS } from '../campaign-channels/channelWorkflows.js';
import { OpenwopError } from '../../types.js';
import { campaignLaunchConfigurable, resolveCampaignLaunchAi, type CampaignLaunchAi } from './launchAi.js';

const log = createLogger('campaign-orchestration.strategist-tools');

export const CAMPAIGN_ORCH_STATUS_TOOL_ID = 'openwop:campaign-orchestration.status';
export const CAMPAIGN_ORCH_RUN_TOOL_ID = 'openwop:campaign-orchestration.run';
/** ADR 0941 P5 — read one campaign (products, goal, links) before planning. */
export const CAMPAIGN_ORCH_GET_TOOL_ID = 'openwop:campaign-orchestration.get-campaign';
/** ADR 0942 P6 — which steps of a campaign need whose sign-off. Read-only: no tool sets, loosens or approves a policy. */
export const CAMPAIGN_ORCH_AUTONOMY_TOOL_ID = 'openwop:campaign-orchestration.get-autonomy';

/** The named agent this pack ships — the fallback speaker on the inline run turn
 *  when the dispatch scope carries no explicit agent profile. */
const STRATEGIST_AGENT_ID = 'vendor.openwop-app.campaign-orchestration.agents.campaign-strategist';
const TOGGLE_ID = 'campaign-orchestration';

type ToolResult = { content: string; isError?: boolean; hostMessage?: true };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
function toolError(error: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return { content: JSON.stringify({ ...(extra ?? {}), error, message }), isError: true, hostMessage: true };
}

/** Per-call toggle honesty (ADR 0308 D2): per-tenant, dynamic, fail-closed. */
async function orchestrationEnabled(scope: ToolAccessScope): Promise<boolean> {
  // ADR 1108 — the kit's subject: the route's shape plus the operator exemption.
  return resolveFeatureToggle(TOGGLE_ID, scope);
}

/** The SAME predicate the Campaign Studio routes enforce (`routes.ts`
 *  `hasOrgScope`) — `resolveEffectiveAccess` on the brief's org. */
// `subject` is REQUIRED. `resolveEffectiveAccess` answers OWNER when no subject is
// given ("the caller is the tenant's own principal"), so a helper that accepted
// `undefined` would turn a missing acting user into full access. Every caller
// already returns early without one; the type now makes a future caller that
// forgets fail to compile (the KEY-19 shape, ADR 0797).
async function hasOrgScope(tenantId: string, subject: string, orgId: string, scope: Scope): Promise<boolean> {
  const access = await resolveEffectiveAccess(tenantId, { subject, orgId });
  return access.scopes.includes(scope);
}

/** The setup-check semantic (ADR 0356 P4), read-only: which campaign assets the
 *  brief still lacks. Mirrors the orchestration node's `setupCheck`. Exported for
 *  the ADR 0961 autopilot preflight, so readiness has one owner. */
export function setupOf(brief: CampaignBrief): { missing: Array<{ slot: string; hint: string }>; ready: boolean } {
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
    // ADR 0941 D2 — the campaign exists from the first run, so a draft is not a finalized campaign.
    existingCampaign: existing ? { id: existing.id, status: existing.status, channels: existing.channels, finalized: isFinalized(existing) } : null,
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
  if (!(await orchestrationEnabled(scope))) return { content: empty };

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
 * READ — one campaign, for the Strategist to read before it plans (ADR 0941 P5,
 * "agents read before they write"). By `campaignId`, or by `briefId` (the brief's
 * campaign). The SAME predicate as `GET …/campaigns/:id` and `…/links`
 * (`workspace:read` on the campaign's client org). Fails EMPTY without an acting
 * human, the toggle, the campaign, or access — one answer for all four, so the
 * tool cannot be used to learn whether another client's campaign exists. Display
 * fields only; each linked section says ok / unavailable / failed.
 */
export async function runGetCampaignTool(input: Record<string, unknown>, scope: BundleScope): Promise<ToolResult> {
  const empty = JSON.stringify({ campaign: null });
  if (!scope.actingUserId) return { content: empty };
  if (!(await orchestrationEnabled(scope))) return { content: empty };
  const campaignId = str(input.campaignId);
  const briefId = str(input.briefId);
  const campaign = campaignId ? await getCampaign(scope.tenantId, campaignId) : briefId ? await getCampaignByBrief(scope.tenantId, briefId) : null;
  if (!campaign || !(await hasOrgScope(scope.tenantId, scope.actingUserId, campaign.orgId, 'workspace:read'))) return { content: empty };
  // ADR 1108 — each linked feature through the kit's subject (operator exemption included).
  const enabled = async (featureId: string): Promise<boolean> => resolveFeatureToggle(featureId, scope);
  const links = await readCampaignLinks(campaign, enabled);
  const count = (s: { status: string; items?: unknown[] }): number | string => (s.status === 'ok' ? (s.items ?? []).length : s.status);
  return {
    content: JSON.stringify({
      campaign: {
        id: campaign.id, orgId: campaign.orgId, name: campaign.name, status: campaign.status, objective: campaign.objective,
        channels: campaign.channels, finalized: isFinalized(campaign),
        ...(campaign.briefId ? { briefId: campaign.briefId } : {}),
        goal: campaign.goal ?? null,
        attention: campaign.attention ?? [],
      },
      products: links.products,
      linked: {
        plans: count(links.plans), emailSends: count(links.emailSends),
        adDispatches: count(links.adDispatches), opsAssets: count(links.opsAssets), runs: count(links.runs),
      },
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
  // ADR 1108 — a plan refusal is named as one (`not_entitled`), not as a toggle.
  const access = await resolveFeatureAccess(TOGGLE_ID, scope);
  if (!access?.enabled) {
    return access?.blockedBy ? featureUnavailable(access, 'Campaign Studio') : toolError('feature_disabled', 'Campaign Studio is turned off for this workspace.');
  }

  const briefId = str(input.briefId);
  if (!briefId) return toolError('validation_error', 'Pass the `briefId` of the confirmed brief to run.');
  const brief = await getBrief(scope.tenantId, briefId);
  if (!brief) return untrustedToolError('not_found', 'That brief (id below) was not found.', briefId);
  if (!(await hasOrgScope(scope.tenantId, scope.actingUserId, brief.orgId, 'workspace:write'))) {
    return toolError('forbidden', 'You need write access to this brief\'s workspace to run its campaign.');
  }

  let ai: CampaignLaunchAi | undefined;
  try { ai = await resolveCampaignLaunchAi(scope.tenantId, input.ai); }
  catch (err) {
    if (err instanceof OpenwopError) return toolError(err.code, 'The selected AI key, provider or model could not be used. No campaign run was started.', { reason: err.details?.reason ?? 'campaign_ai_option_invalid' });
    throw err;
  }

  // Guard before BOTH the ignition reservation and campaign creation.
  assertEffectAllowed('dispatch', 'campaign-orchestration ignition');

  // ADR 1020 D4 / CS70WF-4 — the five channel children are gated on their own
  // feature (`campaign-channels`). Refuse HERE, before the claim (a refusal after
  // it would latch the dedup window) and before the first model call, instead of
  // failing every child after the user has approved the kernel. Subject `{}` is
  // what the dispatcher evaluates (`subWorkflowDispatcher.ts`). Advisory: the
  // gate runs again at dispatch, so a toggle or plan change in between still
  // ends the run with `subworkflow_feature_refused`.
  // ADR 1108 — with the operator's plan exemption, which the dispatcher now
  // carries from the parent row too (`childPlanExemptionStamp`).
  const childRefusal = await firstChildRefusal(scope);
  if (childRefusal?.reason === 'not_entitled') {
    return toolError('forbidden', 'Campaign Studio generates its channels with Campaign Channels, which this workspace\'s plan does not include, so the campaign was not started. Upgrade the plan or ask an admin.', { reason: childRefusal.reason, feature: childRefusal.featureId });
  }
  if (childRefusal?.reason === 'feature_unavailable') {
    return toolError('forbidden', 'Campaign Studio could not check whether Campaign Channels is available right now, so the campaign was not started. Try again shortly.', { reason: childRefusal.reason, feature: childRefusal.featureId });
  }
  if (childRefusal) {
    return toolError('forbidden', 'Campaign Studio generates its channels with Campaign Channels, which is turned off for this workspace, so the campaign was not started. Ask an admin to turn it on.', { reason: childRefusal.reason, feature: childRefusal.featureId });
  }

  // HIGH-1 ignition dedup — a repeated identical run call inside the window
  // reuses the run already started rather than igniting the spine again.
  const key = ignitionKey('campaign-orchestration.run', briefId);
  const claim = await claimIgnition(scope.tenantId, key);
  if (!claim.claimed) {
    return { content: JSON.stringify({ runId: claim.existingRunId ?? null, ignited: false, reused: true, note: 'An existing run continues with its recorded AI configuration. Newly supplied options were not applied.' }) };
  }

  // ADR 0941 D2 — the campaign exists BEFORE its first run, so the run can be
  // tagged with it (and a policy, cap or experiment can bind to the run).
  // A live retry converges by key; replay was refused before any mutation.
  const ensured = await ensureDraftCampaign(scope.tenantId, brief, scope.actingUserId).catch((err) => {
    log.warn('campaign_orchestration_ensure_failed', { tenantId: scope.tenantId, briefId, error: err instanceof Error ? err.message : String(err) });
    return null;
  });
  if (!ensured) {
    await releaseIgnition(scope.tenantId, key);
    return toolError('dispatch_failed', 'The campaign could not be created, so its workflow was not started.');
  }
  const campaign = ensured.campaign;

  let startError: unknown;
  const runId = await startWorkflowRun(deps, {
    tenantId: scope.tenantId,
    workflowId: ORCHESTRATION_ID,
    // ADR 1108 — the started run keeps the operator exemption this turn holds.
    ...forwardedPlanExemption(scope),
    inputs: { briefId, createdBy: scope.actingUserId },
    ...(ai ? { configurable: campaignLaunchConfigurable(ai) } : {}),
    metadata: {
      actingUserId: scope.actingUserId,
      ...(scope.conversationId ? { chatSessionId: scope.conversationId } : {}),
      // ADR 0941 D2b — the run tag, composed by its one writer.
      [CAMPAIGN_RUN_TAG_KEY]: stampCampaignRun(campaign, { role: 'spine', agentId: scope.agentProfileId ?? STRATEGIST_AGENT_ID }),
    },
  }).catch((err) => {
    // DATA-4 — a startWorkflowRun THROW (not just a null return) must also release
    // the claim; coerce it to null so the shared failure handler below runs.
    log.warn('campaign_orchestration_dispatch_threw', { tenantId: scope.tenantId, briefId, error: err instanceof Error ? err.message : String(err) });
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
    return toolError('dispatch_failed', 'The campaign orchestration workflow could not start.');
  }
  await recordIgnitionRun(scope.tenantId, key, runId);
  await surfaceDispatchedRun(scope, deps.storage, { runId, agentId: scope.agentProfileId ?? STRATEGIST_AGENT_ID, workflowId: ORCHESTRATION_ID, workflowName: 'Campaign orchestration' }, 'campaign-orchestration-run');
  log.info('campaign_orchestration_dispatched', { tenantId: scope.tenantId, briefId, runId });
  return { content: JSON.stringify({ runId, briefId, campaignId: campaign.id, workflowId: ORCHESTRATION_ID, steps: ORCHESTRATION_RUN_STEPS }) };
}

/**
 * CC-AGENT-1 — what the started run does, in order, so the model reports the run
 * instead of guessing (it once told a user an approved kernel would be reused).
 * Mirrors `examples/workflow-chain-packs/campaign-orchestration/pack.json`
 * (validate → kernel → kernel-approve → promote-kernel → channel dispatch →
 * production-plan → consistency → finalize); pinned by the CC-AGENT-1 test.
 */
export const ORCHESTRATION_RUN_STEP_NODES: ReadonlyArray<{ readonly nodes: readonly string[]; readonly text: string }> = [
  { nodes: ['validate'], text: 'Validate the brief.' },
  { nodes: ['kernel'], text: 'Generate a NEW messaging kernel from the brief, even if the brief already has an approved kernel.' },
  { nodes: ['kernel-approve', 'promote-kernel'], text: 'Gate that new kernel per the campaign\'s review policy (usually an approval); it replaces the brief\'s kernel only once approved.' },
  { nodes: ['channel-supervisor', 'channel-dispatch'], text: 'Generate each channel the brief enables, in parallel; each channel draft goes through its own review step.' },
  { nodes: ['production-plan'], text: 'Draft a production plan.' },
  { nodes: ['consistency'], text: 'Check the channels for consistency with the kernel.' },
  { nodes: ['finalize'], text: 'Finalize the campaign.' },
];
/** What the model is told (the `steps` field). Pinned to the chain's node order by
 *  `cc-agent-1-strategist-run-truth.test.ts` via ORCHESTRATION_RUN_STEP_NODES. */
export const ORCHESTRATION_RUN_STEPS: readonly string[] = ORCHESTRATION_RUN_STEP_NODES.map((s) => s.text);

/** ADR 1020 D4 — the first channel child this tenant may not launch, or null. */
async function firstChildRefusal(scope: ToolAccessScope): Promise<{ featureId: string; reason: string } | null> {
  for (const id of CHANNEL_WORKFLOW_IDS) {
    try {
      await assertWorkflowFeatureLaunchable(scope.tenantId, id, null, launchPlanExemptSubject(scope));
    } catch (err) {
      if (err instanceof WorkflowFeatureRefusedError) return { featureId: err.featureId, reason: String(err.details?.reason ?? 'feature_disabled') };
      throw err;
    }
  }
  return null;
}

/**
 * READ — ADR 0942 P6: the campaign's review policy, per step: what runs on its
 * own, what tells people after, what waits for whose approval, and when a step
 * asks anyway. The SAME read model the review-policy panel renders, through the
 * SAME access predicate as `GET …/campaigns/:id/autonomy` (`autonomyAccess.ts`).
 * Fails EMPTY without an acting human, either toggle, or read access.
 * Exported for direct authz testing.
 */
export async function runAutonomyTool(input: Record<string, unknown>, scope: BundleScope): Promise<ToolResult> {
  const empty = JSON.stringify({ autonomy: null });
  if (!scope.actingUserId) return { content: empty };
  if (!(await orchestrationEnabled(scope))) return { content: empty };
  // CC-AGENT-1 — the sub-toggle resolves with the tool's OWN subject, like the
  // parent above (ADR 1108: the operator exemption rides it, re-checked against
  // the allowlist). The old tenant-only `autonomyTogglesOn(tenantId)` applied the
  // workspace plan to the operator and answered `null` while the review-policy
  // panel showed the effective policy.
  if (!(await resolveFeatureToggle(AUTONOMY_TOGGLE, scope))) return { content: empty };
  const campaignId = str(input.campaignId);
  if (!campaignId) return { content: JSON.stringify({ autonomy: null, note: 'Pass the `campaignId` (from status: `existingCampaign.id`, or an org\'s campaign list).' }) };
  const found = await readableCampaignAutonomy(scope.tenantId, { subject: scope.actingUserId }, campaignId);
  if (!found) return { content: empty };
  return { content: JSON.stringify({ autonomy: projectPolicyForModel(found.campaign.id, found.view) }) };
}

/** ADR 0308 D2 — register the strategist's tools. Called from `feature.ts`
 *  init with the run-starter deps (chat-time tool scopes carry no storage). */
export function registerCampaignOrchestrationAgentTools(deps: StartRunDeps): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    effect: 'read',
    def: {
      name: CAMPAIGN_ORCH_STATUS_TOOL_ID,
      description:
        'Read campaign readiness. Pass a `briefId` to see its messaging-kernel state, the enabled channels, which setup '
        + 'assets (brand / persona / KB) it still needs, and the campaign already made for it (`existingCampaign.finalized` tells an '
        + 'earlier run\'s draft from a finalized campaign) — call this BEFORE running '
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
    effect: 'read',
    def: {
      name: CAMPAIGN_ORCH_GET_TOOL_ID,
      description:
        'Read one campaign before you plan or change anything. Pass a `campaignId`, or a `briefId` to read the campaign made '
        + 'for that brief. Returns the campaign (status, objective, channels, whether it is finalized, its goal, attention flags), '
        + 'the catalog products it sells with their roles, and counts of its linked plans, email sends, ad dispatches, '
        + 'client pages and workflow runs. A linked section reads `unavailable` when its feature is off and `failed` when it could '
        + 'not be read: neither means "none". Returns `{"campaign":null}` when the campaign does not exist or you cannot read it. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          campaignId: { type: 'string', description: 'The campaign to read.' },
          briefId: { type: 'string', description: 'A brief whose campaign to read (when no campaignId).' },
        },
        additionalProperties: false,
      },
    },
    run: runGetCampaignTool,
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    effect: 'write',
    def: {
      name: CAMPAIGN_ORCH_RUN_TOOL_ID,
      description:
        'Run the full multi-channel campaign for a confirmed brief. Starts the orchestration workflow: validate → generate '
        + 'the messaging kernel → the human APPROVES the kernel on an inline card → generate every enabled channel (each with '
        + 'its own inline approval) → cross-asset consistency check → finalize the marketing campaign. Nothing publishes or '
        + 'spends: the run pauses at each approval gate for the human. Pass the confirmed `briefId`. Optional `ai` declares only an existing key reference explicitly supplied by the person; never guess a key name or request its value. Omit it to retain existing defaults, not automatically reuse the chat key. Reuse retains the recorded configuration. Returns the started `runId` and the `campaignId` the run belongs to.',
      inputSchema: {
        type: 'object',
        properties: {
          briefId: { type: 'string', description: 'The confirmed brief to orchestrate a campaign from.' },
          ai: {
            type: 'object', additionalProperties: false, required: ['credentialRef'],
            properties: {
              credentialRef: { type: 'string', description: 'Existing provider-qualified saved key NAME explicitly chosen by the person, never a secret value.' },
              provider: { type: 'string', description: 'Optional matching provider; otherwise derived from the chosen reference.' },
              model: { type: 'string', description: 'Optional catalog model for that provider; otherwise its catalog default.' },
            },
          },
        },
        required: ['briefId'],
        additionalProperties: false,
      },
    },
    run: (input, scope) => runOrchestrationRunTool(deps, input, scope),
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    effect: 'read',
    def: {
      name: CAMPAIGN_ORCH_AUTONOMY_TOOL_ID,
      description:
        'Read a campaign\'s review policy: for each step (generate, approve the plan, review creative, publish, launch or '
        + 'change ads, send email or SMS, post, contact leads, and so on), whether it runs on its own, tells people after, '
        + 'waits for approval (and by which roles, how many), or is blocked, plus the conditions that make it ask anyway '
        + '(spend, audience size, findings, first post to a destination). An unknown fact always asks. `alwaysApplies` lists '
        + 'what holds whatever the policy says. Read-only: no tool can change, loosen or approve a policy. Pass the `campaignId`.',
      inputSchema: {
        type: 'object',
        properties: {
          campaignId: { type: 'string', description: 'The campaign (from status: `existingCampaign.id`, or the org\'s campaign list).' },
        },
        required: ['campaignId'],
        additionalProperties: false,
      },
    },
    run: runAutonomyTool,
  });
}
