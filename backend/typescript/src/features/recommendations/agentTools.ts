/**
 * CFP-1 (CHAT-FIRST-PORT-AUDIT #1, unit E8 / MERCH-A) — the Merchandiser's REAL
 * conversational tools.
 *
 * The `feature.recommendations.agents` pack allowlisted node typeIds no provider
 * projects into chat, so every tool was silently dropped at dispatch (a toothless
 * persona). These `registerFeatureAgentTool` builtins register one wrapper per
 * capability over the SAME service fns the REST routes call
 * (`recommendationsService` — the single source of truth), gated exactly like the
 * HTTP path (`authorizeOrgScope` → toggle + org RBAC via `resolveEffectiveAccess`).
 *
 * A placement carries no money and is trivially reversible, so the ADR 0058
 * chat-drivability review permits DIRECT authoring (the ruling `surface.ts`
 * records). Read tools fail EMPTY without an acting user; the write fails TYPED.
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { claimIgnition, recordIgnitionRun, ignitionKey } from '../../host/ignitionGuard.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { resolveFeatureToggle, toolFailLog } from '../../host/agentToolKit.js';
import { createLogger } from '../../observability/logger.js';
import { listOrgs, resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { OpenwopError } from '../../types.js';
import {
  listPlacements, createPlacement, resolveRecommendations, RECO_SLOTS, RECO_SOURCES, type RecoSlot,
} from './recommendationsService.js';

export const RECOMMENDATIONS_RESOLVE_TOOL_ID = 'openwop:recommendations.resolve';
export const RECOMMENDATIONS_LIST_PLACEMENTS_TOOL_ID = 'openwop:recommendations.list-placements';
export const RECOMMENDATIONS_CREATE_PLACEMENT_TOOL_ID = 'openwop:recommendations.create-placement';

const FEATURE = 'recommendations';
type ToolResult = { content: string; isError?: boolean };
const ok = (v: unknown): ToolResult => ({ content: JSON.stringify(v) });
const toolError = (error: string, message: string): { content: string; isError: true } => ({ content: JSON.stringify({ error, message }), isError: true });
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Shared org resolve + authz predicate — identical policy to the routes'
 *  `authorizeOrgScope`/`requireOrgScope` (toggle → membership → RFC 0049 scope).
 *  Reads fail EMPTY on any denial; writes fail TYPED; org ambiguity is always
 *  TYPED so the model knows to pass `orgId`. (See discovery/agentTools.ts.) */
// Mode-aware: a READ resolve may fail EMPTY (a system turn / no rows), so callers
// branch on `empty`; a WRITE resolve NEVER returns empty (every miss is typed), so
// its callers narrow straight to `{ orgId }` after the `error` branch.
async function resolveToolOrg(scope: BundleScope, orgIdArg: string | undefined, mode: 'read'): Promise<{ orgId: string } | { empty: true } | { error: ToolResult }>;
async function resolveToolOrg(scope: BundleScope, orgIdArg: string | undefined, mode: 'write'): Promise<{ orgId: string } | { error: ToolResult }>;
async function resolveToolOrg(
  scope: BundleScope,
  orgIdArg: string | undefined,
  mode: 'read' | 'write',
): Promise<{ orgId: string } | { empty: true } | { error: ToolResult }> {
  const required: Scope = mode === 'read' ? 'workspace:read' : 'workspace:write';
  const deny = (error: string, message: string): { empty: true } | { error: ToolResult } =>
    mode === 'read' ? { empty: true } : { error: toolError(error, message) };

  const featureOn = await resolveFeatureToggle(FEATURE, scope);
  if (!featureOn) return deny('feature_disabled', 'The Recommendations feature is not enabled for this workspace.');
  const actingUserId = scope.actingUserId;
  if (!actingUserId) return deny('acting_user_required', 'This tool runs on behalf of a signed-in user.');

  const orgs = await listOrgs(scope.tenantId);
  const orgId = orgIdArg ?? (orgs.length === 1 ? orgs[0]!.orgId : undefined);
  if (!orgId) return { error: toolError('org_required', `This workspace has ${orgs.length} organizations — pass \`orgId\`.`) };
  if (!orgs.some((o) => o.orgId === orgId)) return deny('not_found', 'Organization not found in this workspace.');
  const access = await resolveEffectiveAccess(scope.tenantId, { subject: actingUserId, orgId });
  if (!access.scopes.includes(required)) return deny('forbidden_scope', `The user lacks ${required} on that organization.`);
  return { orgId };
}

const log = createLogger('recommendations.agent-tools');
function fromServiceError(e: unknown): { content: string; isError: true } {
  if (e instanceof OpenwopError) return toolError(e.code, e.message);
  return toolFailLog(log, 'openwop:recommendations', e) as { content: string; isError: true }; // CFPT-6
}

export function registerRecommendationsAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: RECOMMENDATIONS_RESOLVE_TOOL_ID,
      description:
        'See what a funnel slot currently recommends for an anchor product — the operator-preview resolve. '
        + `Slots: ${RECO_SLOTS.join(', ')}. Returns the winning placement, its source, and the recommended `
        + 'productIds. Ground every merchandising suggestion in what this actually returns — never invent ids. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          slot: { type: 'string', enum: [...RECO_SLOTS], description: 'The funnel slot to resolve.' },
          productId: { type: 'string', description: 'The anchor product (e.g. the PDP product) — optional.' },
          contactId: { type: 'string', description: 'A CRM contact for segment-targeted preview (operator only) — optional.' },
          orgId: { type: 'string', description: 'Target organization id — only needed with more than one organization.' },
        },
        required: ['slot'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const resolved = await resolveToolOrg(scope, optStr(input.orgId), 'read');
      if ('empty' in resolved) return ok({ products: [], placementId: null });
      if ('error' in resolved) return resolved.error;
      const slotRaw = str(input.slot);
      if (!(RECO_SLOTS as readonly string[]).includes(slotRaw)) {
        return toolError('validation_error', `slot must be one of: ${RECO_SLOTS.join(', ')}`);
      }
      const result = await resolveRecommendations({
        tenantId: scope.tenantId, orgId: resolved.orgId, slot: slotRaw as RecoSlot,
        ...(optStr(input.productId) ? { productId: optStr(input.productId)! } : {}),
        ...(optStr(input.contactId) ? { contactId: optStr(input.contactId)! } : {}),
      });
      return ok({
        placementId: result.placementId ?? null,
        source: result.source ?? null,
        variant: result.variant ?? null,
        productIds: result.products.map((p) => p.productId),
        // Review MJ-5 — carry the REASONS. A model told only `placementId: null` will
        // report the slot as unconfigured, which is the B2 lie relocated to the surface
        // where it is least visible. The tool's own description tells it to ground every
        // claim in what this returns, so what this returns has to be enough.
        ...(result.segmentTargetedSkipped ? { segmentTargetedSkipped: true } : {}),
        ...(result.segmentNotMatched ? { segmentNotMatched: true } : {}),
        ...(result.unresolvedSegmentIds?.length ? { unresolvedSegmentIds: result.unresolvedSegmentIds } : {}),
        ...(result.holdoutInert ? { holdoutInert: true } : {}),
      });
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: RECOMMENDATIONS_LIST_PLACEMENTS_TOOL_ID,
      description:
        'List the recommendation placements (id, slot, source, segment target, holdout %, active). Read this BEFORE '
        + 'authoring a placement so you do not duplicate one for the same slot. Read-only.',
      inputSchema: {
        type: 'object',
        properties: { orgId: { type: 'string', description: 'Target organization id — only needed with more than one organization.' } },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const resolved = await resolveToolOrg(scope, optStr(input.orgId), 'read');
      if ('empty' in resolved) return ok({ placements: [] });
      if ('error' in resolved) return resolved.error;
      const placements = await listPlacements(scope.tenantId, resolved.orgId);
      return ok({
        placements: placements.map((p) => ({
          placementId: p.placementId, slot: p.slot, source: p.source, active: p.active,
          ...(p.segmentId ? { segmentId: p.segmentId } : {}),
          ...(p.holdoutPct !== undefined ? { holdoutPct: p.holdoutPct } : {}),
        })),
      });
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: RECOMMENDATIONS_CREATE_PLACEMENT_TOOL_ID,
      description:
        'Create a recommendation placement binding a funnel slot to a source (upsell/cross-sell/FBT etc.), optionally '
        + 'targeting a CRM segment and holding back a control cohort (holdout %) to measure lift. Recommend the '
        + `strategy before creating. Slots: ${RECO_SLOTS.join(', ')}; sources: ${RECO_SOURCES.join(', ')}. No money moves.`,
      inputSchema: {
        type: 'object',
        properties: {
          slot: { type: 'string', enum: [...RECO_SLOTS], description: 'The funnel slot.' },
          source: { type: 'string', enum: [...RECO_SOURCES], description: 'The recommendation source.' },
          segmentId: { type: 'string', description: 'Optional CRM segment target (resolved live).' },
          holdoutPct: { type: 'number', description: 'Optional control-cohort percentage (0..100) held back to measure lift.' },
          orgId: { type: 'string', description: 'Target organization id — only needed with more than one organization.' },
        },
        required: ['slot', 'source'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const resolved = await resolveToolOrg(scope, optStr(input.orgId), 'write');
      if ('error' in resolved) return resolved.error;
      // LOW-1 idempotent create — a retried identical placement (same org + slot +
      // source + segment) inside the window returns the one already created.
      const key = ignitionKey('recommendations.create-placement', resolved.orgId, str(input.slot), str(input.source), optStr(input.segmentId));
      const claim = await claimIgnition(scope.tenantId, key);
      if (!claim.claimed) {
        return ok({ ...(claim.existingRunId ? { placementId: claim.existingRunId } : {}), slot: str(input.slot), source: str(input.source), deduped: true, note: 'That placement was just created — reusing it.' });
      }
      try {
        const placement = await createPlacement({
          tenantId: scope.tenantId, orgId: resolved.orgId, createdBy: scope.agentProfileId ?? scope.actingUserId ?? 'agent',
          slot: str(input.slot), source: str(input.source),
          ...(optStr(input.segmentId) ? { segmentId: optStr(input.segmentId) } : {}),
          ...(typeof input.holdoutPct === 'number' ? { holdoutPct: input.holdoutPct } : {}),
          // R2 REC2-M7 — ADR 0273 records this agent as one that "drafts placements,
          // never auto-activates a holdout without review", and the code did the
          // opposite: a chat turn could put 20% of live shoppers into a no-recommendations
          // control arm with no approval. A holdout SUPPRESSES conversion surface, which
          // is the thing the ADR's carve-out ("a placement carries no money") does not
          // cover. A holdout placement is now created INACTIVE for a human to activate.
          ...(typeof input.holdoutPct === 'number' && input.holdoutPct > 0 ? { active: false } : {}),
        });
        await recordIgnitionRun(scope.tenantId, key, placement.placementId);
        return ok({
          placementId: placement.placementId, slot: placement.slot, source: placement.source, active: placement.active,
          note: placement.active
            ? 'Placement created and live. Tell the user which slot→source it binds.'
            : 'Placement created as a DRAFT because it carries a holdout — a holdout hides recommendations from a share of real shoppers, so a human activates it on the Recommendations page. Say so plainly; do not imply it is live.',
        });
      } catch (e) { return fromServiceError(e); }
    },
  });
}
