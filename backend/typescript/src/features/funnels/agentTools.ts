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
import { listFunnels, getFunnel, createFunnel, updateFunnel, FUNNEL_STEP_KINDS } from './funnelsService.js';
import type { StartRunDeps } from '../../host/runStarter.js';
import { OpenwopError } from '../../types.js';
import { runnableBlueprints, FILLED_BY_GENERATE, FUNNEL_ARCHITECT_AGENT_ID } from './blueprints.js';
import { generateFunnelFromBlueprint } from './generateService.js';
import { surfaceDispatchedRun } from '../../host/turnRunDispatch.js';

import { getFunnelStats } from './funnelStats.js';
import { findCompactionMarkerPath, COMPACTION_MARKER_IN_INPUT } from '../../host/toolResultTransform.js';
import { untrustedToolError } from '../../host/agentToolKit.js';

export const FUNNELS_LIST_TOOL_ID = 'openwop:funnels.list';
export const FUNNELS_GET_TOOL_ID = 'openwop:funnels.get';
export const FUNNELS_STEP_STATS_TOOL_ID = 'openwop:funnels.step-stats';
export const FUNNELS_DRAFT_TOOL_ID = 'openwop:funnels.draft';
export const FUNNELS_BLUEPRINTS_TOOL_ID = 'openwop:funnels.blueprints';
export const FUNNELS_GENERATE_TOOL_ID = 'openwop:funnels.generate';

type ToolResult = { content: string; isError?: boolean; hostMessage?: true };

/** Structured tool error — the agent loop surfaces `content` verbatim to the
 *  model, so the message must be actionable (what failed, what to do next). */
function toolError(error: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return { content: JSON.stringify({ ...(extra ?? {}), error, message }), isError: true, hostMessage: true };
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

export function registerFunnelsAgentTools(deps: StartRunDeps): void {
  // ── Reads — ground before proposing. FAIL EMPTY without an acting user. ────
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    effect: 'read',
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
    effect: 'read',
    // ADR 0999 D3.1 (TOC2CD-3) — category (c), read-before-write: `steps` are
    // "the bindings a revision must keep", and `funnels.draft` with `funnelId`
    // REPLACES the whole list. Under `lossy` a funnel with more than five steps
    // reached the model as head + `{"_elided":N}` + tail; a revision that drops
    // the marker deletes the middle steps.
    schemaCarrying: true,
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
          steps: funnel.steps.map((s) => ({
            stepId: s.stepId, kind: s.kind, pageId: s.pageId, ...(s.name ? { name: s.name } : {}), ...(s.routing ? { routing: s.routing } : {}),
            // Read before write: the bindings a revision must keep (or deliberately clear).
            ...(s.offer ? { offer: s.offer } : {}), ...(s.webinar ? { webinar: s.webinar } : {}), ...(s.application ? { application: s.application } : {}),
          })),
        },
      });
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    effect: 'read',
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
    effect: 'write',
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
          campaignId: { type: 'string', description: 'Optional: link the funnel to a campaign of this organization (ADR 0941 canonical campaign id).' },
          steps: {
            type: 'array',
            description: `Ordered steps. Each: { kind: ${FUNNEL_STEP_KINDS.join('|')}, pageId, name?, routing?, offer?, webinar?, application? }. `
              + 'webinar (webinar only) = { marketingEventId } of a webinar of this organization; application (application only) = { formId } of a form of this organization. '
              + 'A webinar or application step\'s routing outcome is decided by the server (attendance; a qualification verdict), never by the visitor. '
              + 'offer (checkout|upsell|downsell only) = { productIds: 1-5 product ids, bumpProductIds?: 0-5 (checkout only), oneClickProductId?: (upsell|downsell only) }; '
              + 'every product must be an active product of this organization. Omit offer to keep a step\'s stored offer; null clears it.',
            items: { type: 'object', additionalProperties: true },
          },
          orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' },
        },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      // ADR 0999 D3.3 — the WRITER refuses a compaction marker (`{"_elided":N}`)
      // with a typed error rather than filtering it: a filtered marker persists a
      // SHORTENED list as if it were whole. The tool loop refuses it too under a
      // lossy decision; this holds on every path that reaches the writer. First, before
      // any read: it is a pure function of the input and reveals nothing.
      const marker = findCompactionMarkerPath(input);
      if (marker) return untrustedToolError(COMPACTION_MARKER_IN_INPUT, 'Input contains a tool-output compaction marker (its path is below): it stands for rows you were not shown. Re-read the full value and send every element.', marker);
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
            ...(input.campaignId !== undefined ? { campaignId: input.campaignId } : {}),
          });
          if (!updated) return toolError('not_found', 'Funnel not found in this workspace.');
          return ok({ funnelId: updated.funnelId, slug: updated.slug, status: updated.status, steps: updated.steps.length, proposed: true });
        }
        // Create a new draft (createFunnel always yields status:'draft'). The
        // OWNER is the initiating human (ADR 0045), not the agent.
        const created = await createFunnel({
          tenantId: scope.tenantId, orgId, createdBy: actingUserId,
          name: input.name, slug: input.slug, steps: input.steps,
          ...(input.campaignId !== undefined ? { campaignId: input.campaignId } : {}),
        });
        return ok({ funnelId: created.funnelId, slug: created.slug, status: created.status, steps: created.steps.length, proposed: true });
      } catch (err) {
        // Closed-world validation defects come back typed + verbatim so the loop
        // can repair (bad step kind, missing pageId, dangling route, slug clash).
        if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
          return untrustedToolError(String((err as { code: unknown }).code), 'The tool refused this call; the reason it gave is below.', String((err as { message: unknown }).message));
        }
        throw err;
      }
    },
  });

  // ── ADR 0948 P3a (D5) — blueprints: discover, then generate a DRAFT funnel. ──
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    effect: 'read',
    // The blueprint `parameters` are a schema the model must follow: never compacted.
    schemaCarrying: true,
    def: {
      name: FUNNELS_BLUEPRINTS_TOOL_ID,
      description:
        'List the funnel blueprints you can generate a draft funnel from (id, label, description, and each one\'s '
        + '`parameters` JSON Schema). `orgId`, `briefId` and `campaignId` are filled by generate; pass only the other '
        + 'parameters. An empty list means no blueprints are installed yet: draft the funnel with openwop:funnels.draft '
        + 'instead. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' },
        },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId || !(await funnelsEnabled(scope.tenantId, scope.actingUserId))) return ok({ blueprints: [] });
      const access = await assertFunnelsOrgAccess(scope, scope.actingUserId, str(input.orgId), 'workspace:read');
      if ('content' in access) return access;
      const blueprints = runnableBlueprints();
      return ok({
        blueprints,
        filledByGenerate: FILLED_BY_GENERATE,
        ...(blueprints.length === 0 ? { note: 'No funnel blueprints are installed yet.' } : {}),
      });
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    effect: 'write',
    def: {
      name: FUNNELS_GENERATE_TOOL_ID,
      description:
        'Generate a DRAFT funnel (its pages included) from a blueprint, for a CONFIRMED campaign brief: starts the '
        + 'blueprint run and returns its `runId`. Call openwop:funnels.blueprints first and pass that blueprint\'s own '
        + 'parameters as a JSON object in `paramsJson` (not orgId/briefId/campaignId). Read the brief with openwop:campaign-brief.get-brief '
        + 'first. The funnel stays a draft: you never publish; a person approves publishing.',
      inputSchema: {
        type: 'object',
        properties: {
          blueprintId: { type: 'string', description: 'A blueprint id from openwop:funnels.blueprints.' },
          briefId: { type: 'string', description: 'The confirmed campaign brief to build from.' },
          campaignId: { type: 'string', description: 'Optional: the campaign (of this organization, made from this brief) to link.' },
          paramsJson: { type: 'string', description: 'A JSON object of the blueprint\'s other parameters, per its `parameters` schema from openwop:funnels.blueprints (e.g. "{\\"headline\\":\\"Free guide\\"}").' },
          orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' },
        },
        required: ['blueprintId', 'briefId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const actingUserId = scope.actingUserId;
      if (!actingUserId) return toolError('acting_user_required', 'A funnel can only be generated from a human-initiated turn.');
      if (!(await funnelsEnabled(scope.tenantId, actingUserId))) return toolError('feature_disabled', 'The Funnels feature is not enabled for this workspace.');
      const access = await assertFunnelsOrgAccess(scope, actingUserId, str(input.orgId), 'workspace:write');
      if ('content' in access) return access;
      const blueprintId = str(input.blueprintId);
      const briefId = str(input.briefId);
      if (!blueprintId) return toolError('validation_error', 'Field `blueprintId` is required (from openwop:funnels.blueprints).');
      if (!briefId) return toolError('validation_error', 'Field `briefId` is required (a confirmed brief).');
      // A JSON string, not an open object: every tool must be expressible to every
      // provider (Gemini cannot declare a property-less object), and the real schema
      // reaches the model through openwop:funnels.blueprints.
      let params: Record<string, unknown> = {};
      const rawParams = str(input.paramsJson);
      if (rawParams) {
        let parsed: unknown;
        try { parsed = JSON.parse(rawParams); } catch { parsed = undefined; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return toolError('invalid_params', '`paramsJson` must be a JSON object of the blueprint\'s parameters.');
        }
        params = parsed as Record<string, unknown>;
      }
      try {
        const out = await generateFunnelFromBlueprint(deps, {
          tenantId: scope.tenantId, actingUserId, orgId: access.orgId, blueprintId, briefId,
          ...(str(input.campaignId) ? { campaignId: str(input.campaignId)! } : {}),
          params,
          ...(scope.conversationId ? { chatSessionId: scope.conversationId } : {}),
        });
        // Show the started run in the chat, like the other run-starting tools.
        if (out.started) {
          await surfaceDispatchedRun(scope, deps.storage, { runId: out.runId, agentId: scope.agentProfileId ?? FUNNEL_ARCHITECT_AGENT_ID, workflowId: blueprintId, workflowName: 'Funnel blueprint' }, 'funnels-generate');
        }
        return ok({ ...out, note: 'The run drafts the funnel and its pages; nothing is published.' });
      } catch (err) {
        // Typed refusals reach the model verbatim, so it can repair once (bad params,
        // an unconfirmed brief) or tell the user what is missing.
        if (err instanceof OpenwopError) {
          const code = typeof err.details?.code === 'string' ? err.details.code : err.code;
          return toolError(code, err.message, err.details?.errors ? { errors: err.details.errors } : err.details?.available ? { available: err.details.available } : undefined);
        }
        throw err;
      }
    },
  });
}

