/**
 * CFP-1 (chat-first port review E1) — the Campaign Strategist's REAL tools.
 *
 * The audit found the same shape as ADR 0358's founding incident: the Campaign
 * Strategist agent pack allowlisted `openwop:core.coordination.canvasRead` and
 * `openwop:feature.campaign-studio.nodes.render` — a phantom builtin and a raw
 * node typeId that NO host registrant provides — so the chat tool loop
 * intersected the allowlist to EMPTY, the persona could call nothing, and no
 * `canvas.campaign` artifact was ever produced from chat. The flagship "design a
 * multi-channel campaign by chatting with the Campaign Strategist" was theater.
 *
 * These two tools (the ADR 0308 D2 feature-registered-builtin seam, the
 * app-builder `catalog → get-design → render` trio applied one canvas type over)
 * make the exchange real:
 *
 *  - `openwop:campaign-studio.get-design` — the model READS the current
 *    `canvas.campaign` JSON (+ the CAS version) before revising an existing
 *    campaign; no blind re-authoring (the port map's read-before-write invariant
 *    that could not even run before).
 *  - `openwop:campaign-studio.render` — the model's proposed campaign is
 *    normalized through the SAME `feature.campaign-studio.nodes.render` node the
 *    run path uses (ONE gate), validated closed-world with `validateCampaignDoc`
 *    (errors return as structured `isError` results the agent loop feeds back —
 *    the repair loop), then persisted as a real tenant canvas: `createCanvasForTenant`
 *    with a deterministic idempotency key inside a run, or `updateCanvasForTenant`
 *    CAS on update (typed 409 on a concurrent edit, never a clobber).
 *
 * Gates mirror the HTTP editor path (`canvasEditorRoutes` → `authorizeOrgScope`):
 * per-call `campaign-studio` toggle (fail-closed), acting user required, org RBAC
 * via the same `resolveEffectiveAccess` scopes (write = workspace:write, read =
 * workspace:read). Host-side only — no new wire, no RFC.
 */
import { createHash } from 'node:crypto';
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { listOrgs, resolveEffectiveAccess } from '../../host/accessControlService.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { getNodeRegistry } from '../../executor/nodeRegistry.js';
import { createCanvasForTenant, getCanvasForTenant, updateCanvasForTenant } from '../../host/canvasSurface.js';
import { OpenwopError } from '../../types.js';
import { validateCampaignDoc } from './validateCampaignDoc.js';

export const CAMPAIGN_STUDIO_RENDER_TOOL_ID = 'openwop:campaign-studio.render';
export const CAMPAIGN_STUDIO_GET_DESIGN_TOOL_ID = 'openwop:campaign-studio.get-design';

const CAMPAIGN_CANVAS_TYPE = 'canvas.campaign';
const RENDER_NODE_TYPE_ID = 'feature.campaign-studio.nodes.render';

type ToolResult = { content: string; isError?: boolean };

/** Structured tool error — the agent loop surfaces `content` verbatim to the
 *  model, so the message must be actionable (what failed, what to do next). */
function toolError(error: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return { content: JSON.stringify({ error, message, ...(extra ?? {}) }), isError: true };
}

/** Per-call toggle honesty (ADR 0308 D2): per-tenant, dynamic, fail-closed. */
async function campaignStudioEnabled(tenantId: string, actingUserId: string | undefined): Promise<boolean> {
  const assignment = await resolveOne('campaign-studio', { tenantId, ...(actingUserId ? { userId: actingUserId } : {}) }).catch(() => null);
  return Boolean(assignment?.enabled);
}

/** The same org resolution + RBAC the HTTP editor path enforces via
 *  `authorizeOrgScope`: explicit `orgId`, else the workspace's sole org; with
 *  several orgs the model must name one. Read tools fail EMPTY without an acting
 *  user (tenant rows never leak to system runs). */
async function resolveOrgScope(
  scope: BundleScope,
  orgIdInput: string | undefined,
  needed: 'workspace:read' | 'workspace:write',
): Promise<{ orgId: string; actingUserId: string } | ToolResult> {
  const actingUserId = scope.actingUserId;
  if (!actingUserId) {
    return toolError('acting_user_required', 'Campaigns can only be read or written from a human-initiated turn.');
  }
  const orgs = await listOrgs(scope.tenantId);
  const orgId = orgIdInput ?? (orgs.length === 1 ? orgs[0]!.orgId : undefined);
  if (!orgId) {
    return toolError('org_required', `This workspace has ${orgs.length} organizations — pass \`orgId\` (ask the user which).`);
  }
  if (!orgs.some((o) => o.orgId === orgId)) return toolError('not_found', 'Organization not found in this workspace.');
  const access = await resolveEffectiveAccess(scope.tenantId, { subject: actingUserId, orgId });
  if (!access.scopes.includes(needed)) {
    return toolError('forbidden_scope', `The user does not have ${needed === 'workspace:write' ? 'write' : 'read'} access to that organization.`);
  }
  return { orgId, actingUserId };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

interface RenderCampaignArgs {
  campaign: unknown;
  canvasId?: string | undefined;
  baseVersion?: number | undefined;
  ownerSubject: { kind: 'user'; id: string };
  producedBy: Record<string, unknown>;
  runId?: string | undefined;
  capturedBy: string;
}

type RenderCampaignResult =
  | { ok: true; canvasId: string; version: number; channelCount: number; url: string; created: boolean; warnings?: { path: string; message: string }[] }
  | { ok: false; error: string; message: string; extra?: Record<string, unknown> };

const canvasUrl = (canvasId: string): string => `/campaign-studio/${encodeURIComponent(canvasId)}`;

/** normalize (the ONE render node) → closed-world validate → CAS-persist. Shared
 *  by create + update; mirrors app-builder's `renderDesign` pipeline. */
async function renderCampaign(tenantId: string, args: RenderCampaignArgs): Promise<RenderCampaignResult> {
  if (!args.campaign || typeof args.campaign !== 'object' || Array.isArray(args.campaign)) {
    return { ok: false, error: 'validation_error', message: '`campaign` must be the campaign object.' };
  }

  // ONE normalization gate: the same render node the run path executes (name +
  // channels required, closed enums, per-field caps) — the computeNodeTool
  // minimal-ctx pattern (the node is pure).
  const node = await getNodeRegistry().resolve(RENDER_NODE_TYPE_ID);
  if (!node) return { ok: false, error: 'host_capability_missing', message: 'The campaign render node pack is not loaded on this host.' };
  let payload: Record<string, unknown>;
  let channelCount = 0;
  try {
    const outcome = await node.execute({
      runId: `agent-tool:${tenantId}`,
      nodeId: RENDER_NODE_TYPE_ID,
      tenantId,
      inputs: { campaign: args.campaign },
      config: {},
      configurable: {},
      attempt: 1,
      secrets: {},
      emit: async () => ({ eventId: '', sequence: 0 }),
    });
    if (outcome.status !== 'success') {
      const detail = outcome.status === 'failure' ? outcome.error : null;
      // R2 CS-SP-2 — the repair loop needs the SPECIFIC failure (which value,
      // which allowlist), not a generic sentence: the node now names the
      // unknown enum + its options, so surface its message verbatim.
      const nodeMsg = detail && typeof detail === 'object' && typeof (detail as { message?: unknown }).message === 'string'
        ? (detail as { message: string }).message
        : null;
      return { ok: false, error: 'validation_error', message: nodeMsg ?? 'The campaign failed structural normalization — fix and call again.', extra: { detail } };
    }
    const out = (outcome.outputs as { artifact?: { payload?: Record<string, unknown> }; channelCount?: number }) ?? {};
    if (!out.artifact?.payload) return { ok: false, error: 'render_failed', message: 'The render node returned no campaign payload.' };
    payload = out.artifact.payload;
    channelCount = typeof out.channelCount === 'number' ? out.channelCount : 0;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, error: err.code ?? 'validation_error', message: `${err.message ?? 'the campaign failed normalization'} — fix the campaign and call again.` };
  }

  // Closed-world validation — the SAME gate the editor PATCH enforces
  // (`validateCampaignDoc`), now at authoring time so the model gets the defects
  // while it can still react (the repair loop).
  const v = validateCampaignDoc(payload);
  // ADR 0727 D2 — soft cross-facet warnings ride back to the MODEL on success. The editor
  // already gets them (the `savedWithWarnings` toast); the model that just AUTHORED the doc
  // did not, and it is the primary author here. Capped at 10, mirroring the error slice
  // below: `assets` allows 60, and this tool is not `schemaCarrying`, so its result is
  // compaction-eligible (`host/toolResultTransform.ts`).
  const warnings = v.warnings.slice(0, 10);
  if (v.errors.length) {
    return {
      ok: false,
      error: 'campaign_validation_failed',
      message: 'The campaign violates the campaign schema — fix these and call again.',
      extra: { errors: v.errors.slice(0, 10) },
    };
  }

  if (args.canvasId) {
    // Update = the governed CAS write owner (`updateCanvasForTenant`, the editor
    // PATCH path) with the type-pin the routes enforce: wrong type / cross-tenant
    // = uniform not_found, never a clobber of another canvas type.
    const baseVersion = Number(args.baseVersion);
    if (!Number.isInteger(baseVersion) || baseVersion < 1) {
      return { ok: false, error: 'validation_error', message: 'Updating an existing campaign requires `baseVersion` — read it with the get-design tool first.' };
    }
    const existing = await getCanvasForTenant(tenantId, args.canvasId);
    if (!existing || existing.canvasTypeId !== CAMPAIGN_CANVAS_TYPE) {
      return { ok: false, error: 'not_found', message: `Campaign '${args.canvasId}' not found in this workspace.` };
    }
    try {
      const applied = await updateCanvasForTenant(tenantId, args.canvasId, payload, {
        expectedVersion: baseVersion,
        merge: 'replace',
        snapshot: { capturedBy: args.capturedBy },
      });
      if (!applied) return { ok: false, error: 'not_found', message: `Campaign '${args.canvasId}' not found in this workspace.` };
      return { ok: true, canvasId: applied.canvasId, version: applied.newVersion, channelCount, url: canvasUrl(applied.canvasId), created: false, ...(warnings.length ? { warnings } : {}) };
    } catch (e) {
      if (e instanceof OpenwopError && e.code === 'canvas_version_conflict') {
        return { ok: false, error: 'canvas_version_conflict', message: 'Someone edited this campaign since you read it — call get-design again and re-apply your changes on the new version.' };
      }
      const err = e as { code?: string; message?: string };
      return { ok: false, error: err.code ?? 'update_failed', message: err.message ?? 'the update failed' };
    }
  }

  // Create — deterministic idempotency inside a run (the ADR 0308 GD-0308-1
  // rule): an exact retry short-circuits; a different campaign in the same run
  // hashes to a new key. Calls without a runId keep the random id.
  const idempotencyKey = args.runId
    ? createHash('sha256').update([args.runId, CAMPAIGN_STUDIO_RENDER_TOOL_ID, JSON.stringify(payload)].join('\u0000')).digest('hex').slice(0, 32)
    : undefined;
  const created = await createCanvasForTenant(tenantId, {
    canvasTypeId: CAMPAIGN_CANVAS_TYPE,
    ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
    ownerSubject: args.ownerSubject,
    initialState: payload,
    metadata: { producedBy: args.producedBy, ...(args.runId ? { runId: args.runId } : {}) },
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
  return { ok: true, canvasId: created.canvasId, version: created.version, channelCount, url: canvasUrl(created.canvasId), created: true, ...(warnings.length ? { warnings } : {}) };
}

export function registerCampaignStudioAgentTools(): void {
  // ── The campaign-state read path: the model READS the current campaign. ──
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    // ADR 0604 (TOCC-2) — closed world: an elided enum/id list here makes the
    // model author against a catalog that is not this host's.
    schemaCarrying: true,
    def: {
      name: CAMPAIGN_STUDIO_GET_DESIGN_TOOL_ID,
      description:
        'Read the CURRENT campaign JSON (and its version) for an existing Campaign Studio canvas. Call this before '
        + 'revising a campaign the user references so you edit the REAL current channels/funnel/assets — then pass the '
        + 'returned `version` as `baseVersion` to the render tool when updating.',
      inputSchema: {
        type: 'object',
        properties: {
          canvasId: { type: 'string', description: 'The Campaign Studio canvas id (from a render result or the user).' },
          orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' },
        },
        required: ['canvasId'],
      },
    },
    async run(input, scope) {
      if (!(await campaignStudioEnabled(scope.tenantId, scope.actingUserId))) {
        return toolError('feature_disabled', 'The Campaign Studio feature is not enabled for this workspace — tell the user you cannot design campaigns here.');
      }
      // Read tool: fail EMPTY (not typed) without an acting user — a system turn
      // has no tenant rows to read, but the loop must not be derailed. Writes
      // (render) stay typed via resolveOrgScope's acting_user_required.
      if (!scope.actingUserId) return { content: JSON.stringify({ campaign: null }) };
      const gate = await resolveOrgScope(scope, str(input.orgId), 'workspace:read');
      if ('content' in gate) return gate;
      const canvasId = str(input.canvasId);
      if (!canvasId) return toolError('validation_error', '`canvasId` is required.');
      const canvas = await getCanvasForTenant(scope.tenantId, canvasId);
      if (!canvas || canvas.canvasTypeId !== CAMPAIGN_CANVAS_TYPE) {
        return toolError('not_found', `Campaign '${canvasId}' not found in this workspace.`);
      }
      return {
        content: JSON.stringify({
          canvasId,
          version: canvas.version,
          campaign: canvas.state,
          url: canvasUrl(canvasId),
        }),
      };
    },
  });

  // ── The deliverable path: normalize → validate → persist → real reference. ──
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CAMPAIGN_STUDIO_RENDER_TOOL_ID,
      description:
        'Render a multi-channel campaign you composed into a REAL Campaign Studio canvas the user can open and edit — it '
        + 'appears inline in the chat. Pass the full campaign as `campaign`: { name, objective?, audience?, channels: '
        + '[{ name, type, tactic?, budget? }], funnel?: [{ stage, description?, kpis? }], assets?: [{ channel?, format?, '
        + 'headline?, body?, cta? }] }. `channels` is required (≥1); channel `type` ∈ email|social|search|display|content|'
        + 'sms|events|pr; funnel `stage` ∈ awareness|consideration|conversion|retention|advocacy. Returns { canvasId, url, '
        + 'channelCount } — tell the user the campaign name and give them the url. On a validation error, fix the reported '
        + 'issues and call again. To UPDATE an existing campaign, pass its `canvasId` + the `baseVersion` from get-design.',
      inputSchema: {
        type: 'object',
        properties: {
          campaign: { type: 'object', description: 'The full campaign document (see the description for the shape and closed enums).' },
          canvasId: { type: 'string', description: 'Existing campaign canvas to update (omit to create a new one).' },
          baseVersion: { type: 'number', description: 'The version the update is based on (from get-design) — required with canvasId.' },
          orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' },
        },
        required: ['campaign'],
      },
    },
    async run(input, scope) {
      if (!(await campaignStudioEnabled(scope.tenantId, scope.actingUserId))) {
        return toolError('feature_disabled', 'The Campaign Studio feature is not enabled for this workspace — tell the user you cannot design campaigns here.');
      }
      const gate = await resolveOrgScope(scope, str(input.orgId), 'workspace:write');
      if ('content' in gate) return gate;
      // Provenance rides canvas `metadata` (the documents `producedBy`
      // precedent): the OWNER stays the human (ADR 0045 — a Subject confers no
      // authority), but an agent-produced campaign records which agent + the run.
      const producedBy = scope.agentProfileId
        ? { kind: 'agent', id: scope.agentProfileId }
        : { kind: 'user', id: gate.actingUserId };
      const result = await renderCampaign(scope.tenantId, {
        campaign: input.campaign,
        canvasId: str(input.canvasId),
        ...(input.baseVersion !== undefined ? { baseVersion: Number(input.baseVersion) } : {}),
        ownerSubject: { kind: 'user', id: gate.actingUserId },
        producedBy,
        runId: scope.runId,
        capturedBy: gate.actingUserId,
      });
      if (!result.ok) return toolError(result.error, result.message, result.extra);
      return {
        content: JSON.stringify({
          canvasId: result.canvasId,
          version: result.version,
          channelCount: result.channelCount,
          url: result.url,
          ...(result.warnings?.length ? { warnings: result.warnings } : {}),
          // ADR 0727 D2 — the note is the in-band instruction the model actually follows, so
          // a warnings field it never mentions would be decorative. When the campaign SAVED
          // but an asset points at a channel that does not exist, say so here.
          note: result.warnings?.length
            ? `Campaign ${result.created ? 'created' : 'updated'} and SAVED, but ${result.warnings.length} asset reference(s) name a channel that does not exist (see \`warnings\`). Either call the render tool again with the asset's \`channel\` corrected to one of the campaign's channel names, or tell the user which assets are unassigned. Give them the url either way.`
            : result.created
              ? 'Campaign created. Tell the user the campaign name and that they can open and edit it at the url.'
              : 'Campaign updated. Tell the user what changed and give them the url.',
        }),
      };
    },
  });
}
