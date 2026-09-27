/**
 * ADR 0363 P3 — the accessibility agent tools (the ADR 0058 / ADR 0358
 * chat-drivability seam). A node pack alone is NOT chat-drivable — surface-backed
 * nodes are excluded from the chat tool projection, so the Accessibility Reviewer
 * agent reaches its capability through `registerFeatureAgentTool`, same as the
 * documents deliverable tools.
 *
 *  - `openwop:accessibility.check` — READ/pure: run the content-a11y rules over a
 *    model the agent supplies (toggle-honest, no data access → no RBAC).
 *  - `openwop:accessibility.alt-text.generate` — WRITE: AI alt text for a media
 *    asset, forwarding to the media owner; human-turn + `workspace:write` + IDOR,
 *    toggle-honest per call (registration is process-wide; toggles are per-tenant).
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveFeatureToggle } from '../../host/agentToolKit.js';
import { listOrgs, resolveEffectiveAccess } from '../../host/accessControlService.js';
import { checkContentA11y, coerceContentA11yModel } from '../../host/contentA11y.js';
import { generateAltText } from '../media/mediaService.js';
import { OpenwopError } from '../../types.js';

export const ACCESSIBILITY_CHECK_TOOL_ID = 'openwop:accessibility.check';
export const ACCESSIBILITY_ALT_TEXT_TOOL_ID = 'openwop:accessibility.alt-text.generate';

type ToolResult = { content: string; isError?: boolean };
function toolError(error: string, message: string): ToolResult {
  return { content: JSON.stringify({ error, message }), isError: true };
}
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function registerAccessibilityAgentTools(): void {
  registerFeatureAgentTool({
    // TRUSTED: NO storage read — grades the caller-supplied model; returns issue kinds + WCAG criteria (enums).
    contentTrust: 'trusted',
    def: {
      name: ACCESSIBILITY_CHECK_TOOL_ID,
      description:
        'Check authored content for accessibility problems (missing image alt text, skipped heading levels, non-descriptive link text, low color contrast). '
        + 'Pass a normalized model of the content. Returns a list of issues (kind + WCAG criterion + severity); an empty list means no problems found. '
        + 'Use this to review a page/screen/document before publishing.',
      inputSchema: {
        type: 'object',
        properties: {
          images: { type: 'array', description: 'Images: { alt?, decorative?, ref? }.', items: { type: 'object' } },
          headings: { type: 'array', description: 'Headings in document order: { level, ref? }.', items: { type: 'object' } },
          links: { type: 'array', description: 'Links: { text?, ref? }.', items: { type: 'object' } },
          colorPairs: { type: 'array', description: 'Authored foreground/background pairs: { fg, bg, large?, ref? }.', items: { type: 'object' } },
        },
      },
    },
    async run(input, scope) {
      const featureOn = await resolveFeatureToggle('accessibility', scope);
      if (!featureOn) return toolError('feature_disabled', 'The Accessibility feature is not enabled for this workspace.');
      const issues = checkContentA11y(coerceContentA11yModel(input));
      return { content: JSON.stringify({ issues, count: issues.length }) };
    },
  });

  registerFeatureAgentTool({
    // TRUSTED: returns a freshly generated alt-text string, not stored user text.
    contentTrust: 'trusted',
    def: {
      name: ACCESSIBILITY_ALT_TEXT_TOOL_ID,
      description:
        'Generate alternative text for an image asset in the Media library (for screen-reader users). Returns a proposed alt-text string '
        + '(empty means the image is decorative). Tell the user the proposal; applying it to the asset is a separate confirmed step.',
      inputSchema: {
        type: 'object',
        properties: {
          assetId: { type: 'string', description: 'The media asset id (an image).' },
          orgId: { type: 'string', description: 'Target organization id — only needed when the workspace has more than one organization.' },
        },
        required: ['assetId'],
      },
    },
    async run(input, scope) {
      const featureOn = await resolveFeatureToggle('accessibility', scope);
      if (!featureOn) return toolError('feature_disabled', 'The Accessibility feature is not enabled for this workspace.');
      const assetId = str(input.assetId);
      if (!assetId) return toolError('validation_error', '`assetId` is required.');
      const actingUserId = scope.actingUserId;
      if (!actingUserId) return toolError('acting_user_required', 'Alt-text generation can only run from a human-initiated turn.');
      const orgs = await listOrgs(scope.tenantId);
      const orgId = optStr(input.orgId) ?? (orgs.length === 1 ? orgs[0]!.orgId : undefined);
      if (!orgId) return toolError('org_required', `This workspace has ${orgs.length} organizations — pass \`orgId\`.`);
      if (!orgs.some((o) => o.orgId === orgId)) return toolError('not_found', 'Organization not found in this workspace.');
      const access = await resolveEffectiveAccess(scope.tenantId, { subject: actingUserId, orgId });
      if (!access.scopes.includes('workspace:write')) return toolError('forbidden_scope', 'The user does not have write access to that organization.');
      try {
        const proposal = await generateAltText(scope.tenantId, orgId, assetId);
        return { content: JSON.stringify({ assetId: proposal.assetId, altText: proposal.altText, note: proposal.altText === '' ? 'The image appears decorative (empty alt).' : 'Proposed alt text — apply it to the asset to save.' }) };
      } catch (e) {
        if (e instanceof OpenwopError) return toolError(e.code, e.message);
        return toolError('internal_error', 'Alt-text generation failed.');
      }
    },
  });
}
