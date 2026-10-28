/**
 * ADR 0942 P2b — freeze the CLIENT's autonomy policy into a client-bound run.
 *
 * A run that acts for one client but no single campaign (a client report that
 * covers several campaigns, lead grading, a journey) carries only the ADR 0921
 * campaign-ops stamp (`openwop-app.campaignOps.orgId`, host-written and
 * reserved). Before this, such a run was unbound and every autonomy gate in it
 * fell back to `legacy`: no policy and no approvers. This contributor freezes
 * the client's default policy instead, with `approverOrgId` set to the client
 * so role-routed approvers resolve on the client org.
 *
 * Precedence: a run that carries the ADR 0941 campaign tag is the campaign
 * contributor's (campaign override, then client default, then fallback); this
 * arm acts only when there is no campaign tag and no stamp yet. Never on a
 * `:fork`/redrive (the copied stamp is authoritative) or a sub-workflow child
 * (it inherits its parent's stamp). Fresh runs only, and only while both
 * autonomy toggles are ON.
 *
 * The policy is the client's default binding — the one client creation writes
 * (`bindClientPresetIfAbsent`, Guarded) or an admin set. A client with NO
 * binding (created before ADR 0942, or its creation-time bind failed) resolves
 * to the stricter Review-everything fallback, exactly as `clientService`
 * documents for that case. This contributor is a pure read: it never writes a
 * binding, because a backfill here would silently loosen that fallback to
 * Guarded for a client nobody configured. A stamp naming an org that is not a
 * client gets the fail-closed fallback with `dangling:true`.
 */
import { registerRunStartContributor, type RunStartContext } from '../../host/runStartContext.js';
import {
  AUTONOMY_STAMP_KEY, FALLBACK_PRESET, autonomyToggleOn, buildAutonomyStamp,
  clientBoundOrg, isCampaignBound, presetPolicy, resolveEffectivePolicy,
} from '../../host/autonomyPolicy/index.js';
import { getClient } from './clientService.js';

/** ADR 0075 §D3 — the org whose roles/groups approval gates resolve against. */
const APPROVER_ORG_KEY = 'approverOrgId';
const MCP_ORIGIN_SOURCE = 'mcp-server-mount';

export async function clientAutonomyContributor(ctx: RunStartContext): Promise<Record<string, unknown>> {
  const metadata = ctx.metadata ?? {};
  if (ctx.derivedFromRun || ctx.parentRunId) return {};
  if (metadata[AUTONOMY_STAMP_KEY] !== undefined || isCampaignBound(metadata)) return {};
  const orgId = clientBoundOrg(metadata);
  if (!orgId) return {};
  if (!(await autonomyToggleOn(ctx.tenantId))) return {};
  const mcpOrigin = metadata.source === MCP_ORIGIN_SOURCE;
  const resolvedAt = new Date().toISOString();
  if (!(await getClient(ctx.tenantId, orgId))) {
    return {
      [APPROVER_ORG_KEY]: orgId,
      [AUTONOMY_STAMP_KEY]: buildAutonomyStamp({ policy: presetPolicy(FALLBACK_PRESET), source: 'default', orgId, resolvedAt, mcpOrigin, dangling: true }),
    };
  }
  const effective = await resolveEffectivePolicy(ctx.tenantId, orgId);
  return {
    [APPROVER_ORG_KEY]: orgId,
    [AUTONOMY_STAMP_KEY]: buildAutonomyStamp({ policy: effective.policy, source: effective.source, orgId, resolvedAt, mcpOrigin, dangling: effective.dangling }),
  };
}

let registered = false;
/** Boot wiring (`feature.ts`). The contributor registry is append-only, so once per process. */
export function registerClientAutonomyStamp(): void {
  if (registered) return;
  registerRunStartContributor(clientAutonomyContributor);
  registered = true;
}
