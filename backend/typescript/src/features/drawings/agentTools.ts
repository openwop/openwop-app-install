/**
 * CFP-1 repair (CHAT-FIRST-PORT-AUDIT #1, port map docs/chat-first-port/c4-drawings-cad.md
 * row 1) — the Illustrator's REAL tools, the ADR 0358 app-builder precedent applied
 * to the drawings feature.
 *
 * The feature toggle advertises "generate them with the AI chat", but the agent
 * pack allowlisted `openwop:feature.drawings.nodes.render` / `…canvasRead` — node
 * typeIds NO host registrant projects as a conversational tool, so dispatch
 * silently dropped them and the Illustrator could emit nothing (it resolved to
 * only the six generic baseline tools). These two tools make the exchange real:
 *
 *  - `openwop:drawings.get-design` — the model READS the current drawing JSON
 *    (+ the CAS version) before revising; no blind re-authoring (the ADR 0358
 *    read-before-write rule — replaces the uncallable `canvasRead` claim).
 *  - `openwop:drawings.render` — the model's scene is normalized through the
 *    SAME `feature.drawings.nodes.render` producer node the workflow chain runs
 *    (one gate), validated closed-world with `validateDrawingDoc` (errors return
 *    as structured `isError` the agent loop feeds back — the repair loop), then
 *    persisted as a tenant `canvas.drawing` via the canvas owner (CAS update or
 *    a deterministic-idempotency create).
 *
 * Gates mirror the HTTP editor path (`canvasEditorRoutes` → `authorizeOrgScope`):
 * per-call `drawings` toggle (fail-closed), acting user required for reads AND
 * writes, org RBAC via the same `resolveEffectiveAccess` scopes (write =
 * workspace:write, read = workspace:read).
 */
import { createHash } from 'node:crypto';
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveFeatureToggle } from '../../host/agentToolKit.js';
import { listOrgs, resolveEffectiveAccess } from '../../host/accessControlService.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { getNodeRegistry } from '../../executor/nodeRegistry.js';
import { createCanvasForTenant, getCanvasForTenant, updateCanvasForTenant } from '../../host/canvasSurface.js';
import { validateDrawingDoc, DRAWING_SHAPE_KINDS } from './validateDrawingDoc.js';

export const DRAWINGS_GET_DESIGN_TOOL_ID = 'openwop:drawings.get-design';
export const DRAWINGS_RENDER_TOOL_ID = 'openwop:drawings.render';
const DRAWING_CANVAS_TYPE = 'canvas.drawing';
const RENDER_NODE_TYPE_ID = 'feature.drawings.nodes.render';

type ToolResult = { content: string; isError?: boolean };

/** Structured tool error — the agent loop surfaces `content` verbatim to the
 *  model, so the message must be actionable (what failed, what to do next). */
function toolError(error: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return { content: JSON.stringify({ error, message, ...(extra ?? {}) }), isError: true };
}

/** Per-call toggle honesty (ADR 0308 D2): per-tenant, dynamic, fail-closed. */
async function drawingsEnabled(scope: BundleScope): Promise<boolean> {
  return resolveFeatureToggle('drawings', scope);
}

/** The same org resolution + RBAC the HTTP editor path enforces via
 *  `authorizeOrgScope`: explicit `orgId`, else the workspace's sole org; with
 *  several orgs the model must name one. Fails EMPTY (no acting user) exactly
 *  like the app-builder deliverable tools. */
async function resolveOrgScope(
  scope: BundleScope,
  orgIdInput: string | undefined,
  needed: 'workspace:read' | 'workspace:write',
): Promise<{ orgId: string; actingUserId: string } | ToolResult> {
  const actingUserId = scope.actingUserId;
  if (!actingUserId) {
    return toolError('acting_user_required', 'Drawings can only be read or generated from a human-initiated turn.');
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

/** Normalize a requested drawing through the feature's REAL producer node
 *  (structural normalization + fail-fast), then closed-world validate. Returns
 *  the persist-ready payload or a structured tool error. */
async function normalizeDrawing(tenantId: string, drawing: unknown): Promise<{ payload: Record<string, unknown>; shapeCount: number } | ToolResult> {
  const node = await getNodeRegistry().resolve(RENDER_NODE_TYPE_ID);
  if (!node) return toolError('host_capability_missing', 'The drawings render node pack is not loaded on this host.');
  let payload: Record<string, unknown>;
  let shapeCount = 0;
  try {
    const outcome = await node.execute({
      runId: `agent-tool:${tenantId}`,
      nodeId: RENDER_NODE_TYPE_ID,
      tenantId,
      inputs: { drawing },
      config: {},
      configurable: {},
      attempt: 1,
      secrets: {},
      emit: async () => ({ eventId: '', sequence: 0 }),
    });
    if (outcome.status !== 'success') {
      const detail = outcome.status === 'failure' ? outcome.error : null;
      return toolError('validation_error', 'The drawing failed structural normalization — fix and call again.', { detail });
    }
    const out = (outcome.outputs as { artifact?: { payload?: Record<string, unknown> }; shapeCount?: number }) ?? {};
    if (!out.artifact?.payload) return toolError('render_failed', 'The render node returned no drawing payload.');
    payload = out.artifact.payload;
    shapeCount = typeof out.shapeCount === 'number' ? out.shapeCount : 0;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return toolError(err.code ?? 'validation_error', `${err.message ?? 'the drawing failed normalization'} — fix the drawing and call again.`);
  }
  // Closed-world validation — the gate the editor PATCH enforces, now AT
  // AUTHORING TIME so the model gets the defects while it can react (repair loop).
  const v = validateDrawingDoc(payload);
  if (v.errors.length) {
    return toolError('validation_error', 'The drawing violates its closed schema — fix these and call again.', { errors: v.errors.slice(0, 10) });
  }
  return { payload, shapeCount };
}

export function registerDrawingsAgentTools(): void {
  // ── The canvas-state read path: the model READS the current drawing. ──────
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    // ADR 0604 (TOCC-2) — closed world: an elided enum/id list here makes the
    // model author against a catalog that is not this host's.
    schemaCarrying: true,
    def: {
      name: DRAWINGS_GET_DESIGN_TOOL_ID,
      description:
        'Read the CURRENT drawing JSON (and its version) for an existing drawing canvas. Call this BEFORE revising a '
        + 'drawing the user references so you modify what actually exists — then pass the returned `version` as '
        + '`baseVersion` to the render tool when updating.',
      inputSchema: {
        type: 'object',
        properties: {
          canvasId: { type: 'string', description: 'The drawing canvas id (from a render result or the user).' },
          orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' },
        },
        required: ['canvasId'],
      },
    },
    async run(input, scope) {
      if (!(await drawingsEnabled(scope))) {
        return toolError('feature_disabled', 'The Drawings feature is not enabled for this workspace — tell the user you cannot make drawings here.');
      }
      // Read tool: fail EMPTY (not typed) without an acting user — a system turn
      // has no tenant rows to read, but the loop must not be derailed. Writes
      // (render) stay typed via resolveOrgScope's acting_user_required.
      if (!scope.actingUserId) return { content: JSON.stringify({ drawing: null }) };
      const gate = await resolveOrgScope(scope, str(input.orgId), 'workspace:read');
      if ('content' in gate) return gate;
      const canvasId = str(input.canvasId);
      if (!canvasId) return toolError('validation_error', '`canvasId` is required.');
      const canvas = await getCanvasForTenant(scope.tenantId, canvasId);
      if (!canvas || canvas.canvasTypeId !== DRAWING_CANVAS_TYPE) {
        return toolError('not_found', `Drawing '${canvasId}' not found in this workspace.`);
      }
      return {
        content: JSON.stringify({
          canvasId,
          version: canvas.version,
          drawing: canvas.state,
          url: `/drawings/${encodeURIComponent(canvasId)}`,
        }),
      };
    },
  });

  // ── The deliverable path: normalize → validate → persist → real reference. ─
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: DRAWINGS_RENDER_TOOL_ID,
      description:
        'Render a vector drawing you composed into a REAL drawing canvas the user can open and edit. Pass the scene as '
        + '`drawing`: { title?, width?, height?, shapes: [ ... ] }. Each shape is typed JSON (NOT SVG markup): '
        + `kind is one of ${DRAWING_SHAPE_KINDS.filter((k) => k !== 'stroke' && k !== 'arrow' && k !== 'image').join(', ')} `
        + '(rect{x,y,width,height,rx?}, circle{cx,cy,r}, ellipse{cx,cy,rx,ry}, line{x1,y1,x2,y2}, polyline/polygon{points:[{x,y}]}, '
        + 'text{x,y,text,fontSize?}); all accept fill, stroke, strokeWidth, opacity (safe colors only). Returns '
        + '{ canvasId, url, version, shapeCount } — tell the user the drawing title and give them the url. On a validation '
        + 'error, fix the reported issues and call again. To UPDATE an existing drawing, pass its `canvasId` + the '
        + '`baseVersion` you read via the get-design tool.',
      inputSchema: {
        type: 'object',
        properties: {
          drawing: { type: 'object', description: 'The full drawing scene ({ title?, width?, height?, shapes: [...] }).' },
          canvasId: { type: 'string', description: 'Existing drawing canvas to update (omit to create a new one).' },
          baseVersion: { type: 'number', description: 'The version the update is based on (from get-design) — required with canvasId.' },
          orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' },
        },
        required: ['drawing'],
      },
    },
    async run(input, scope) {
      if (!(await drawingsEnabled(scope))) {
        return toolError('feature_disabled', 'The Drawings feature is not enabled for this workspace — tell the user you cannot make drawings here.');
      }
      const gate = await resolveOrgScope(scope, str(input.orgId), 'workspace:write');
      if ('content' in gate) return gate;

      const normalized = await normalizeDrawing(scope.tenantId, input.drawing);
      if ('content' in normalized) return normalized;
      const { payload, shapeCount } = normalized;
      const title = str(payload.title);

      const canvasId = str(input.canvasId);
      if (canvasId) {
        // Type-pinned load (the editor's F4 rule): a wrong-type canvas is a
        // uniform not_found — the agent can never overwrite another type.
        const existing = await getCanvasForTenant(scope.tenantId, canvasId);
        if (!existing || existing.canvasTypeId !== DRAWING_CANVAS_TYPE) {
          return toolError('not_found', `Drawing '${canvasId}' not found in this workspace.`);
        }
        const baseVersion = Number(input.baseVersion);
        if (!Number.isInteger(baseVersion) || baseVersion < 1) {
          return toolError('validation_error', 'Updating an existing drawing requires `baseVersion` — read it with the get-design tool first.');
        }
        try {
          const result = await updateCanvasForTenant(scope.tenantId, canvasId, payload, {
            expectedVersion: baseVersion,
            merge: 'replace',
            snapshot: { capturedBy: gate.actingUserId },
          });
          if (!result) return toolError('not_found', `Drawing '${canvasId}' not found in this workspace.`);
          return {
            content: JSON.stringify({
              canvasId: result.canvasId,
              version: result.newVersion,
              shapeCount,
              url: `/drawings/${encodeURIComponent(result.canvasId)}`,
              note: 'Drawing updated. Tell the user what changed and give them the url.',
            }),
          };
        } catch (e) {
          const err = e as { code?: string; message?: string };
          if (err.code === 'canvas_version_conflict') {
            return toolError('canvas_version_conflict', 'Someone edited this drawing since you read it — call get-design again and re-apply your changes on the new version.');
          }
          return toolError(err.code ?? 'update_failed', err.message ?? 'the update failed');
        }
      }

      // Create — deterministic idempotency inside a run (an exact retry
      // short-circuits; a different scene in the same run hashes to a new key).
      // Provenance rides `metadata`; the OWNER stays the human (ADR 0045).
      const producedBy = scope.agentProfileId
        ? { kind: 'agent', id: scope.agentProfileId }
        : { kind: 'user', id: gate.actingUserId };
      const idempotencyKey = scope.runId
        ? createHash('sha256').update([scope.runId, DRAWINGS_RENDER_TOOL_ID, JSON.stringify(payload)].join('\u0000')).digest('hex').slice(0, 32)
        : undefined;
      const created = await createCanvasForTenant(scope.tenantId, {
        canvasTypeId: DRAWING_CANVAS_TYPE,
        ...(title ? { name: title } : {}),
        ownerSubject: { kind: 'user', id: gate.actingUserId },
        initialState: payload,
        metadata: { producedBy, ...(scope.runId ? { runId: scope.runId } : {}) },
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
      return {
        content: JSON.stringify({
          canvasId: created.canvasId,
          version: created.version,
          shapeCount,
          url: `/drawings/${encodeURIComponent(created.canvasId)}`,
          note: 'Drawing created. Tell the user the title and that they can open and edit it at the url.',
        }),
      };
    },
  });
}
