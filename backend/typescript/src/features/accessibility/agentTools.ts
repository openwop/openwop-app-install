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
 *    ADR 1100 D1 — the org check is `assertOrgScope`, the predicate the HTTP route
 *    runs (`requireOrgScope`), so the two cannot disagree. D5 — its output is a
 *    vision model's reading of an image, and an image can carry instructions, so
 *    it is UNTRUSTED.
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { featureUnavailable, resolveFeatureAccess, untrustedToolError } from '../../host/agentToolKit.js';
import { assertOrgScope, listOrgs } from '../../host/accessControlService.js';
import { checkContentA11y, coerceContentA11yModel } from '../../host/contentA11y.js';
import { generateAltText } from '../media/mediaService.js';
import { OpenwopError } from '../../types.js';

export const ACCESSIBILITY_CHECK_TOOL_ID = 'openwop:accessibility.check';
export const ACCESSIBILITY_ALT_TEXT_TOOL_ID = 'openwop:accessibility.alt-text.generate';

type ToolResult = { content: string; isError?: boolean; hostMessage?: true };
function toolError(error: string, message: string): ToolResult {
  return { content: JSON.stringify({ error, message }), isError: true, hostMessage: true };
}
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function registerAccessibilityAgentTools(): void {
  registerFeatureAgentTool({
    // TRUSTED: NO storage read — grades the caller-supplied model; returns issue kinds + WCAG criteria (enums).
    contentTrust: 'trusted',
    effect: 'read',
    def: {
      name: ACCESSIBILITY_CHECK_TOOL_ID,
      description:
        'Check authored content for accessibility problems (missing image alt text, skipped heading levels, non-descriptive link text, low color contrast). '
        + 'Pass a normalized model of the content. Each item may carry a `ref`, which must be an id (letters, digits, _ . : -, at most 128 characters); any other ref is dropped. '
        + 'Returns a list of issues (kind + WCAG criterion + severity; `detail: "filename"` on a missing-alt warning means the alt is a file name, not a description); an empty list means no problems found. '
        + 'Use this to review a page/screen/document before publishing.',
      inputSchema: {
        type: 'object',
        properties: {
          images: { type: 'array', description: 'Images: { alt?, decorative?, ref? }.', items: { type: 'object' } },
          headings: { type: 'array', description: 'Headings in document order: { level, ref? }.', items: { type: 'object' } },
          // A `ref` (any item) must be an id — letters, digits, `_ . : -`, ≤128 chars — or it is dropped (ADR 1100 D5).
          links: { type: 'array', description: 'Links: { text?, ref? }.', items: { type: 'object' } },
          colorPairs: { type: 'array', description: 'Authored foreground/background pairs: { fg, bg, large?, ref? }.', items: { type: 'object' } },
        },
      },
    },
    async run(input, scope) {
      // The toggle AND the plan, refused with the reason (`not_entitled` for a plan lock).
      const access = await resolveFeatureAccess('accessibility', scope);
      if (!access?.enabled) return featureUnavailable(access, 'Accessibility');
      const issues = checkContentA11y(coerceContentA11yModel(input));
      return { content: JSON.stringify({ issues, count: issues.length }) };
    },
  });

  registerFeatureAgentTool({
    // UNTRUSTED (ADR 1100 D5): the text is a vision model's reading of the image,
    // so whatever the image says reaches the model through it.
    contentTrust: 'untrusted',
    effect: 'read',
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
      // The toggle AND the plan, refused with the reason (`not_entitled` for a plan lock).
      const access = await resolveFeatureAccess('accessibility', scope);
      if (!access?.enabled) return featureUnavailable(access, 'Accessibility');
      const assetId = str(input.assetId);
      if (!assetId) return toolError('validation_error', '`assetId` is required.');
      const actingUserId = scope.actingUserId;
      if (!actingUserId) return toolError('acting_user_required', 'Alt-text generation can only run from a human-initiated turn.');
      let orgId = optStr(input.orgId);
      if (!orgId) {
        const orgs = await listOrgs(scope.tenantId);
        if (orgs.length !== 1) return toolError('org_required', `This workspace has ${orgs.length} organizations — pass \`orgId\`.`);
        orgId = orgs[0]!.orgId;
      }
      try {
        // The route's own predicate: org existence (404) then scope (403).
        await assertOrgScope(scope.tenantId, actingUserId, orgId, 'workspace:write');
      } catch (e) {
        if (e instanceof OpenwopError && e.code === 'not_found') return toolError('not_found', 'Organization not found in this workspace.');
        if (e instanceof OpenwopError && e.code === 'forbidden_scope') return toolError('forbidden_scope', 'The user does not have write access to that organization.');
        throw e;
      }
      try {
        const proposal = await generateAltText(scope.tenantId, orgId, assetId, { actingSubject: actingUserId });
        return { content: JSON.stringify({ assetId: proposal.assetId, altText: proposal.altText, note: proposal.altText === '' ? 'The image appears decorative (empty alt).' : 'Proposed alt text — apply it to the asset to save.' }) };
      } catch (e) {
        if (e instanceof OpenwopError) return untrustedToolError(e.code, 'The tool refused this call; the reason it gave is below.', e.message);
        return toolError('internal_error', 'Alt-text generation failed.');
      }
    },
  });
}
