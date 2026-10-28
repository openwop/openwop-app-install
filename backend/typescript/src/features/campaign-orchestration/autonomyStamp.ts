/**
 * ADR 0942 D4 — freeze the campaign's autonomy policy into each campaign run.
 *
 * The run-start contributor reads ONLY the host-written ADR 0941 run tag
 * (`readCampaignRunTag`), never caller metadata, and stamps the reserved
 * `run.metadata.campaignAutonomy` with the compiled rules inline.
 *
 * - `:fork` / redrive (`derivedFromRun`): the copied stamp is authoritative,
 *   present or absent, so the contributor never re-resolves it. A **branch** fork
 *   or a **redrive** adds `campaignForkPosture:'attended'` (D10.4): its effects are
 *   new, so humans decide again.
 * - A sub-workflow **child** (`parentRunId`, no `forkMode`) contributes nothing:
 *   the inherited-metadata seam has already copied the parent's stamp and posture
 *   verbatim, and absence is inherited too.
 * - A **fresh** campaign run is stamped only while `campaign-orchestration` AND
 *   `campaign-orchestration.autonomy` are ON (OFF ⇒ no stamp ⇒ today's posture). A
 *   tag naming a campaign that no longer exists under its org gets the fail-closed
 *   fallback with `dangling:true`.
 *
 * Fail-soft per the seam: a throw contributes nothing, and a campaign-bound run
 * with no stamp resolves to the fallback at decision time (`runAutonomyOf`).
 */
import { registerRunStartContributor, type RunStartContext } from '../../host/runStartContext.js';
import { registerInheritedRunMetadataKey } from '../../host/inheritedRunMetadata.js';
import {
  AUTONOMY_STAMP_KEY, FALLBACK_PRESET, autonomyToggleOn, FORK_POSTURE_KEY, buildAutonomyStamp, isCampaignBound, presetPolicy,
  resolveEffectivePolicy,
} from '../../host/autonomyPolicy/index.js';
import { getCampaign } from './campaignService.js';
import { readCampaignRunTag } from './campaignRunTag.js';

/** ADR 0075 §D3 — the org whose roles/groups approval gates resolve against. */
const APPROVER_ORG_KEY = 'approverOrgId';

function stampOrgOf(stamp: unknown): string | undefined {
  const org = stamp && typeof stamp === 'object' ? (stamp as { orgId?: unknown }).orgId : undefined;
  return typeof org === 'string' && org.length > 0 ? org : undefined;
}
const MCP_ORIGIN_SOURCE = 'mcp-server-mount';

/** Shared toggle owner; expose it to the host seam without a second predicate. */
export const autonomyTogglesOn = autonomyToggleOn;

export async function campaignAutonomyContributor(ctx: RunStartContext): Promise<Record<string, unknown>> {
  const metadata = ctx.metadata ?? {};
  if (ctx.derivedFromRun) {
    const redrive = typeof metadata.redriveOf === 'string' && metadata.redriveOf.length > 0;
    if ((ctx.forkMode === 'branch' || redrive) && (isCampaignBound(metadata) || metadata[AUTONOMY_STAMP_KEY] !== undefined)) {
      return { [FORK_POSTURE_KEY]: 'attended' };
    }
    return {};
  }
  if (ctx.parentRunId || metadata[AUTONOMY_STAMP_KEY] !== undefined) {
    // A child (or a run whose stamp was inherited): never re-resolve the policy. The
    // one thing derived here is the approver org (ADR 0075 §D3, read by gate
    // eligibility), taken from the INHERITED stamp, a frozen copy, not live state.
    const inheritedOrg = stampOrgOf(metadata[AUTONOMY_STAMP_KEY]);
    return inheritedOrg && metadata[APPROVER_ORG_KEY] === undefined ? { [APPROVER_ORG_KEY]: inheritedOrg } : {};
  }
  const tag = readCampaignRunTag(metadata); // throws on wrong_client ⇒ the seam logs it, no stamp
  if (!tag) return {};
  if (!(await autonomyTogglesOn(ctx.tenantId))) return {};
  const mcpOrigin = metadata.source === MCP_ORIGIN_SOURCE;
  const resolvedAt = new Date().toISOString();
  const campaign = await getCampaign(ctx.tenantId, tag.campaignId);
  if (!campaign || campaign.orgId !== tag.orgId) {
    return {
      [APPROVER_ORG_KEY]: tag.orgId,
      [AUTONOMY_STAMP_KEY]: buildAutonomyStamp({
        policy: presetPolicy(FALLBACK_PRESET), source: 'default', campaignId: tag.campaignId, orgId: tag.orgId, resolvedAt, mcpOrigin, dangling: true,
      }),
    };
  }
  const effective = await resolveEffectivePolicy(ctx.tenantId, tag.orgId, tag.campaignId);
  return {
    // D2: approver roles resolve on the CLIENT org — the run tag's org.
    [APPROVER_ORG_KEY]: tag.orgId,
    [AUTONOMY_STAMP_KEY]: buildAutonomyStamp({
      policy: effective.policy, source: effective.source, campaignId: tag.campaignId, orgId: tag.orgId, resolvedAt, mcpOrigin,
      dangling: effective.dangling,
    }),
  };
}

let registered = false;
/** Boot wiring (`feature.ts`). The contributor registry is append-only, so once per process. */
export function registerCampaignAutonomyStamp(): void {
  registerInheritedRunMetadataKey(AUTONOMY_STAMP_KEY);
  registerInheritedRunMetadataKey(FORK_POSTURE_KEY);
  if (registered) return;
  registerRunStartContributor(campaignAutonomyContributor);
  registered = true;
}
