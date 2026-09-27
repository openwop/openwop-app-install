/**
 * The ONE render/persist pipeline for an externally-composed app design
 * (ADR 0393 Phase 3 extraction — no new logic). Extracted VERBATIM from the
 * ADR 0358 `openwop:app-builder.render` agent-tool handler so the MCP control
 * lane exposes the SAME normalize → validate → CAS-persist pipeline instead of
 * a duplicate: the chat tool wraps this with the chat-session org-RBAC gate;
 * the MCP backing node wraps it with the ADR 0087 principal gate. One owner,
 * two thin gates.
 *
 * Pipeline: the design-chain render node (structural normalization — slug ids,
 * nav remap, size caps) → `validateAppDoc` closed-world → `surface.applyRepair`
 * CAS update (typed conflict, never a clobber) or `createCanvasForTenant`
 * (deterministic idempotency key inside a run).
 */
import { createHash } from 'node:crypto';
import { getNodeRegistry } from '../../executor/nodeRegistry.js';
import { createCanvasForTenant } from '../../host/canvasSurface.js';
import { APP_BUILDER_CANVAS_TYPE } from './componentCatalog.js';
import { validateAppDoc } from './validateAppDoc.js';
import { buildAppBuilderSurface } from './surface.js';

const RENDER_NODE_TYPE_ID = 'feature.app-builder.nodes.render';

export interface RenderDesignArgs {
  app: unknown;
  /** Existing canvas to update (absent → create). */
  canvasId?: string | undefined;
  /** CAS basis — required with `canvasId`. */
  baseVersion?: number | undefined;
  /** Canvas owner on create (the acting human when one exists). */
  ownerSubject?: { kind: 'user'; id: string } | undefined;
  /** Provenance stamped on canvas metadata on create. */
  producedBy: Record<string, unknown>;
  /** Idempotency basis on create (retries inside one run short-circuit). */
  runId?: string | undefined;
}

export type RenderDesignResult =
  | { ok: true; canvasId: string; version: number; screenCount: number; url: string; created: boolean }
  | { ok: false; error: string; message: string; extra?: Record<string, unknown> };

export async function renderDesign(tenantId: string, args: RenderDesignArgs): Promise<RenderDesignResult> {
  if (!args.app || typeof args.app !== 'object' || Array.isArray(args.app)) {
    return { ok: false, error: 'validation_error', message: '`app` must be the app design object.' };
  }

  // ONE normalization gate: the same render node the design chain runs
  // (slug ids, remap navigation, cap sizes, drop unknown fields) — the
  // computeNodeTool minimal-ctx pattern (ADR 0081 P3; the node is pure).
  const node = await getNodeRegistry().resolve(RENDER_NODE_TYPE_ID);
  if (!node) return { ok: false, error: 'host_capability_missing', message: 'The render node pack is not loaded on this host.' };
  let payload: Record<string, unknown>;
  let screenCount = 0;
  try {
    const outcome = await node.execute({
      runId: `agent-tool:${tenantId}`,
      nodeId: RENDER_NODE_TYPE_ID,
      tenantId,
      inputs: { app: args.app },
      config: {},
      configurable: {},
      attempt: 1,
      secrets: {},
      emit: async () => ({ eventId: '', sequence: 0 }),
    });
    if (outcome.status !== 'success') {
      const detail = outcome.status === 'failure' ? outcome.error : null;
      return { ok: false, error: 'validation_error', message: 'The design failed structural normalization — fix and call again.', extra: { detail } };
    }
    const artifact = (outcome.outputs as { artifact?: { payload?: Record<string, unknown> }; screenCount?: number }) ?? {};
    if (!artifact.artifact?.payload) return { ok: false, error: 'render_failed', message: 'The render node returned no design payload.' };
    payload = artifact.artifact.payload;
    screenCount = typeof artifact.screenCount === 'number' ? artifact.screenCount : 0;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, error: err.code ?? 'validation_error', message: `${err.message ?? 'the design failed normalization'} — fix the design and call again.` };
  }

  // Closed-world catalog validation — the gate the editor PATCH enforces,
  // now AT AUTHORING TIME so the caller gets the errors while it can react.
  const v = validateAppDoc(payload);
  if (v.errors.length) {
    return {
      ok: false,
      error: 'catalog_validation_failed',
      message: 'The design violates the closed component catalog — fix these and call again (use the catalog tool for the component schemas).',
      extra: { errors: v.errors.slice(0, 10) },
    };
  }

  if (args.canvasId) {
    // Update = the governed CAS write owner (`surface.applyRepair`) — the
    // full validator + typed 409 on a concurrent edit, never a clobber.
    const baseVersion = Number(args.baseVersion);
    if (!Number.isInteger(baseVersion) || baseVersion < 1) {
      return { ok: false, error: 'validation_error', message: 'Updating an existing canvas requires `baseVersion` — read it with the get-design tool first.' };
    }
    const applyRepair = buildAppBuilderSurface({ tenantId }).applyRepair;
    if (!applyRepair) return { ok: false, error: 'host_capability_missing', message: 'The app-builder surface does not expose applyRepair on this host.' };
    try {
      const applied = (await applyRepair({ canvasId: args.canvasId, expectedVersion: baseVersion, app: payload })) as { canvasId: string; newVersion: number };
      return { ok: true, canvasId: applied.canvasId, version: applied.newVersion, screenCount, url: `/app-builder/${encodeURIComponent(applied.canvasId)}`, created: false };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === 'canvas_version_conflict') {
        return { ok: false, error: 'canvas_version_conflict', message: 'Someone edited this design since you read it — call get-design again and re-apply your changes on the new version.' };
      }
      return { ok: false, error: err.code ?? 'update_failed', message: err.message ?? 'the update failed' };
    }
  }

  // Create — deterministic idempotency inside a run (the ADR 0308 GD-0308-1
  // rule): an exact retry short-circuits; a different design in the same run
  // hashes to a new key. Calls without a runId have no retry channel and keep
  // the random id.
  const idempotencyKey = args.runId
    ? createHash('sha256').update([args.runId, 'openwop:app-builder.render', JSON.stringify(payload)].join('\u0000')).digest('hex').slice(0, 32)
    : undefined;
  const created = await createCanvasForTenant(tenantId, {
    canvasTypeId: APP_BUILDER_CANVAS_TYPE,
    ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
    ...(args.ownerSubject ? { ownerSubject: args.ownerSubject } : {}),
    initialState: payload as never,
    metadata: { producedBy: args.producedBy, ...(args.runId ? { runId: args.runId } : {}) },
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
  return { ok: true, canvasId: created.canvasId, version: created.version, screenCount, url: `/app-builder/${encodeURIComponent(created.canvasId)}`, created: true };
}
