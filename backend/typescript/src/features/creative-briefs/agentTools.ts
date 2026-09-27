/**
 * Creative-briefs agent tool (XCH-HOLE-7, LLM-EXCHANGE-AUDIT round 3) — the
 * ADR 0308 seam. `openwop:creative-briefs.list` — "which briefs exist and in
 * what state?" via the SAME `listBriefs` the HTTP route calls after its
 * `workspace:read` org authz; the tool enforces the same boundary with
 * `resolveEffectiveAccess` (the documents.get pattern). Toggle-gated
 * fail-closed in `run` (creative-briefs is off by default). LIST tool ⇒
 * fails EMPTY + note without an acting user.
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { listOrgs, resolveEffectiveAccess } from '../../host/accessControlService.js';
import { listBriefs } from './creativeBriefsService.js';

export const CREATIVE_BRIEFS_LIST_TOOL_ID = 'openwop:creative-briefs.list';

function toolError(error: string, message: string): { content: string; isError: true } {
  return { content: JSON.stringify({ error, message }), isError: true };
}

export function registerCreativeBriefsAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CREATIVE_BRIEFS_LIST_TOOL_ID,
      description:
        'List the creative briefs in an organization: title, asset type, status (draft/review/approved), and '
        + 'version. Use it to ground creative work in the ACTUAL brief pipeline instead of guessing. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'The organization id (omit when the workspace has exactly one).' },
        },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      // Toggle honesty (ADR 0308 D2): per-call, fail-closed FIRST (a disabled
      // feature has no surface) — SAME subject shape as the route gate
      // (tenant + user when present), so a user-bucketed rollout can't
      // disagree between route and tool (grade-pass, 2026-07-15).
      const actingUserId = scope.actingUserId;
      const assignment = await resolveOne('creative-briefs', { tenantId: scope.tenantId, ...(actingUserId ? { userId: actingUserId } : {}) }).catch(() => null);
      if (!assignment?.enabled) {
        return toolError('feature_disabled', 'The Creative Briefs feature is not enabled for this workspace.');
      }
      if (!actingUserId) {
        return { content: JSON.stringify({ briefs: [], note: 'No acting user on this turn — brief access is resolved per signed-in user.' }) };
      }
      const orgs = await listOrgs(scope.tenantId);
      const orgId = (typeof input.orgId === 'string' && input.orgId.trim()) || (orgs.length === 1 ? orgs[0]!.orgId : undefined);
      if (!orgId) {
        return toolError('org_required', `This workspace has ${orgs.length} organizations — pass \`orgId\` (ask the user which).`);
      }
      if (!orgs.some((o) => o.orgId === orgId)) {
        return toolError('not_found', 'Organization not found in this workspace.');
      }
      // EXACT scope parity with the route's authz('workspace:read') — custom
      // roles don't nest write⊃read (grade-pass finding, 2026-07-15).
      const access = await resolveEffectiveAccess(scope.tenantId, { subject: actingUserId, orgId });
      if (!access.scopes.includes('workspace:read')) {
        return toolError('not_found', 'Organization not found in this workspace.');
      }
      const briefs = await listBriefs(scope.tenantId, orgId);
      return {
        content: JSON.stringify({
          orgId,
          briefs: briefs.map((b) => ({
            briefId: b.briefId,
            title: b.title,
            assetType: b.assetType,
            status: b.status,
            version: b.version,
            updatedAt: b.updatedAt,
          })),
        }),
      };
    },
  });
}
