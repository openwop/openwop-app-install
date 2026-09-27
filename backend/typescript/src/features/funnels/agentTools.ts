/**
 * Funnel Architect agent tools (CFP-1 repair — CHAT-FIRST-PORT-AUDIT #1, E6).
 *
 * The port review found the Funnel Architect pack allowlisted five NODE typeIds
 * (`openwop:feature.funnels.nodes.*`) that no host registrant projects into the
 * chat tool universe — both dispatch lanes intersect the allowlist with
 * `builtinAgentToolIds()` and silently drop the rest, so the persona loaded and
 * could call NOTHING (pure theater). The only node→chat-tool bridge
 * (`PROJECTABLE_COMPUTE_NODE_TYPE_IDS`) is deliberately restricted to pure
 * compute nodes — the funnels nodes are `ctx.features.funnels`-backed, so they
 * are excluded by design. The sanctioned "chat-drivability = agent + nodes"
 * path is `registerFeatureAgentTool` (the `goals`/`app-builder`/`slides`
 * precedent): these tools call the SAME service functions the REST routes call,
 * behind the SAME authorization primitives (`resolveEffectiveAccess` scopes,
 * org-in-tenant IDOR guard) that `requireOrgScope` enforces for the HTTP path.
 *
 * Clean ids (`openwop:funnels.*`, the documents/app-builder convention) — NOT
 * the old node-typeId-shaped ids, which never resolved, so nothing depends on
 * them, and the node-projection namespace (`openwop:<typeId>`) stays unambiguous.
 *
 * Draft-only firewall (surface.ts §1-9, "agent proposes, human disposes"):
 *  - reads (`list`/`get`/`step-stats`) FAIL EMPTY without an acting user — a
 *    scheduled/system turn with no human principal never enumerates workspace
 *    funnels or stats (the `goals` read-tool discipline);
 *  - the write (`draft`) creates/updates DRAFT funnels only: `create` always
 *    yields `status:'draft'` (funnelsService), and the update path REFUSES a
 *    published funnel (that is the human-owned public surface). No publish /
 *    unpublish / archive / experiment tool is EVER registered here.
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { listOrgs, resolveEffectiveAccess } from '../../host/accessControlService.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { listFunnels, getFunnel, createFunnel, updateFunnel } from './funnelsService.js';
import { getFunnelStats } from './funnelStats.js';

export const FUNNELS_LIST_TOOL_ID = 'openwop:funnels.list';
export const FUNNELS_GET_TOOL_ID = 'openwop:funnels.get';
export const FUNNELS_STEP_STATS_TOOL_ID = 'openwop:funnels.step-stats';
export const FUNNELS_DRAFT_TOOL_ID = 'openwop:funnels.draft';

type ToolResult = { content: string; isError?: boolean };

/** Structured tool error — the agent loop surfaces `content` verbatim to the
 *  model, so the message must be actionable (what failed, what to do next). */
function toolError(error: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return { content: JSON.stringify({ error, message, ...(extra ?? {}) }), isError: true };
}

const ok = (payload: unknown): ToolResult => ({ content: JSON.stringify(payload) });

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Per-call toggle honesty (ADR 0308 D2): per-tenant, dynamic, fail-closed. */
async function funnelsEnabled(tenantId: string, actingUserId: string | undefined): Promise<boolean> {
  const assignment = await resolveOne('funnels', { tenantId, ...(actingUserId ? { userId: actingUserId } : {}) }).catch(() => null);
  return Boolean(assignment?.enabled);
}

/**
 * B2 — the ONE authority predicate the agent tools share, mirroring the SAME
 * decision the REST routes' `authorizeOrgScope` → `requireOrgScope` makes: the
 * org must exist IN the caller's tenant (IDOR guard) and the acting subject must
 * hold the required RFC 0049 scope for it (`resolveEffectiveAccess`, the exact
 * primitive `requireOrgScope` calls). Resolves an implicit sole org so the model
 * need not name one in the common single-org workspace (the app-builder
 * `resolveOrgScope` precedent). The acting user is asserted by the CALLER before
 * this runs (reads fail empty / writes fail typed), so it is passed in non-null.
 */
async function assertFunnelsOrgAccess(
  scope: BundleScope,
  actingUserId: string,
  orgIdInput: string | undefined,
  mode: 'workspace:read' | 'workspace:write',
): Promise<{ orgId: string } | ToolResult> {
  const orgs = await listOrgs(scope.tenantId);
  const orgId = orgIdInput ?? (orgs.length === 1 ? orgs[0]!.orgId : undefined);
  if (!orgId) {
    return toolError('org_required', `This workspace has ${orgs.length} organizations — pass \`orgId\` (ask the user which).`);
  }
  if (!orgs.some((o) => o.orgId === orgId)) return toolError('not_found', 'Organization not found in this workspace.');
  const access = await resolveEffectiveAccess(scope.tenantId, { subject: actingUserId, orgId });
  if (!access.scopes.includes(mode)) {
    return toolError('forbidden_scope', `The user does not have ${mode === 'workspace:write' ? 'write' : 'read'} access to that organization.`);
  }
  return { orgId };
}

/** Compact per-step totals over the derived CDP-backed day rows — the shape a
 *  planning agent needs (surface.ts stepStats parity). */
function projectStepTotals(days: Awaited<ReturnType<typeof getFunnelStats>>): {
  steps: Record<string, { views: number; completions: number; revenue: number; orders: number }>;
  days: number;
} {
  const steps: Record<string, { views: number; completions: number; revenue: number; orders: number }> = {};
  for (const row of days) {
    for (const [stepId, cell] of Object.entries(row.steps)) {
      const t = (steps[stepId] ??= { views: 0, completions: 0, revenue: 0, orders: 0 });
      t.views += cell.views; t.completions += cell.completions; t.revenue += cell.revenue; t.orders += cell.orders;
    }
  }
  return { steps, days: days.length };
}

export function registerFunnelsAgentTools(): void {
  // ── Reads — ground before proposing. FAIL EMPTY without an acting user. ────
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: FUNNELS_LIST_TOOL_ID,
      description:
        'List this workspace\'s sales funnels (id, name, slug, status, step count). '
        + 'Call it first to find the funnel the user means before reading or editing one. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' },
        },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      // Read tool: no acting user OR the feature disabled → EMPTY, not typed (the
      // model just sees no funnels; the loop is not derailed). Writes stay typed.
      if (!scope.actingUserId || !(await funnelsEnabled(scope.tenantId, scope.actingUserId))) return ok({ funnels: [] });
      const access = await assertFunnelsOrgAccess(scope, scope.actingUserId, str(input.orgId), 'workspace:read');
      if ('content' in access) return access;
      const funnels = (await listFunnels(scope.tenantId, access.orgId)).map((f) => ({
        funnelId: f.funnelId, name: f.name, slug: f.slug, status: f.status, steps: f.steps.length,
      }));
      return ok({ funnels });
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: FUNNELS_GET_TOOL_ID,
      description:
        'Read ONE funnel in full — its status and ordered steps (each step\'s kind, CMS pageId, name, and routing). '
        + 'Call it before proposing a revised step list so you edit what actually exists. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          funnelId: { type: 'string', description: 'The funnel id (from openwop:funnels.list).' },
          orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' },
        },
        required: ['funnelId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      // Read tool: no acting user OR the feature disabled → EMPTY, not typed.
      if (!scope.actingUserId || !(await funnelsEnabled(scope.tenantId, scope.actingUserId))) return ok({ funnel: null });
      const funnelId = str(input.funnelId);
      if (!funnelId) return toolError('validation_error', 'Field `funnelId` is required.');
      const access = await assertFunnelsOrgAccess(scope, scope.actingUserId, str(input.orgId), 'workspace:read');
      if ('content' in access) return access;
      const funnel = await getFunnel(scope.tenantId, access.orgId, funnelId);
      if (!funnel) return toolError('not_found', 'Funnel not found in this workspace.');
      return ok({
        funnel: {
          funnelId: funnel.funnelId, name: funnel.name, slug: funnel.slug, status: funnel.status,
          steps: funnel.steps.map((s) => ({ stepId: s.stepId, kind: s.kind, pageId: s.pageId, ...(s.name ? { name: s.name } : {}), ...(s.routing ? { routing: s.routing } : {}) })),
        },
      });
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: FUNNELS_STEP_STATS_TOOL_ID,
      description:
        'Read per-step conversion stats for a funnel (views, completions, revenue, orders per step, over the recent '
        + 'event window). Use it to find the weakest step before recommending a change — ground every claim in these '
        + 'numbers; call out low-traffic steps instead of over-reading noise. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          funnelId: { type: 'string', description: 'The funnel id (from openwop:funnels.list).' },
          orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' },
        },
        required: ['funnelId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      // Read tool: no acting user OR the feature disabled → EMPTY, not typed.
      if (!scope.actingUserId || !(await funnelsEnabled(scope.tenantId, scope.actingUserId))) return ok({ steps: {}, days: 0 });
      const funnelId = str(input.funnelId);
      if (!funnelId) return toolError('validation_error', 'Field `funnelId` is required.');
      const access = await assertFunnelsOrgAccess(scope, scope.actingUserId, str(input.orgId), 'workspace:read');
      if ('content' in access) return access;
      const funnel = await getFunnel(scope.tenantId, access.orgId, funnelId);
      if (!funnel) return toolError('not_found', 'Funnel not found in this workspace.');
      const days = await getFunnelStats(scope.tenantId, access.orgId, funnelId);
      return ok({ funnelId, ...projectStepTotals(days) });
    },
  });

  // ── Write — DRAFT-ONLY. Create or revise a draft; publish stays human. ─────
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: FUNNELS_DRAFT_TOOL_ID,
      description:
        'Draft a funnel for human review: with no `funnelId`, CREATE a new draft funnel; with a `funnelId`, revise an '
        + 'existing DRAFT funnel\'s step list. Every step must reference an existing CMS page in this workspace '
        + '(`pageId`) — if the page does not exist, ask the user to create it in the Page Builder (you cannot author '
        + 'pages). The result ALWAYS stays an unpublished draft; you can never publish, and you cannot edit a funnel '
        + 'that is already published (ask the user to unpublish it first).',
      inputSchema: {
        type: 'object',
        properties: {
          funnelId: { type: 'string', description: 'Omit to create a new draft; provide to revise an existing DRAFT funnel.' },
          name: { type: 'string', description: 'Funnel name (required when creating).' },
          slug: { type: 'string', description: 'Optional public slug; derived from the name when omitted.' },
          steps: {
            type: 'array',
            description: 'Ordered steps. Each: { kind: landing|optin|sales|checkout|upsell|downsell|thankyou, pageId, name?, routing? }.',
            items: { type: 'object', additionalProperties: true },
          },
          orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' },
        },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const actingUserId = scope.actingUserId;
      if (!actingUserId) {
        return toolError('acting_user_required', 'Funnels can only be drafted from a human-initiated turn.');
      }
      if (!(await funnelsEnabled(scope.tenantId, scope.actingUserId))) {
        return toolError('feature_disabled', 'The Funnels feature is not enabled for this workspace.');
      }
      const access = await assertFunnelsOrgAccess(scope, actingUserId, str(input.orgId), 'workspace:write');
      if ('content' in access) return access;
      const { orgId } = access;

      try {
        const funnelId = str(input.funnelId);
        if (funnelId) {
          // Revise an existing funnel — read before write, and DRAFT-ONLY:
          // a published funnel is the human-owned public surface.
          const existing = await getFunnel(scope.tenantId, orgId, funnelId);
          if (!existing) return toolError('not_found', 'Funnel not found in this workspace.');
          if (existing.status !== 'draft') {
            return toolError(
              'not_draft',
              `This funnel is ${existing.status}; I only edit drafts. Ask the user to unpublish it first, or I can draft a new funnel instead.`,
            );
          }
          const updated = await updateFunnel(scope.tenantId, orgId, funnelId, {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.slug !== undefined ? { slug: input.slug } : {}),
            ...(input.steps !== undefined ? { steps: input.steps } : {}),
          });
          if (!updated) return toolError('not_found', 'Funnel not found in this workspace.');
          return ok({ funnelId: updated.funnelId, slug: updated.slug, status: updated.status, steps: updated.steps.length, proposed: true });
        }
        // Create a new draft (createFunnel always yields status:'draft'). The
        // OWNER is the initiating human (ADR 0045), not the agent.
        const created = await createFunnel({
          tenantId: scope.tenantId, orgId, createdBy: actingUserId,
          name: input.name, slug: input.slug, steps: input.steps,
        });
        return ok({ funnelId: created.funnelId, slug: created.slug, status: created.status, steps: created.steps.length, proposed: true });
      } catch (err) {
        // Closed-world validation defects come back typed + verbatim so the loop
        // can repair (bad step kind, missing pageId, dangling route, slug clash).
        if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
          return toolError(String((err as { code: unknown }).code), String((err as { message: unknown }).message));
        }
        throw err;
      }
    },
  });
}
