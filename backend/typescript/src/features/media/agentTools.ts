/**
 * Media agent tool (XCH-HOLE-7, LLM-EXCHANGE-AUDIT round 3) — the ADR 0308
 * seam. `openwop:media.list` — "what assets do we have?" via the SAME
 * `listAssetsPage` the HTTP route's paged read calls, with the SAME org RBAC the route
 * enforces (`resolveEffectiveAccess` workspace:read — the documents.get
 * "same boundary as the HTTP read path" pattern). Media is always-on
 * (ADR 0027) — no toggle check, matching its routes.
 *
 * SAFE SUMMARY (architect condition): `storageRef` and `serveToken` are
 * internal storage credentials — they NEVER appear in tool output.
 * LIST tool ⇒ fails EMPTY + note without an acting user.
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { listOrgs, resolveEffectiveAccess } from '../../host/accessControlService.js';
import { listAssetsPage } from './mediaService.js';

export const MEDIA_LIST_TOOL_ID = 'openwop:media.list';

function toolError(error: string, message: string): { content: string; isError: true; hostMessage: true } {
  return { content: JSON.stringify({ error, message }), isError: true, hostMessage: true };
}

export function registerMediaAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    effect: 'read',
    def: {
      name: MEDIA_LIST_TOOL_ID,
      description:
        'List media-library assets in an organization (name, content type, size, pixel width/height when known, tags, alt text, usage). '
        + 'Optional filters: free-text q, tag, collectionId. Use it to reference REAL existing assets instead of '
        + 'inventing file names. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'The organization id (omit when the workspace has exactly one).' },
          q: { type: 'string', description: 'Optional free-text filter on the asset name.' },
          tag: { type: 'string', description: 'Optional tag filter.' },
          collectionId: { type: 'string', description: 'Optional collection filter.' },
          limit: { type: 'number', description: 'Max rows (default 50, cap 100).' },
        },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const actingUserId = scope.actingUserId;
      if (!actingUserId) {
        return { content: JSON.stringify({ assets: [], note: 'No acting user on this turn — media access is resolved per signed-in user.' }) };
      }
      // Org resolution: explicit input, else the workspace's sole org (the
      // documents.draft pattern — never guess among several).
      const orgs = await listOrgs(scope.tenantId);
      const orgId = (typeof input.orgId === 'string' && input.orgId.trim()) || (orgs.length === 1 ? orgs[0]!.orgId : undefined);
      if (!orgId) {
        return toolError('org_required', `This workspace has ${orgs.length} organizations — pass \`orgId\` (ask the user which).`);
      }
      if (!orgs.some((o) => o.orgId === orgId)) {
        return toolError('not_found', 'Organization not found in this workspace.');
      }
      // The same RBAC the HTTP read path enforces — EXACT scope parity with
      // featureRoute.requireOrgScope('workspace:read'): custom roles don't
      // nest write⊃read, so accepting write here would serve callers the
      // route 403s (grade-pass finding, 2026-07-15).
      const access = await resolveEffectiveAccess(scope.tenantId, { subject: actingUserId, orgId });
      if (!access.scopes.includes('workspace:read')) {
        return toolError('not_found', 'Organization not found in this workspace.');
      }
      const filter: { collectionId?: string; q?: string; tag?: string } = {
        ...(typeof input.q === 'string' && input.q.trim() ? { q: input.q.trim() } : {}),
        ...(typeof input.tag === 'string' && input.tag.trim() ? { tag: input.tag.trim() } : {}),
        ...(typeof input.collectionId === 'string' && input.collectionId.trim() ? { collectionId: input.collectionId.trim() } : {}),
      };
      const limit = Math.min(100, Math.max(1, Number(input.limit) || 50));
      // #5928 — one keyset page of the org's index slice, never the whole library.
      // `total` is the slice's size when no q/tag filter is set (from the counter);
      // a filtered read reports `more` instead of counting every match.
      const page = await listAssetsPage(scope.tenantId, orgId, { ...filter, limit });
      const assets = page.assets;
      return {
        content: JSON.stringify({
          orgId,
          ...(page.total !== undefined ? { total: page.total } : {}),
          ...(page.nextCursor ? { more: true } : {}),
          // Safe projection — storageRef/serveToken (internal storage
          // credentials) are deliberately absent.
          assets: assets.map((a) => ({
            assetId: a.assetId,
            name: a.name,
            contentType: a.contentType,
            sizeBytes: a.sizeBytes,
            // #5928 ask 4 — pixel size when known, so an agent can pick an image that fits.
            ...(a.width !== undefined && a.height !== undefined ? { width: a.width, height: a.height } : {}),
            ...(a.collectionId ? { collectionId: a.collectionId } : {}),
            tags: a.tags,
            ...(a.altText !== undefined ? { altText: a.altText } : {}),
            usageCount: a.usageCount,
            createdAt: a.createdAt,
          })),
        }),
      };
    },
  });
}
