/**
 * Channel Generator chat tools (CFP-1 / ADR 0308 seam, ADR 0157 spine) — the two
 * tools that let the named Channel Generator READ the channel catalog + brief
 * readiness and IGNITE one channel child workflow from the ONE chat.
 *
 * WHY this file exists (the CFP-1 finding it repairs): the channel-generator pack
 * used to allowlist node typeIds (`feature.campaign-channels.nodes.*` +
 * `feature.creative-briefs.nodes.*`). Node typeIds are NOT conversational tools on
 * this host — only `BUILTINS` entries resolve, and an unresolved allowlist id is
 * SILENTLY DROPPED at dispatch — so the generator was offered ZERO tools while its
 * prompt claimed six. This module registers the two it can honestly drive, via
 * `registerFeatureAgentTool`, and the pack allowlist is pruned to exactly these.
 *
 * The honest execution surface is the DECLARATIVE channel spine: `generate`
 * ignites `campaign-studio.channel.<channel>` (generate → approve), one tool with
 * a `channel` parameter over the five registered channel workflows (beats five
 * near-identical tools). The generated draft's approval renders INLINE in the run
 * through the existing `core.approvalGate` HITL card.
 *
 * Authorization is the brief's route predicate, shared: both tools resolve the
 * target brief and call the SAME `resolveEffectiveAccess` scope check the
 * campaign-brief routes use — read needs `workspace:read`, the igniter needs
 * `workspace:write` on the brief's org. The READ tool fails EMPTY without an
 * acting human / access; the ACTION tool fails TYPED.
 *
 * @see docs/adr/0157-campaign-studio-channel-generation.md
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
import { CAMPAIGN_CHANNELS, type CampaignChannel } from '../campaign-brief/types.js';

const log = createLogger('campaign-channels.generator-tools');

export const CAMPAIGN_CHANNELS_LIST_TOOL_ID = 'openwop:campaign-channels.channels';
export const CAMPAIGN_CHANNELS_GENERATE_TOOL_ID = 'openwop:campaign-channels.generate';

const GENERATOR_AGENT_ID = 'feature.campaign-channels.agents.channel-generator';
const TOGGLE_ID = 'campaign-channels';

/** channel (underscore, the brief/kernel vocabulary) → child workflow id (hyphen,
 *  `channelWorkflows.ts`). One place both directions agree. */
const CHANNEL_LABELS: Record<CampaignChannel, string> = {
  landing_page: 'Landing page',
  ad_variants: 'Ad variants',
  email_sequence: 'Email sequence',
  creative_briefs: 'Creative briefs',
  social_posts: 'Social posts',
};
const workflowIdFor = (channel: CampaignChannel): string => `campaign-studio.channel.${channel.replace(/_/g, '-')}`;

type ToolResult = { content: string; isError?: boolean };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
function toolError(error: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return { content: JSON.stringify({ error, message, ...(extra ?? {}) }), isError: true };
}

async function channelsEnabled(tenantId: string, actingUserId: string | undefined): Promise<boolean> {
  const assignment = await resolveOne(TOGGLE_ID, { tenantId, ...(actingUserId ? { userId: actingUserId } : {}) }).catch(() => null);
  return Boolean(assignment?.enabled);
}

/** The SAME predicate the campaign-brief routes enforce — `resolveEffectiveAccess`
 *  on the brief's org. */
async function hasOrgScope(tenantId: string, subject: string | undefined, orgId: string, scope: Scope): Promise<boolean> {
  const access = await resolveEffectiveAccess(tenantId, { subject, orgId });
  return access.scopes.includes(scope);
}

/** The static channel catalog every generate call chooses from (grounds the
 *  agent — never a guessed channel id). */
function channelCatalog(): Array<{ channel: CampaignChannel; label: string; workflowId: string }> {
  return CAMPAIGN_CHANNELS.map((channel) => ({ channel, label: CHANNEL_LABELS[channel], workflowId: workflowIdFor(channel) }));
}

/**
 * READ — the channel catalog (channel id, label, workflow id) + optional brief
 * readiness (kernel present, enabled channels). Fails EMPTY without an acting
 * human or the feature toggle. Exported for direct authz testing.
 */
export async function runChannelsTool(input: Record<string, unknown>, scope: BundleScope): Promise<ToolResult> {
  if (!scope.actingUserId) return { content: JSON.stringify({ channels: [] }) };
  if (!(await channelsEnabled(scope.tenantId, scope.actingUserId))) return { content: JSON.stringify({ channels: [] }) };

  const catalog = channelCatalog();
  const briefId = str(input.briefId);
  if (!briefId) return { content: JSON.stringify({ channels: catalog, brief: null }) };

  const brief = await getBrief(scope.tenantId, briefId);
  if (!brief || !(await hasOrgScope(scope.tenantId, scope.actingUserId, brief.orgId, 'workspace:read'))) {
    return { content: JSON.stringify({ channels: catalog, brief: null }) };
  }
  return {
    content: JSON.stringify({
      channels: catalog,
      brief: {
        briefId: brief.id,
        orgId: brief.orgId,
        hasKernel: Boolean(brief.kernel),
        kernelStale: brief.kernelStale,
        enabledChannels: brief.channels.filter((c) => c.enabled).map((c) => c.type),
      },
    }),
  };
}

/**
 * ACTION — generate ONE channel for a brief by igniting its child workflow
 * (generate → approve). Requires an acting human with `workspace:write` on the
 * brief's org, else a typed error. The draft's approval renders inline in the
 * run. `deps` is closure-bound at registration; exposed for direct testing.
 */
export async function runChannelGenerateTool(deps: StartRunDeps, input: Record<string, unknown>, scope: BundleScope): Promise<ToolResult> {
  if (!scope.actingUserId) return toolError('acting_user_required', 'A channel can only be generated from a human-initiated turn.');
  if (!(await channelsEnabled(scope.tenantId, scope.actingUserId))) return toolError('feature_disabled', 'Campaign Channels is turned off for this workspace.');

  const channel = str(input.channel) as CampaignChannel;
  if (!CAMPAIGN_CHANNELS.includes(channel)) {
    return toolError('validation_error', 'Pass a valid `channel`.', { validChannels: [...CAMPAIGN_CHANNELS] });
  }
  const briefId = str(input.briefId);
  if (!briefId) return toolError('validation_error', 'Pass the `briefId` to generate this channel from.');
  const brief = await getBrief(scope.tenantId, briefId);
  if (!brief) return toolError('not_found', `Brief not found: ${briefId}`);
  if (!(await hasOrgScope(scope.tenantId, scope.actingUserId, brief.orgId, 'workspace:write'))) {
    return toolError('forbidden', 'You need write access to this brief\'s workspace to generate a channel.');
  }

  // HIGH-1 ignition dedup — a repeated identical generate call (same brief +
  // channel) inside the window reuses the run already started.
  const key = ignitionKey('campaign-channels.generate', briefId, channel);
  const claim = await claimIgnition(scope.tenantId, key);
  if (!claim.claimed) {
    return { content: JSON.stringify({ runId: claim.existingRunId ?? null, ignited: false, note: 'an identical run was started moments ago — reusing it' }) };
  }

  const workflowId = workflowIdFor(channel);
  const runId = await startWorkflowRun(deps, {
    tenantId: scope.tenantId,
    workflowId,
    inputs: { briefId },
    metadata: {
      actingUserId: scope.actingUserId,
      ...(scope.conversationId ? { chatSessionId: scope.conversationId } : {}),
      campaignChannel: { channel, briefId, agentId: scope.agentProfileId ?? GENERATOR_AGENT_ID },
    },
  }).catch((err) => {
    // DATA-4 — a startWorkflowRun THROW must also release the claim; coerce to
    // null so the shared failure handler below runs.
    log.warn('campaign_channel_dispatch_threw', { tenantId: scope.tenantId, briefId, channel, error: err instanceof Error ? err.message : String(err) });
    return null;
  });
  if (!runId) {
    // CFPT-2 / DATA-4 — the run never started (null OR a throw); release the claim
    // so an honest retry isn't blocked for the dedup window by a latch over a failure.
    await releaseIgnition(scope.tenantId, key);
    return toolError('dispatch_failed', `The ${channel} channel workflow could not start.`);
  }
  await recordIgnitionRun(scope.tenantId, key, runId);
  await surfaceDispatchedRun(scope, deps.storage, { runId, agentId: scope.agentProfileId ?? GENERATOR_AGENT_ID, workflowId: workflowIdFor(channel), workflowName: `${CHANNEL_LABELS[channel]} generation` }, 'campaign-channel-run');
  log.info('campaign_channel_dispatched', { tenantId: scope.tenantId, briefId, channel, runId });
  return { content: JSON.stringify({ runId, briefId, channel, workflowId }) };
}

/** ADR 0308 D2 — register the generator's two tools. Called from `feature.ts`
 *  init with the run-starter deps. */
export function registerCampaignChannelsAgentTools(deps: StartRunDeps): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    // ADR 0604 review H4 — the closed channel catalog. `channelCatalog()`'s own
    // comment states the property verbatim: "grounds the agent — never a
    // guessed channel id", and each entry carries the `workflowId` the
    // generator dispatches. MEASURED: `CAMPAIGN_CHANNELS` currently holds FIVE
    // entries and the lossy default elides at >5, so this exemption is
    // PREVENTIVE today — a sixth channel is what makes it bite. Exempt on the
    // contract, not on the current length, because the length is not the
    // invariant.
    schemaCarrying: true,
    def: {
      name: CAMPAIGN_CHANNELS_LIST_TOOL_ID,
      description:
        'List the channels you can generate (landing_page, ad_variants, email_sequence, creative_briefs, social_posts) with '
        + 'their labels. Pass a `briefId` to also see whether the brief has an approved messaging kernel (channels echo the '
        + 'kernel, so it must exist first) and which channels the brief enabled. Call this BEFORE generating. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          briefId: { type: 'string', description: 'A brief to report kernel/enabled-channel readiness for.' },
        },
        additionalProperties: false,
      },
    },
    run: runChannelsTool,
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CAMPAIGN_CHANNELS_GENERATE_TOOL_ID,
      description:
        'Generate ONE channel deliverable from a brief. Starts the channel workflow: generate the draft (grounded in the '
        + 'brief\'s KB + brand voice, echoing the kernel) → the human APPROVES it on an inline card. Pass the `briefId` and the '
        + '`channel` (landing_page | ad_variants | email_sequence | creative_briefs | social_posts). Nothing publishes and the '
        + 'run pauses at the approval gate — except that `creative_briefs` ALSO lands its drafts immediately as draft-status '
        + 'managed briefs on the Creative Briefs page (the gate covers refinement, not their existence). Returns the started `runId`.',
      inputSchema: {
        type: 'object',
        properties: {
          briefId: { type: 'string', description: 'The brief to generate this channel from.' },
          channel: { type: 'string', enum: [...CAMPAIGN_CHANNELS], description: 'Which channel deliverable to generate.' },
        },
        required: ['briefId', 'channel'],
        additionalProperties: false,
      },
    },
    run: (input, scope) => runChannelGenerateTool(deps, input, scope),
  });
}
