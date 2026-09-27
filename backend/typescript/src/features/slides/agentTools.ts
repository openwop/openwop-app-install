/**
 * Slides agent tools — the app-builder ADR 0358 trio ported to slides
 * (CFP-1 repair, CHAT-FIRST-PORT-AUDIT finding #1). Three registered tools give
 * the Slide Designer a REAL, bidirectional exchange, replacing the node-typeId-
 * shaped allowlist entries (`feature.slides.nodes.render` / `.restyle`) and the
 * generic `core.coordination.canvasRead/Write` ids that resolved to NOTHING at
 * dispatch (silently dropped — the agent was toothless):
 *
 *  - `openwop:slides.catalog` — the model REQUESTS the closed block catalog
 *    (types, props, enums, layouts, variants, themes, transitions) from the
 *    live SSoT instead of a hand-copied prompt list. (XCH-SLIDES-1, Wave 3.)
 *  - `openwop:slides.get-design` — the model READS an existing deck's JSON
 *    (+ the CAS version) before editing; no blind re-authoring.
 *  - `openwop:slides.render` — the model's deck is normalized through the SAME
 *    `feature.slides.nodes.render` node the design chain runs (one gate),
 *    validated closed-world with `validateSlidesDoc` (errors return as
 *    structured `isError` the agent loop feeds back — the repair loop), then
 *    persisted through the canvas-surface CAS (create with a deterministic
 *    idempotency key, or update via `expectedVersion` with a version snapshot
 *    so the editor's Compare stays honest).
 *
 * Clean ids (documents convention), NOT the node-typeId ids the pack used to
 * allowlist. Gates mirror the HTTP editor path (`registerSlidesEditorRoutes` →
 * `authorizeOrgScope`): per-call `slides` toggle (fail-closed), acting user
 * required for reads AND writes, org RBAC via the same `resolveEffectiveAccess`
 * scopes (write = workspace:write, read = workspace:read).
 */
import { createHash } from 'node:crypto';
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveFeatureToggle } from '../../host/agentToolKit.js';
import { listOrgs, resolveEffectiveAccess } from '../../host/accessControlService.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { getNodeRegistry } from '../../executor/nodeRegistry.js';
import { createCanvasForTenant, getCanvasForTenant, updateCanvasForTenant } from '../../host/canvasSurface.js';
import { SLIDES_CANVAS_TYPE } from './blockCatalog.js';
import { validateSlidesDoc } from './validateSlidesDoc.js';
import { slidesCatalogProjection } from './surface.js';

export const SLIDES_CATALOG_TOOL_ID = 'openwop:slides.catalog';
export const SLIDES_GET_DESIGN_TOOL_ID = 'openwop:slides.get-design';
export const SLIDES_RENDER_TOOL_ID = 'openwop:slides.render';

const RENDER_NODE_TYPE_ID = 'feature.slides.nodes.render';

type ToolResult = { content: string; isError?: boolean };

/** Structured tool error — the agent loop surfaces `content` verbatim to the
 *  model, so the message must be actionable (what failed, what to do next). */
function toolError(error: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return { content: JSON.stringify({ error, message, ...(extra ?? {}) }), isError: true };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Per-call toggle honesty (the app-builder ADR 0308 D2 pattern): per-tenant,
 *  dynamic, fail-closed — even though `slides` ships ON, the tool reads the
 *  live per-tenant assignment so a workspace that disabled it gets a typed no. */
async function slidesEnabled(scope: BundleScope): Promise<boolean> {
  return resolveFeatureToggle('slides', scope);
}

/** The same org resolution + RBAC the HTTP editor path enforces via
 *  `authorizeOrgScope` (→ `requireOrgScope` → `resolveEffectiveAccess`): explicit
 *  `orgId`, else the workspace's sole org; with several orgs the model must name
 *  one. Read/write fail EMPTY without an acting user (no tenant rows to a
 *  system run). */
async function resolveOrgScope(
  scope: BundleScope,
  orgIdInput: string | undefined,
  needed: 'workspace:read' | 'workspace:write',
): Promise<{ orgId: string; actingUserId: string } | ToolResult> {
  const actingUserId = scope.actingUserId;
  if (!actingUserId) {
    return toolError('acting_user_required', 'Decks can only be read or written from a human-initiated turn.');
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

/** Add the editor identity fields (`id`/`name`) the `canvas.slides` working copy
 *  requires (`validateSlidesDoc`) onto the render node's ARTIFACT payload, which
 *  is positional (no id/name) — the one place the editor doc diverges from the
 *  artifact schema (validateSlidesDoc DATA-CV-2). Deterministic positional ids
 *  keep updates stable across re-renders. */
function toEditorDeck(payload: Record<string, unknown>): Record<string, unknown> {
  const slidesIn = Array.isArray(payload.slides) ? payload.slides : [];
  const slides = slidesIn.map((raw, i) => {
    const s = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? (raw as Record<string, unknown>) : {};
    const name = str(s.title)?.slice(0, 200) ?? `Slide ${i + 1}`;
    return { id: `slide-${i + 1}`, name, ...s };
  });
  return {
    ...(typeof payload.title === 'string' ? { title: payload.title } : {}),
    ...(typeof payload.theme === 'string' ? { theme: payload.theme } : {}),
    slides,
  };
}

/** Normalize the model's deck through the REAL render node (the ONE gate the
 *  design chain uses), then closed-world validate. Returns the editor-shaped
 *  deck ready to persist, or a structured repair-loop error. */
async function normalizeAndValidate(
  tenantId: string,
  deck: unknown,
): Promise<{ ok: true; deck: Record<string, unknown>; slideCount: number } | ToolResult> {
  const node = await getNodeRegistry().resolve(RENDER_NODE_TYPE_ID);
  if (!node) return toolError('host_capability_missing', 'The slides render node pack is not loaded on this host.');
  let payload: Record<string, unknown>;
  try {
    const outcome = await node.execute({
      runId: `agent-tool:${tenantId}`,
      nodeId: RENDER_NODE_TYPE_ID,
      tenantId,
      inputs: { deck },
      config: {},
      configurable: {},
      attempt: 1,
      secrets: {},
      emit: async () => ({ eventId: '', sequence: 0 }),
    });
    if (outcome.status !== 'success') {
      const detail = outcome.status === 'failure' ? outcome.error : null;
      return toolError('validation_error', 'The deck failed structural normalization — fix and call again.', { detail });
    }
    const artifact = (outcome.outputs as { artifact?: { payload?: Record<string, unknown> } }).artifact;
    if (!artifact?.payload) return toolError('render_failed', 'The render node returned no deck payload.');
    payload = artifact.payload;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return toolError(err.code ?? 'validation_error', `${err.message ?? 'the deck failed normalization'} — fix the deck and call again.`);
  }

  const editorDeck = toEditorDeck(payload);
  const v = validateSlidesDoc(editorDeck);
  if (v.errors.length) {
    return toolError(
      'catalog_validation_failed',
      'The deck violates the closed slide/block catalog — fix these and call again (use the catalog tool for the block schemas).',
      { errors: v.errors.slice(0, 10) },
    );
  }
  return { ok: true, deck: editorDeck, slideCount: Array.isArray(editorDeck.slides) ? editorDeck.slides.length : 0 };
}

export function registerSlidesAgentTools(): void {
  // ── The schema-request path: the model ASKS for the block catalog. ────────
  registerFeatureAgentTool({
    // TRUSTED: returns slidesCatalogProjection() — the host-authored CLOSED block
    // catalog (legal types + enum values), no tenant or user data. Fencing a closed
    // catalog tells the model to distrust the very vocabulary it must author against.
    contentTrust: 'trusted',
    // ADR 0604 (TOCC-2) — closed world: an elided enum/id list here makes the
    // model author against a catalog that is not this host's.
    schemaCarrying: true,
    def: {
      name: SLIDES_CATALOG_TOOL_ID,
      description:
        'Fetch the CLOSED slide-block catalog: every legal block type with its props and enum values, '
        + 'plus the legal layouts, variants, themes, and transitions. Call this BEFORE authoring or '
        + 'editing deck JSON — block types outside this menu are rejected by validation.',
      inputSchema: { type: 'object', properties: {} },
    },
    async run(_input, scope) {
      if (!(await slidesEnabled(scope))) {
        return toolError('feature_disabled', 'The Slides feature is not enabled for this workspace — tell the user you cannot build decks here.');
      }
      return { content: JSON.stringify(slidesCatalogProjection()) };
    },
  });

  // ── The deck-state read path: the model READS an existing deck. ───────────
  registerFeatureAgentTool({
    contentTrust: 'untrusted',   // the USER's deck content
    // ADR 0604 (TOCC-2) — closed world: an elided enum/id list here makes the
    // model author against a catalog that is not this host's.
    schemaCarrying: true,
    def: {
      name: SLIDES_GET_DESIGN_TOOL_ID,
      description:
        'Read the CURRENT deck JSON (and its version) for an existing slide-deck canvas. Call this before '
        + 'editing a deck the user references so you change what actually exists — then pass the returned '
        + '`version` as `baseVersion` to the render tool when updating.',
      inputSchema: {
        type: 'object',
        properties: {
          canvasId: { type: 'string', description: 'The slide-deck canvas id (from a render result or the user).' },
          orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' },
        },
        required: ['canvasId'],
      },
    },
    async run(input, scope) {
      if (!(await slidesEnabled(scope))) {
        return toolError('feature_disabled', 'The Slides feature is not enabled for this workspace.');
      }
      // Read tool: fail EMPTY (not typed) without an acting user — a system turn
      // has no tenant rows to read, but the loop must not be derailed. Writes
      // (render) stay typed via resolveOrgScope's acting_user_required.
      if (!scope.actingUserId) return { content: JSON.stringify({ deck: null }) };
      const gate = await resolveOrgScope(scope, str(input.orgId), 'workspace:read');
      if ('content' in gate) return gate;
      const canvasId = str(input.canvasId);
      if (!canvasId) return toolError('validation_error', '`canvasId` is required.');
      const canvas = await getCanvasForTenant(scope.tenantId, canvasId);
      if (!canvas || canvas.canvasTypeId !== SLIDES_CANVAS_TYPE) {
        return toolError('not_found', `Slide deck '${canvasId}' not found in this workspace.`);
      }
      return {
        content: JSON.stringify({
          canvasId,
          version: canvas.version,
          deck: canvas.state,
          url: `/slides/${encodeURIComponent(canvasId)}`,
        }),
      };
    },
  });

  // ── The deliverable path: normalize → validate → persist → real reference. ─
  registerFeatureAgentTool({
    contentTrust: 'untrusted',   // echoes the deck it rendered
    def: {
      name: SLIDES_RENDER_TOOL_ID,
      description:
        'Render a deck you composed into a REAL slide-deck canvas the user can open, present, and edit. Pass the '
        + 'full deck as `deck`: { title?, theme?, slides: [{ layout, title?, subtitle?, bullets?, attribution?, '
        + 'imageUrl?, notes?, variant?, blocks? }] }. `layout` is one of title | title-bullets | section | quote | '
        + 'image | blank | blocks; block `type`s and enum values come ONLY from the catalog tool. Returns '
        + '{ canvasId, url, slideCount, version } — tell the user the deck title and give them the url. On a '
        + 'validation error, fix the reported issues and call again. To UPDATE an existing deck (including a '
        + 'restyle — re-emit with new theme/variant/background/transition), pass its `canvasId` + the `baseVersion` '
        + 'you read via the get-design tool.',
      inputSchema: {
        type: 'object',
        properties: {
          deck: { type: 'object', description: 'The full deck document (see the catalog tool for block schemas).' },
          canvasId: { type: 'string', description: 'Existing deck to update (omit to create a new one).' },
          baseVersion: { type: 'number', description: 'The version the update is based on (from get-design) — required with canvasId.' },
          orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' },
        },
        required: ['deck'],
      },
    },
    async run(input, scope) {
      if (!(await slidesEnabled(scope))) {
        return toolError('feature_disabled', 'The Slides feature is not enabled for this workspace — tell the user you cannot build decks here.');
      }
      const gate = await resolveOrgScope(scope, str(input.orgId), 'workspace:write');
      if ('content' in gate) return gate;
      if (!input.deck || typeof input.deck !== 'object' || Array.isArray(input.deck)) {
        return toolError('validation_error', '`deck` must be the deck document object.');
      }

      const normalized = await normalizeAndValidate(scope.tenantId, input.deck);
      if ('content' in normalized) return normalized;
      const { deck, slideCount } = normalized;

      // Provenance rides canvas `metadata` (the app-builder XCH-DATA-1 pattern):
      // the OWNER stays the human (ADR 0045 — a Subject confers no authority),
      // but an agent-produced deck records which agent + the run when there is one.
      const producedBy = scope.agentProfileId
        ? { kind: 'agent', id: scope.agentProfileId }
        : { kind: 'user', id: gate.actingUserId };

      const canvasId = str(input.canvasId);
      if (canvasId) {
        // Update = the governed CAS write (`updateCanvasForTenant` with
        // `expectedVersion`): a typed 409 on a concurrent edit, never a clobber;
        // a per-save snapshot keeps the editor's Compare honest.
        const baseVersion = Number(input.baseVersion);
        if (!Number.isInteger(baseVersion) || baseVersion < 1) {
          return toolError('validation_error', 'Updating an existing deck requires `baseVersion` — read it with the get-design tool first.');
        }
        const existing = await getCanvasForTenant(scope.tenantId, canvasId);
        if (!existing || existing.canvasTypeId !== SLIDES_CANVAS_TYPE) {
          return toolError('not_found', `Slide deck '${canvasId}' not found in this workspace.`);
        }
        try {
          const applied = await updateCanvasForTenant(scope.tenantId, canvasId, deck, {
            expectedVersion: baseVersion,
            merge: 'replace',
            snapshot: { capturedBy: gate.actingUserId },
          });
          if (!applied) return toolError('not_found', `Slide deck '${canvasId}' not found in this workspace.`);
          return {
            content: JSON.stringify({
              canvasId: applied.canvasId,
              version: applied.newVersion,
              slideCount,
              url: `/slides/${encodeURIComponent(applied.canvasId)}`,
              note: 'Deck updated. Tell the user what changed and that Compare in the editor shows exactly which slides changed.',
            }),
          };
        } catch (e) {
          const err = e as { code?: string; message?: string };
          if (err.code === 'canvas_version_conflict') {
            return toolError('canvas_version_conflict', 'Someone edited this deck since you read it — call get-design again and re-apply your changes on the new version.');
          }
          return toolError(err.code ?? 'update_failed', err.message ?? 'the update failed');
        }
      }

      // Create — deterministic idempotency inside a run (the ADR 0308 rule): an
      // exact retry short-circuits; a different deck in the same run hashes to a
      // new key. Calls without a runId keep the random id.
      const idempotencyKey = scope.runId
        ? createHash('sha256').update([scope.runId, SLIDES_RENDER_TOOL_ID, JSON.stringify(deck)].join('\u0000')).digest('hex').slice(0, 32)
        : undefined;
      const created = await createCanvasForTenant(scope.tenantId, {
        canvasTypeId: SLIDES_CANVAS_TYPE,
        ...(typeof deck.title === 'string' ? { name: deck.title } : {}),
        ownerSubject: { kind: 'user', id: gate.actingUserId },
        initialState: deck as never,
        metadata: { producedBy, ...(scope.runId ? { runId: scope.runId } : {}) },
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
      return {
        content: JSON.stringify({
          canvasId: created.canvasId,
          version: created.version,
          slideCount,
          url: `/slides/${encodeURIComponent(created.canvasId)}`,
          note: 'Deck created. Tell the user the deck title and that they can open, present, and edit it at the url.',
        }),
      };
    },
  });
}
