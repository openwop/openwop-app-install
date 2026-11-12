/**
 * Creative-briefs agent tools (XCH-HOLE-7, LLM-EXCHANGE-AUDIT round 3; ADR 1039
 * D8) — the ADR 0308 seam. `openwop:creative-briefs.list` ("which briefs exist
 * and in what state?") and `openwop:creative-briefs.get` (one brief in full),
 * through the SAME service reads the HTTP routes call, behind the SAME
 * `workspace:read` predicate (`assertOrgScope`). Toggle-gated fail-closed in
 * `run`. Reads ⇒ fail EMPTY + note without an acting user.
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { featureUnavailable, resolveFeatureAccess } from '../../host/agentToolKit.js';
import { assertOrgScope, listOrgs } from '../../host/accessControlService.js';
import { OpenwopError } from '../../types.js';
import { getBrief, listBriefs, validateBriefContent } from './creativeBriefsService.js';
import { resolveMoodBoardNames } from './routes.js';

export const CREATIVE_BRIEFS_LIST_TOOL_ID = 'openwop:creative-briefs.list';
export const CREATIVE_BRIEFS_GET_TOOL_ID = 'openwop:creative-briefs.get';

type ToolResult = { content: string; isError?: boolean; hostMessage?: true };

function toolError(error: string, message: string): ToolResult {
  return { content: JSON.stringify({ error, message }), isError: true, hostMessage: true };
}

type BriefToolScope = Parameters<typeof resolveFeatureAccess>[1];

/**
 * The read gate BOTH tools share, and the HTTP GET's own predicate: the feature
 * (toggle AND plan, refused typed: `feature_disabled` / `not_entitled` /
 * `feature_unavailable`, the agent-tool-kit shape), then `assertOrgScope(tenant, user,
 * org, 'workspace:read')` — exactly what `authorizeOrgScope` → `requireOrgScope`
 * call (ADR 1039 D8; the list tool used to call `resolveEffectiveAccess`
 * itself, a second copy that agreed by coincidence). A foreign org and a
 * missing scope answer the SAME `not_found`, so the tool leaks no existence.
 * `{ empty }` when there is no acting user: a read fails EMPTY, never typed.
 */
async function resolveReadOrg(scope: BriefToolScope, orgIdInput: unknown): Promise<{ orgId: string } | { result: ToolResult } | { empty: string }> {
  const actingUserId = scope.actingUserId;
  const assignment = await resolveFeatureAccess('creative-briefs', scope);
  if (!assignment?.enabled) return { result: featureUnavailable(assignment, 'Creative Briefs') };
  if (!actingUserId) return { empty: 'No acting user on this turn — brief access is resolved per signed-in user.' };
  const orgs = await listOrgs(scope.tenantId);
  const orgId = (typeof orgIdInput === 'string' && orgIdInput.trim()) || (orgs.length === 1 ? orgs[0]!.orgId : undefined);
  if (!orgId) return { result: toolError('org_required', `This workspace has ${orgs.length} organizations — pass \`orgId\` (ask the user which).`) };
  try {
    await assertOrgScope(scope.tenantId, actingUserId, orgId, 'workspace:read');
  } catch (err) {
    // Only the predicate's two refusals read as "not found"; any other failure
    // is a fault and must not tell the model the org does not exist.
    if (err instanceof OpenwopError && (err.code === 'not_found' || err.code === 'forbidden_scope')) {
      return { result: toolError('not_found', 'Organization not found in this workspace.') };
    }
    throw err;
  }
  return { orgId };
}

export function registerCreativeBriefsAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    effect: 'read',
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
      const gate = await resolveReadOrg(scope, input.orgId);
      if ('result' in gate) return gate.result;
      if ('empty' in gate) return { content: JSON.stringify({ briefs: [], note: gate.empty }) };
      const briefs = await listBriefs(scope.tenantId, gate.orgId);
      return {
        content: JSON.stringify({
          orgId: gate.orgId,
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

  // ADR 1039 D8 (CB82XC-1) — the Creative Director could LIST briefs but never
  // READ one, so "read before you direct" was impossible for the brief it was
  // directing. Schema-carrying: `directions[]` order is what a render or reel's
  // `directionIndex` cites, so the output is never compacted.
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    effect: 'read',
    schemaCarrying: true,
    def: {
      name: CREATIVE_BRIEFS_GET_TOOL_ID,
      description:
        'Read one creative brief in full: scene, composition, camera, lighting, palette, messaging intent, platform spec, '
        + 'the creative directions IN ORDER (a direction is cited by its 0-based `index`), the mood board (library asset ids '
        + 'and names), its status and version, and its completeness issues. Read it before giving direction on a brief. '
        + 'Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          briefId: { type: 'string', description: 'The creative brief id (from openwop:creative-briefs.list).' },
          orgId: { type: 'string', description: 'The organization id (omit when the workspace has exactly one).' },
        },
        required: ['briefId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const gate = await resolveReadOrg(scope, input.orgId);
      if ('result' in gate) return gate.result;
      if ('empty' in gate) return { content: JSON.stringify({ found: false, note: gate.empty }) };
      const briefId = typeof input.briefId === 'string' ? input.briefId.trim() : '';
      if (!briefId) return toolError('validation_error', 'Pass `briefId` (from openwop:creative-briefs.list).');
      const b = await getBrief(scope.tenantId, gate.orgId, briefId);
      if (!b) return toolError('not_found', 'Creative brief not found in this organization.');
      const names = await resolveMoodBoardNames(b);
      return {
        content: JSON.stringify({
          orgId: gate.orgId,
          brief: {
            briefId: b.briefId,
            title: b.title,
            assetType: b.assetType,
            status: b.status,
            version: b.version,
            updatedAt: b.updatedAt,
            sceneDescription: b.sceneDescription,
            ...(b.composition ? { composition: b.composition } : {}),
            ...(b.cameraAngle ? { cameraAngle: b.cameraAngle } : {}),
            ...(b.lighting ? { lighting: b.lighting } : {}),
            ...(b.brandPalette ? { brandPalette: b.brandPalette } : {}),
            ...(b.messagingIntent ? { messagingIntent: b.messagingIntent } : {}),
            ...(b.platformSpec ? { platformSpec: b.platformSpec } : {}),
            ...(b.campaignBriefId ? { campaignBriefId: b.campaignBriefId } : {}),
            directions: b.directions.map((d, index) => ({ index, label: d.label, ...(d.rationale ? { rationale: d.rationale } : {}) })),
            // Deleted or foreign assets do not resolve and are dropped (CB-CODE-6).
            moodBoard: b.moodBoard.filter((m) => names.has(m.mediaAssetId)).map((m) => ({ mediaAssetId: m.mediaAssetId, name: names.get(m.mediaAssetId)!, ...(m.note ? { note: m.note } : {}) })),
            ...(b.needsAssetNote ? { needsAssetNote: b.needsAssetNote } : {}),
          },
          issues: validateBriefContent(b),
        }),
      };
    },
  });
}
