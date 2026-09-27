/**
 * ADR 0358 — the App Architect's REAL tools (the ADR 0308 deliverable-tool
 * precedent, applied to the app builder's information exchange).
 *
 * Born of an audit finding with the same shape as ADR 0308's founding
 * incident: the App Architect agent pack allowlisted
 * `openwop:feature.app-builder.nodes.render` — a tool NO host registrant
 * provided — so every chat turn resolved zero tools and fell back to a plain
 * completion while the prompt claimed a render capability. These tools make
 * the exchange real and BIDIRECTIONAL:
 *
 *  - `openwop:app-builder.catalog` — the model REQUESTS the closed component
 *    catalog (types, props, enums, child constraints) instead of trusting a
 *    hand-copied prompt list (the drift class ADR 0358 retires).
 *  - `openwop:app-builder.get-design` — the model READS the current app JSON
 *    (+ the CAS version) before proposing changes; no blind re-authoring.
 *  - `openwop:app-builder.render` — the model's design is normalized through
 *    the SAME render node the workflow chain uses (one gate), validated
 *    closed-world with `validateAppDoc` (errors return as structured
 *    `isError` results the agent loop feeds back — the repair loop), then
 *    persisted as a tenant canvas; updates CAS through `surface.applyRepair`
 *    (ONE governed-write owner, never a second `updateCanvasForTenant` site).
 *
 * Clean ids (documents convention), NOT the node-typeId-shaped id the pack
 * used to allowlist: the old id never resolved, so nothing depends on it, and
 * the node-projection namespace (`openwop:<typeId>`) stays unambiguous.
 *
 * Draft-only posture (the `documents.draft` firewall classification): render
 * creates/updates tenant-store content — not code exec, not egress, not a
 * host-file write — so it is deliberately NOT in SENSITIVE_APPROVAL_TOOLS.
 * Gates mirror the HTTP editor path (`canvasEditorRoutes`): per-call
 * `app-builder` toggle (fail-closed), acting user required for writes, org
 * RBAC via the same `resolveEffectiveAccess` scopes (write = workspace:write,
 * read = workspace:read).
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveFeatureToggle } from '../../host/agentToolKit.js';
import { listOrgs, resolveEffectiveAccess } from '../../host/accessControlService.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { getCanvasForTenant } from '../../host/canvasSurface.js';
import { APP_BUILDER_CANVAS_TYPE, projectComponentCatalog } from './componentCatalog.js';
import { renderDesign } from './renderCore.js';

export const APP_BUILDER_RENDER_TOOL_ID = 'openwop:app-builder.render';
export const APP_BUILDER_CATALOG_TOOL_ID = 'openwop:app-builder.catalog';
export const APP_BUILDER_GET_DESIGN_TOOL_ID = 'openwop:app-builder.get-design';

type ToolResult = { content: string; isError?: boolean };

/** Structured tool error — the agent loop surfaces `content` verbatim to the
 *  model, so the message must be actionable (what failed, what to do next). */
function toolError(error: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return { content: JSON.stringify({ error, message, ...(extra ?? {}) }), isError: true };
}

/** Per-call toggle honesty (ADR 0308 D2): per-tenant, dynamic, fail-closed. */
async function appBuilderEnabled(scope: BundleScope): Promise<boolean> {
  return resolveFeatureToggle('app-builder', scope);
}

/** The same org resolution + RBAC the documents deliverable tools use (and the
 *  HTTP editor path enforces via `authorizeOrgScope`): explicit `orgId`, else
 *  the workspace's sole org; with several orgs the model must name one. */
async function resolveOrgScope(
  scope: BundleScope,
  orgIdInput: string | undefined,
  needed: 'workspace:read' | 'workspace:write',
): Promise<{ orgId: string; actingUserId: string } | ToolResult> {
  const actingUserId = scope.actingUserId;
  if (!actingUserId) {
    return toolError('acting_user_required', 'App designs can only be read or written from a human-initiated turn.');
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
  // The narrowed acting user rides back so call sites never need a non-null
  // assertion (grade pass XCH-CODE-2).
  return { orgId, actingUserId };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function registerAppBuilderAgentTools(): void {
  // ── The schema-request path: the model ASKS for the catalog. ─────────────
  registerFeatureAgentTool({
    // TRUSTED: returns projectComponentCatalog() — the host-authored CLOSED component
    // catalog. Same reasoning as slides.catalog; get-design/render stay untrusted
    // because they carry the USER's design.
    contentTrust: 'trusted',
    // ADR 0604 (TOCC-2) — closed world: an elided enum/id list here makes the
    // model author against a catalog that is not this host's.
    schemaCarrying: true,
    def: {
      name: APP_BUILDER_CATALOG_TOOL_ID,
      description:
        'Get the CLOSED component catalog for app designs — every component type with its props, enums, defaults, '
        + 'and container child-constraints. Call this BEFORE your first render in a conversation (and again if a '
        + 'render is rejected for an unknown type or prop). Types outside this catalog are rejected.',
      inputSchema: { type: 'object', properties: {} },
    },
    async run(_input, scope) {
      if (!(await appBuilderEnabled(scope))) {
        return toolError('feature_disabled', 'The App Builder feature is not enabled for this workspace — tell the user you cannot design apps here.');
      }
      return { content: JSON.stringify(projectComponentCatalog()) };
    },
  });

  // ── The app-state read path: the model READS the current design. ─────────
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    // ADR 0604 (TOCC-2) — closed world: an elided enum/id list here makes the
    // model author against a catalog that is not this host's.
    schemaCarrying: true,
    def: {
      name: APP_BUILDER_GET_DESIGN_TOOL_ID,
      description:
        'Read the CURRENT app design JSON (and its version) for an existing App Builder canvas. Call this before '
        + 'modifying an app the user references so you edit what actually exists — then pass the returned `version` '
        + 'as `baseVersion` to the render tool when updating.',
      inputSchema: {
        type: 'object',
        properties: {
          canvasId: { type: 'string', description: 'The App Builder canvas id (from a render result or the user).' },
          orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' },
        },
        required: ['canvasId'],
      },
    },
    async run(input, scope) {
      if (!(await appBuilderEnabled(scope))) {
        return toolError('feature_disabled', 'The App Builder feature is not enabled for this workspace.');
      }
      const gate = await resolveOrgScope(scope, str(input.orgId), 'workspace:read');
      if ('content' in gate) return gate;
      const canvasId = str(input.canvasId);
      if (!canvasId) return toolError('validation_error', '`canvasId` is required.');
      const canvas = await getCanvasForTenant(scope.tenantId, canvasId);
      if (!canvas || canvas.canvasTypeId !== APP_BUILDER_CANVAS_TYPE) {
        return toolError('not_found', `App Builder canvas '${canvasId}' not found in this workspace.`);
      }
      return {
        content: JSON.stringify({
          canvasId,
          version: canvas.version,
          app: canvas.state,
          url: `/app-builder/${encodeURIComponent(canvasId)}`,
        }),
      };
    },
  });

  // ── The deliverable path: validate → persist → return a real reference. ──
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: APP_BUILDER_RENDER_TOOL_ID,
      description:
        'Render an app design you composed into a REAL App Builder canvas the user can open and edit. Pass the full '
        + 'design as `app`: { name, description?, theme?, themeColors?, dataSources?, screens: [{ id, name, route?, '
        + 'isInitial?, x?, y?, components: [tree] }], connectors?: [{ from, to, trigger?, transition?, label? }] }. '
        + 'Component `type`s come ONLY from the catalog tool. Returns { canvasId, url, screenCount } — tell the user '
        + 'the app name and give them the url. On a validation error, fix the reported issues and call again. To '
        + 'UPDATE an existing design, pass its `canvasId` + the `baseVersion` you read via the get-design tool.',
      inputSchema: {
        type: 'object',
        properties: {
          app: { type: 'object', description: 'The full app design document (see the catalog tool for component schemas).' },
          canvasId: { type: 'string', description: 'Existing canvas to update (omit to create a new one).' },
          baseVersion: { type: 'number', description: 'The version the update is based on (from get-design) — required with canvasId.' },
          orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' },
        },
        required: ['app'],
      },
    },
    async run(input, scope) {
      if (!(await appBuilderEnabled(scope))) {
        return toolError('feature_disabled', 'The App Builder feature is not enabled for this workspace — tell the user you cannot design apps here.');
      }
      const gate = await resolveOrgScope(scope, str(input.orgId), 'workspace:write');
      if ('content' in gate) return gate;
      // Provenance rides canvas `metadata` (grade pass XCH-DATA-1, the
      // documents `producedBy` precedent): the OWNER stays the human (ADR
      // 0045 — a Subject confers no authority), but an agent-produced design
      // records which agent, and the run when there is one.
      const producedBy = scope.agentProfileId
        ? { kind: 'agent', id: scope.agentProfileId }
        : { kind: 'user', id: gate.actingUserId };
      // The normalize → validate → CAS-persist pipeline lives in renderCore
      // (ADR 0393 Phase 3 extraction) — ONE owner shared with the MCP control
      // lane; this handler contributes only the chat-session org-RBAC gate
      // above and the model-facing result phrasing below.
      const result = await renderDesign(scope.tenantId, {
        app: input.app,
        canvasId: str(input.canvasId),
        ...(input.baseVersion !== undefined ? { baseVersion: Number(input.baseVersion) } : {}),
        ownerSubject: { kind: 'user', id: gate.actingUserId },
        producedBy,
        runId: scope.runId,
      });
      if (!result.ok) return toolError(result.error, result.message, result.extra);
      return {
        content: JSON.stringify({
          canvasId: result.canvasId,
          version: result.version,
          screenCount: result.screenCount,
          url: result.url,
          note: result.created
            ? 'App design created. Tell the user the app name and that they can open and edit it at the url.'
            : 'Design updated. Tell the user what changed and give them the url.',
        }),
      };
    },
  });
}
