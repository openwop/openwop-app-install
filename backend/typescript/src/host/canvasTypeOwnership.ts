/**
 * Canvas type → owning feature toggle (ADR 0820 G3/G5).
 *
 * Every first-party and pack canvas type is mounted through ONE call,
 * `registerCanvasEditorRoutes` (`features/canvasEditorRoutes.ts`), and that call
 * already names the type's feature toggle (`cfg.feature.toggleId`) for its HTTP
 * routes and, when `collab: true`, for the collab registry. This module records
 * the same `cfg.feature.toggleId` at the same call, for EVERY type, so the lanes
 * that reach a canvas without going through the type's routes can ask
 * "which feature owns this canvas?" and resolve it through `resolveOne`:
 *
 *   - `ctx.canvas` read/write/create (`host/canvasSurface.ts`, the executor lane);
 *   - the ui-plugin RPC (`routes/uiPlugins.ts`);
 *   - `documents/from-canvas` (`features/documents/documentsService.ts`).
 *
 * It is not a second mapping: the collab registry holds only the collab-capable
 * subset (its absence means "not joinable", so non-collab types cannot be added
 * there), and both are written from the one `cfg.feature.toggleId` in the one
 * function. `test/monetization-g3-executor-capabilities.test.ts` pins that the two
 * agree for every collab type.
 *
 * A type nobody registered has no owning feature and is core `host.canvas`
 * (advertised `supported`): the gate does not apply to it. That is the same
 * rule `featureSurfaces.gate` applies to an always-on surface.
 */
import { resolveOne } from './featureToggles/service.js';
import type { ToggleSubject } from './featureToggles/types.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.canvasTypeOwnership');

const owners = new Map<string, string>();

/** ADR 0865 B19 — a type's closed-world catalog check, the same function the
 *  editor's PATCH runs (`cfg.validate`). Warnings pass; errors refuse. */
export type CanvasTypeValidator = (state: Record<string, unknown>) => {
  errors: ReadonlyArray<{ path: string; message: string }>;
  warnings: ReadonlyArray<{ path: string; message: string }>;
};

/** ADR 0865 B17/B19 — what the run lane needs from the type's one registration
 *  that is NOT request-shaped: its validator, and whether its routes carry an
 *  extra `authorize(req)` gate (a privileged type) that no run can satisfy. */
const validators = new Map<string, CanvasTypeValidator>();
const privileged = new Set<string>();

/** Record a canvas type's owning toggle (and, ADR 0865, its validator and
 *  privileged flag). Idempotent; warns when a re-registration changes the owner
 *  (the collab registry's rule). */
export function registerCanvasTypeOwner(
  canvasTypeId: string,
  toggleId: string,
  opts: { validate?: CanvasTypeValidator; privileged?: boolean } = {},
): void {
  const prior = owners.get(canvasTypeId);
  if (prior && prior !== toggleId) {
    log.warn('canvas type re-registered with a different owning toggle', { canvasTypeId, prior, next: toggleId });
  }
  owners.set(canvasTypeId, toggleId);
  if (opts.validate) validators.set(canvasTypeId, opts.validate);
  else validators.delete(canvasTypeId);
  if (opts.privileged) privileged.add(canvasTypeId);
  else privileged.delete(canvasTypeId);
}

/** The type's registered catalog validator, if it declares one. */
export function canvasTypeValidator(canvasTypeId: string): CanvasTypeValidator | undefined {
  return validators.get(canvasTypeId);
}

/** Whether the type's routes carry an extra request-only `authorize` gate. */
export function isPrivilegedCanvasType(canvasTypeId: string): boolean {
  return privileged.has(canvasTypeId);
}

/** The owning toggle id, or `undefined` for an unregistered (core) type. */
export function canvasTypeOwnerToggle(canvasTypeId: string): string | undefined {
  return owners.get(canvasTypeId);
}

/** Every registered type → owner (for the structural tests). */
export function canvasTypeOwners(): ReadonlyMap<string, string> {
  return owners;
}

export type CanvasTypeAccess =
  | { allowed: true; toggleId: string | null }
  | { allowed: false; toggleId: string; blockedBy: 'toggle' | 'plan' | 'unresolved' };

/**
 * Whether `subject` may use canvases of `canvasTypeId`: the owning feature's
 * toggle AND plan (`resolveOne`, ADR 0819 §1). Fail-closed: a resolver that
 * returns null for a registered owner (a retired toggle) is a refusal.
 */
export async function resolveCanvasTypeAccess(canvasTypeId: string, subject: ToggleSubject): Promise<CanvasTypeAccess> {
  const toggleId = owners.get(canvasTypeId);
  if (!toggleId) return { allowed: true, toggleId: null };
  const assignment = await resolveOne(toggleId, subject);
  if (assignment?.enabled) return { allowed: true, toggleId };
  const blockedBy = assignment?.blockedBy === 'plan' ? 'plan' : assignment?.blockedBy === 'unresolved' ? 'unresolved' : 'toggle';
  return { allowed: false, toggleId, blockedBy };
}

