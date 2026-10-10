/**
 * Seed an editable `host.canvas` working copy from an immutable run artifact
 * (ADR 0153 §R1 — the "Open in editor" flow). A run emits a typed `canvas.*` artifact
 * (replay-safe, `runArtifactStore`, key `${runId}:${nodeId}`); opening it for editing
 * must NOT mutate that artifact — it creates a SEPARATE `host.canvas` row whose live
 * state starts as a copy of the artifact payload. Keyed on the artifact key so opening
 * the same artifact twice yields ONE working copy (idempotent), not duplicates.
 *
 * Kept out of `canvasSurface.ts` so that file need not import the run-artifact store
 * (no import cycle); both seams are tenant-scoped, non-run helpers.
 */

import { createLogger } from '../observability/logger.js';
import { getRunArtifact } from './runArtifactStore.js';
import { OpenwopError } from '../types.js';
import { createCanvasForTenant, type CanvasRecordView } from './canvasSurface.js';
import type { Subject } from './subject.js';

const log = createLogger('host.canvasFromArtifact');

/** Create (or return the existing) editable canvas working copy for the `canvas.*`
 *  artifact identified by `artifactKey` (`${runId}:${nodeId}`). Idempotent — opening
 *  the same artifact twice returns the SAME working copy. Returns null when the
 *  artifact is absent, cross-tenant (no existence leak), not a canvas type, or carries
 *  an unparseable body. `ownerSubject` (optional) anchors RBAC at the editor route. */
export async function seedCanvasFromArtifact(
  tenantId: string,
  artifactKey: string,
  opts?: {
    ownerSubject?: Subject;
    projectId?: string;
    /** ADR 0835 D3 — the canvas type the caller's door owns. An artifact of
     *  another type is absent to that door (null): without the pin, the slides
     *  route seeded an app-builder canvas past app-builder's own gates. */
    canvasTypeId?: string;
    /** ADR 0835 D3 — the type's save validator. A run artifact is model output;
     *  its schema leaves component props open, so this is the closed-world
     *  check that keeps it from becoming durable state the editor would refuse. */
    validate?: (state: Record<string, unknown>) => { errors: { path: string; message: string }[] };
  },
): Promise<CanvasRecordView | null> {
  const record = await getRunArtifact(artifactKey);
  // Cross-tenant / absent ⇒ null (no existence leak).
  if (!record || record.tenantId !== tenantId) return null;
  const canvasTypeId = record.artifactTypeId;
  if (!canvasTypeId || !canvasTypeId.startsWith('canvas.')) {
    log.debug('seed_skip_non_canvas', { artifactKey, artifactTypeId: canvasTypeId ?? null });
    return null;
  }
  if (opts?.canvasTypeId && canvasTypeId !== opts.canvasTypeId) {
    log.debug('seed_skip_type_mismatch', { artifactKey, artifactTypeId: canvasTypeId, expected: opts.canvasTypeId });
    return null;
  }
  let initialState: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(record.content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    initialState = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  if (opts?.validate) {
    const errors = opts.validate(initialState).errors;
    if (errors.length) {
      log.warn('seed_rejected_by_validator', { artifactKey, canvasTypeId, errorCount: errors.length, first: errors[0]!.message });
      throw new OpenwopError('validation_error', `this artifact is not a valid ${canvasTypeId} document: ${errors[0]!.message}`, 422, { errors });
    }
  }

  // Idempotency: a deterministic key derived from the artifact key, so re-opening
  // the same artifact returns the same working copy (never a second canvas).
  const idempotencyKey = `from-artifact:${artifactKey}`;
  const canvas = await createCanvasForTenant(tenantId, {
    canvasTypeId,
    ...(record.title ? { name: record.title } : {}),
    ...(opts?.projectId ? { projectId: opts.projectId } : {}),
    ...(opts?.ownerSubject ? { ownerSubject: opts.ownerSubject } : {}),
    initialState,
    metadata: { seededFromArtifactKey: artifactKey },
    idempotencyKey,
  });
  log.info('canvas_seeded_from_artifact', { artifactKey, canvasId: canvas.canvasId, canvasTypeId });
  return canvas;
}
