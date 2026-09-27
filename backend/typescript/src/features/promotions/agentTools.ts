/**
 * CFP-1 (CHAT-FIRST-PORT-AUDIT #1, unit E8 / MERCH-B) — the Promotions Manager's
 * REAL conversational tools.
 *
 * The `feature.promotions.agents` pack allowlisted node typeIds no provider
 * projects into chat, so every tool was silently dropped at dispatch (a toothless
 * persona). These `registerFeatureAgentTool` builtins register one wrapper per
 * capability over the SAME service fns the REST routes call (`promotionsService`
 * — the single source of truth), gated exactly like the HTTP path
 * (`authorizeOrgScope` → toggle + org RBAC via `resolveEffectiveAccess`).
 *
 * MONEY-MOVING FIREWALL (ADR 0274 / ADR 0058 chat-drivability finding 1): a
 * promotion an agent authors lands PROPOSED (`active:false`) — a human activates
 * it in the Promotions page. This is the "agent proposes, human confirms" seam.
 * There is DELIBERATELY no activate/confirm tool here: confirmation rides the
 * shared human-gate machinery, never a chat tool (E8 blocker 4). Read tools fail
 * EMPTY without an acting user; the draft write fails TYPED.
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { toolFailLog } from '../../host/agentToolKit.js';
import { createLogger } from '../../observability/logger.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { listOrgs, resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { OpenwopError } from '../../types.js';
import { listPromotions, createPromotion, applyPromotionsUngated, PROMOTION_TYPES } from './promotionsService.js';

export const PROMOTIONS_LIST_TOOL_ID = 'openwop:promotions.list';
export const PROMOTIONS_APPLY_PREVIEW_TOOL_ID = 'openwop:promotions.apply-preview';
export const PROMOTIONS_DRAFT_TOOL_ID = 'openwop:promotions.draft';

const FEATURE = 'promotions';
type ToolResult = { content: string; isError?: boolean };
const ok = (v: unknown): ToolResult => ({ content: JSON.stringify(v) });
const toolError = (error: string, message: string): { content: string; isError: true } => ({ content: JSON.stringify({ error, message }), isError: true });
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

const INTERNAL = new Set(['tenantId', 'createdBy']);
function projectPromotion(p: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) if (!INTERNAL.has(k)) out[k] = v;
  return out;
}

/** Shared org resolve + authz predicate — identical policy to the routes'
 *  `authorizeOrgScope`/`requireOrgScope` (toggle → membership → RFC 0049 scope).
 *  Reads fail EMPTY on any denial; writes fail TYPED; org ambiguity is always
 *  TYPED so the model knows to pass `orgId`. (See discovery/agentTools.ts.) */
async function resolveToolOrg(
  scope: BundleScope,
  orgIdArg: string | undefined,
  mode: 'read' | 'write',
): Promise<{ orgId: string } | { empty: true } | { error: ToolResult }> {
  const required: Scope = mode === 'read' ? 'workspace:read' : 'workspace:write';
  const deny = (error: string, message: string): { empty: true } | { error: ToolResult } =>
    mode === 'read' ? { empty: true } : { error: toolError(error, message) };

  const assignment = await resolveOne(FEATURE, { tenantId: scope.tenantId, ...(scope.actingUserId ? { userId: scope.actingUserId } : {}) }).catch(() => null);
  if (!assignment?.enabled) return deny('feature_disabled', 'The Promotions feature is not enabled for this workspace.');
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

const log = createLogger('promotions.agent-tools');
function fromServiceError(e: unknown): { content: string; isError: true } {
  if (e instanceof OpenwopError) return toolError(e.code, e.message);
  return toolFailLog(log, 'openwop:promotions', e) as { content: string; isError: true }; // CFPT-6
}

export function registerPromotionsAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: PROMOTIONS_LIST_TOOL_ID,
      description:
        'List the workspace promotions — active AND proposed (drafts you or the operator created), with type, '
        + 'reward, scope, and the `active` flag. Read this to see what already exists (including your own drafts) '
        + 'before drafting a new one. Read-only.',
      inputSchema: {
        type: 'object',
        properties: { orgId: { type: 'string', description: 'Target organization id — only needed with more than one organization.' } },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const resolved = await resolveToolOrg(scope, optStr(input.orgId), 'read');
      if ('empty' in resolved) return ok({ promotions: [] });
      if ('error' in resolved) return resolved.error;
      const promotions = await listPromotions(scope.tenantId, resolved.orgId);
      return ok({ promotions: promotions.map(projectPromotion) });
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: PROMOTIONS_APPLY_PREVIEW_TOOL_ID,
      description:
        'Preview the total discount + which active promotions fire on a HYPOTHETICAL cart. Does NOT create an '
        + 'order or move money. Use it to show the impact of the current promotions (or one you are about to '
        + 'propose) on a sample basket. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'Cart lines: { productId, unitPrice (major units), quantity }.',
            items: {
              type: 'object',
              properties: {
                productId: { type: 'string' },
                unitPrice: { type: 'number' },
                quantity: { type: 'number' },
              },
              required: ['productId', 'unitPrice', 'quantity'],
              additionalProperties: false,
            },
          },
          currency: { type: 'string', description: "Currency code (default 'USD')." },
          orgId: { type: 'string', description: 'Target organization id — only needed with more than one organization.' },
        },
        required: ['items'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const resolved = await resolveToolOrg(scope, optStr(input.orgId), 'read');
      if ('empty' in resolved) return ok({ discount: 0, appliedPromotions: [] });
      if ('error' in resolved) return resolved.error;
      const items = Array.isArray(input.items)
        ? (input.items as { productId?: unknown; unitPrice?: unknown; quantity?: unknown }[]).map((i) => ({
            productId: String(i?.productId ?? ''), unitPrice: Number(i?.unitPrice ?? 0), quantity: Number(i?.quantity ?? 0),
          }))
        : [];
      const subtotal = items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
      const r = await applyPromotionsUngated({
        tenantId: scope.tenantId, orgId: resolved.orgId, currency: optStr(input.currency) ?? 'USD', subtotalAfterCoupon: subtotal, items,
      });
      return ok({ discount: r.discount, appliedPromotions: r.appliedPromotions });
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: PROMOTIONS_DRAFT_TOOL_ID,
      description:
        'DRAFT a promotion. It lands PROPOSED (inactive) — a human must activate it in the Promotions page; you '
        + 'NEVER make a promotion go live (it moves money). '
        + `Types: ${PROMOTION_TYPES.join(', ')}. A loss_leader REQUIRES budget.maxDiscount (the loss cap). `
        + 'Explain the tactic and preview its impact (apply-preview) before drafting.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Promotion name.' },
          type: { type: 'string', enum: [...PROMOTION_TYPES], description: 'The promotion type.' },
          reward: {
            type: 'object',
            description: "The reward: { kind: 'percentage' | 'fixed', value }.",
            properties: { kind: { type: 'string', enum: ['percentage', 'fixed'] }, value: { type: 'number' } },
            required: ['kind', 'value'],
            additionalProperties: false,
          },
          scope: {
            type: 'object',
            description: 'What the reward applies to: { productIds?, categories?, all? }.',
            properties: { productIds: { type: 'array', items: { type: 'string' } }, categories: { type: 'array', items: { type: 'string' } }, all: { type: 'boolean' } },
            additionalProperties: false,
          },
          minSpend: { type: 'number', description: 'cart_threshold: the minimum goods subtotal that triggers the reward.' },
          minQuantity: { type: 'number', description: 'tiered: the minimum scoped quantity that triggers the reward.' },
          bogo: {
            type: 'object',
            description: 'bogo: { buy, get } — buy N ⇒ the cheapest M get the reward.',
            properties: { buy: { type: 'number' }, get: { type: 'number' } },
            additionalProperties: false,
          },
          budget: {
            type: 'object',
            description: 'loss_leader loss cap: { maxDiscount?, maxQuantity? } (major units). REQUIRED for loss_leader.',
            properties: { maxDiscount: { type: 'number' }, maxQuantity: { type: 'number' } },
            additionalProperties: false,
          },
          priority: { type: 'number', description: 'Resolution priority (higher wins). Default 0.' },
          orgId: { type: 'string', description: 'Target organization id — only needed with more than one organization.' },
        },
        required: ['name', 'type', 'reward'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const resolved = await resolveToolOrg(scope, optStr(input.orgId), 'write');
      if ('empty' in resolved) return toolError('acting_user_required', 'This tool runs on behalf of a signed-in user.');
      if ('error' in resolved) return resolved.error;
      if (!str(input.name)) return toolError('validation_error', '`name` is required.');
      try {
        const promotion = await createPromotion({
          tenantId: scope.tenantId, orgId: resolved.orgId, createdBy: scope.agentProfileId ?? scope.actingUserId ?? 'agent',
          name: str(input.name), type: input.type, reward: input.reward,
          scope: input.scope, minSpend: input.minSpend, minQuantity: input.minQuantity, bogo: input.bogo, budget: input.budget, priority: input.priority,
          active: false, // PROPOSED — never auto-live from a chat turn (money-moving firewall).
          // R2 PRO2-P1 (review B2) — this lane dropped it too.
          currency: input.currency,
        });
        return ok({
          promotionId: promotion.promotionId, name: promotion.name, type: promotion.type, active: promotion.active, proposed: true,
          note: 'Drafted as PROPOSED (inactive). Tell the user it is a proposal they must activate in the Promotions page — you did not make it live.',
        });
      } catch (e) { return fromServiceError(e); }
    },
  });
}
