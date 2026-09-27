/**
 * CFP-1 repair (CHAT-FIRST-PORT-AUDIT #1, port map docs/chat-first-port/c4-drawings-cad.md
 * rows 10 + 21) — the CAD Modeler's REAL tools, the ADR 0358 app-builder precedent
 * applied to the cad feature.
 *
 * The feature toggle advertises "generate them with the AI chat", but the agent
 * pack allowlisted the seven `openwop:feature.cad.nodes.*` node typeIds + a
 * `…canvasRead` node id — none of which any host registrant projects as a
 * conversational tool, so dispatch silently dropped them and the CAD Modeler
 * could emit nothing. These two tools make the headline exchange real:
 *
 *  - `openwop:cad.get-design` — the model READS the current model JSON (+ the
 *    CAS version) before revising; no blind re-authoring (the ADR 0358
 *    read-before-write rule — replaces the uncallable `canvasRead` claim).
 *  - `openwop:cad.render` — the model's parametric solids are normalized through
 *    the SAME `feature.cad.nodes.render` producer node the workflow chain runs
 *    (one gate; the render node's kinds match `validateCadDoc` exactly), validated
 *    closed-world (errors return as structured `isError` the loop feeds back —
 *    the repair loop), then persisted as a tenant `canvas.cad` via the canvas
 *    owner (CAS update or a deterministic-idempotency create).
 *
 * The six other node ids (mesh-import/export, bom-generate, dimension-suggest,
 * sketch-solve, material-recommend) are PRUNED from the allowlist, not faked:
 * mesh-import/export/bom are editor-toolbar + host-extension routes (real, and
 * not natural chat-generation verbs); dims/sketch/materials already exist as
 * editor-side compute — only their agent projection was theater. The port map
 * defers them to follow-on value, not this repair's honest-minimum set.
 *
 * Gates mirror the HTTP editor path (`canvasEditorRoutes` → `authorizeOrgScope`):
 * per-call `cad` toggle (fail-closed), acting user required for reads AND writes,
 * org RBAC via the same `resolveEffectiveAccess` scopes (write = workspace:write,
 * read = workspace:read).
 */
import { createHash } from 'node:crypto';
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveFeatureToggle } from '../../host/agentToolKit.js';
import { listOrgs, resolveEffectiveAccess } from '../../host/accessControlService.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { getNodeRegistry } from '../../executor/nodeRegistry.js';
import { createCanvasForTenant, getCanvasForTenant, updateCanvasForTenant } from '../../host/canvasSurface.js';
import { validateCadDoc, CAD_SOLID_KINDS } from './validateCadDoc.js';

export const CAD_GET_DESIGN_TOOL_ID = 'openwop:cad.get-design';
export const CAD_RENDER_TOOL_ID = 'openwop:cad.render';
const CAD_CANVAS_TYPE = 'canvas.cad';
const RENDER_NODE_TYPE_ID = 'feature.cad.nodes.render';

type ToolResult = { content: string; isError?: boolean };

/** Structured tool error — the agent loop surfaces `content` verbatim to the
 *  model, so the message must be actionable (what failed, what to do next). */
function toolError(error: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return { content: JSON.stringify({ error, message, ...(extra ?? {}) }), isError: true };
}

/** Per-call toggle honesty (ADR 0308 D2): per-tenant, dynamic, fail-closed. */
async function cadEnabled(scope: BundleScope): Promise<boolean> {
  return resolveFeatureToggle('cad', scope);
}

/** The same org resolution + RBAC the HTTP editor path enforces via
 *  `authorizeOrgScope`: explicit `orgId`, else the workspace's sole org; with
 *  several orgs the model must name one. Fails EMPTY (no acting user). */
async function resolveOrgScope(
  scope: BundleScope,
  orgIdInput: string | undefined,
  needed: 'workspace:read' | 'workspace:write',
): Promise<{ orgId: string; actingUserId: string } | ToolResult> {
  const actingUserId = scope.actingUserId;
  if (!actingUserId) {
    return toolError('acting_user_required', 'CAD models can only be read or generated from a human-initiated turn.');
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

/** Normalize a requested model through the feature's REAL producer node
 *  (structural normalization + fail-fast), then closed-world validate. Returns
 *  the persist-ready payload or a structured tool error. */
async function normalizeModel(tenantId: string, model: unknown): Promise<{ payload: Record<string, unknown>; solidCount: number } | ToolResult> {
  const node = await getNodeRegistry().resolve(RENDER_NODE_TYPE_ID);
  if (!node) return toolError('host_capability_missing', 'The cad render node pack is not loaded on this host.');
  let payload: Record<string, unknown>;
  let solidCount = 0;
  try {
    const outcome = await node.execute({
      runId: `agent-tool:${tenantId}`,
      nodeId: RENDER_NODE_TYPE_ID,
      tenantId,
      inputs: { model },
      config: {},
      configurable: {},
      attempt: 1,
      secrets: {},
      emit: async () => ({ eventId: '', sequence: 0 }),
    });
    if (outcome.status !== 'success') {
      const detail = outcome.status === 'failure' ? outcome.error : null;
      return toolError('validation_error', 'The model failed structural normalization — fix and call again.', { detail });
    }
    const out = (outcome.outputs as { artifact?: { payload?: Record<string, unknown> }; solidCount?: number }) ?? {};
    if (!out.artifact?.payload) return toolError('render_failed', 'The render node returned no model payload.');
    payload = out.artifact.payload;
    solidCount = typeof out.solidCount === 'number' ? out.solidCount : 0;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return toolError(err.code ?? 'validation_error', `${err.message ?? 'the model failed normalization'} — fix the model and call again.`);
  }
  // Closed-world validation — the gate the editor PATCH enforces, now AT
  // AUTHORING TIME so the model gets the defects while it can react (repair loop).
  const v = validateCadDoc(payload);
  if (v.errors.length) {
    return toolError('validation_error', 'The model violates its closed schema — fix these and call again.', { errors: v.errors.slice(0, 10) });
  }
  return { payload, solidCount };
}

export function registerCadAgentTools(): void {
  // ── The canvas-state read path: the model READS the current model. ────────
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    // ADR 0604 (TOCC-2) — closed world: an elided enum/id list here makes the
    // model author against a catalog that is not this host's.
    schemaCarrying: true,
    def: {
      name: CAD_GET_DESIGN_TOOL_ID,
      description:
        'Read the CURRENT parametric model JSON (and its version) for an existing CAD canvas. Call this BEFORE revising '
        + 'a model the user references so you modify what actually exists — then pass the returned `version` as '
        + '`baseVersion` to the render tool when updating.',
      inputSchema: {
        type: 'object',
        properties: {
          canvasId: { type: 'string', description: 'The CAD canvas id (from a render result or the user).' },
          orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' },
        },
        required: ['canvasId'],
      },
    },
    async run(input, scope) {
      if (!(await cadEnabled(scope))) {
        return toolError('feature_disabled', 'The CAD feature is not enabled for this workspace — tell the user you cannot make 3D models here.');
      }
      // Read tool: fail EMPTY (not typed) without an acting user — a system turn
      // has no tenant rows to read, but the loop must not be derailed. Writes
      // (render) stay typed via resolveOrgScope's acting_user_required.
      if (!scope.actingUserId) return { content: JSON.stringify({ model: null }) };
      const gate = await resolveOrgScope(scope, str(input.orgId), 'workspace:read');
      if ('content' in gate) return gate;
      const canvasId = str(input.canvasId);
      if (!canvasId) return toolError('validation_error', '`canvasId` is required.');
      const canvas = await getCanvasForTenant(scope.tenantId, canvasId);
      if (!canvas || canvas.canvasTypeId !== CAD_CANVAS_TYPE) {
        return toolError('not_found', `CAD model '${canvasId}' not found in this workspace.`);
      }
      return {
        content: JSON.stringify({
          canvasId,
          version: canvas.version,
          model: canvas.state,
          url: `/cad/${encodeURIComponent(canvasId)}`,
        }),
      };
    },
  });

  // ── The deliverable path: normalize → validate → persist → real reference. ─
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CAD_RENDER_TOOL_ID,
      description:
        'Render a parametric 3D model you composed into a REAL CAD canvas the user can open and edit. Pass the model as '
        + '`model`: { name?, units?, solids: [ ... ] }. Each solid is typed JSON (NOT a CAD script): '
        + `kind is one of ${CAD_SOLID_KINDS.join(', ')} `
        + '(box{width,height,depth}, cylinder/cone{radius,length}, sphere{radius}); all accept a position {x,y,z}, a '
        + '`color`, an optional `label`, and optional `rotation` (degrees), `materialId`, `metallic` and `roughness` '
        + '(0-1). This REPLACES the stored model rather than merging, so when revising, carry every field you were '
        + 'given back out — a dropped `rotation` also rewrites any angular dimension annotation. '
        + '(A `mesh` solid references an imported asset — do not invent an assetRef.) '
        + 'Returns { canvasId, url, version, solidCount } — tell the user the model name and give them the url. On a '
        + 'validation error, fix the reported issues and call again. To UPDATE an existing model, pass its `canvasId` + '
        + 'the `baseVersion` you read via the get-design tool.',
      inputSchema: {
        type: 'object',
        properties: {
          model: { type: 'object', description: 'The full parametric model ({ name?, units?, solids: [...] }).' },
          canvasId: { type: 'string', description: 'Existing CAD canvas to update (omit to create a new one).' },
          baseVersion: { type: 'number', description: 'The version the update is based on (from get-design) — required with canvasId.' },
          orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' },
        },
        required: ['model'],
      },
    },
    async run(input, scope) {
      if (!(await cadEnabled(scope))) {
        return toolError('feature_disabled', 'The CAD feature is not enabled for this workspace — tell the user you cannot make 3D models here.');
      }
      const gate = await resolveOrgScope(scope, str(input.orgId), 'workspace:write');
      if ('content' in gate) return gate;

      const normalized = await normalizeModel(scope.tenantId, input.model);
      if ('content' in normalized) return normalized;
      const { payload, solidCount } = normalized;
      const name = str(payload.name);

      const canvasId = str(input.canvasId);
      if (canvasId) {
        // Type-pinned load (the editor's F4 rule): a wrong-type canvas is a
        // uniform not_found — the agent can never overwrite another type.
        const existing = await getCanvasForTenant(scope.tenantId, canvasId);
        if (!existing || existing.canvasTypeId !== CAD_CANVAS_TYPE) {
          return toolError('not_found', `CAD model '${canvasId}' not found in this workspace.`);
        }
        const baseVersion = Number(input.baseVersion);
        if (!Number.isInteger(baseVersion) || baseVersion < 1) {
          return toolError('validation_error', 'Updating an existing model requires `baseVersion` — read it with the get-design tool first.');
        }
        try {
          const result = await updateCanvasForTenant(scope.tenantId, canvasId, payload, {
            expectedVersion: baseVersion,
            merge: 'replace',
            snapshot: { capturedBy: gate.actingUserId },
          });
          if (!result) return toolError('not_found', `CAD model '${canvasId}' not found in this workspace.`);
          return {
            content: JSON.stringify({
              canvasId: result.canvasId,
              version: result.newVersion,
              solidCount,
              url: `/cad/${encodeURIComponent(result.canvasId)}`,
              note: 'Model updated. Tell the user what changed and give them the url.',
            }),
          };
        } catch (e) {
          const err = e as { code?: string; message?: string };
          if (err.code === 'canvas_version_conflict') {
            return toolError('canvas_version_conflict', 'Someone edited this model since you read it — call get-design again and re-apply your changes on the new version.');
          }
          return toolError(err.code ?? 'update_failed', err.message ?? 'the update failed');
        }
      }

      // Create — deterministic idempotency inside a run (an exact retry
      // short-circuits; a different model in the same run hashes to a new key).
      // Provenance rides `metadata`; the OWNER stays the human (ADR 0045).
      const producedBy = scope.agentProfileId
        ? { kind: 'agent', id: scope.agentProfileId }
        : { kind: 'user', id: gate.actingUserId };
      const idempotencyKey = scope.runId
        ? createHash('sha256').update([scope.runId, CAD_RENDER_TOOL_ID, JSON.stringify(payload)].join(' ')).digest('hex').slice(0, 32)
        : undefined;
      const created = await createCanvasForTenant(scope.tenantId, {
        canvasTypeId: CAD_CANVAS_TYPE,
        ...(name ? { name } : {}),
        ownerSubject: { kind: 'user', id: gate.actingUserId },
        initialState: payload,
        metadata: { producedBy, ...(scope.runId ? { runId: scope.runId } : {}) },
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
      return {
        content: JSON.stringify({
          canvasId: created.canvasId,
          version: created.version,
          solidCount,
          url: `/cad/${encodeURIComponent(created.canvasId)}`,
          note: 'Model created. Tell the user the name and that they can open and edit it at the url.',
        }),
      };
    },
  });
}
