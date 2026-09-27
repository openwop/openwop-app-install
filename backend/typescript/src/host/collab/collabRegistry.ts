/**
 * Collab-capable canvas-type registry (ADR 0359 D1).
 *
 * The ONE place the collaboration transport learns which canvas types may open
 * a live room. A first-party canvas type opts in declaratively through its
 * `registerCanvasEditorRoutes` cfg (`collab: true`) — so a type can never be
 * collab-capable without its routes, validator, and own feature toggle mounted.
 * Each entry carries the type's OWN toggle id: the socket enforces BOTH
 * `realtime-collab` AND the type's toggle (architect HIGH-1 — the UI hiding a
 * disabled editor is not the boundary; the socket is).
 *
 * Fail-closed by absence: an unregistered, unknown, or PACK-provided type
 * (ADR 0359 v1 exclusion — pack registrations never set `collab`) is not
 * joinable; the transport answers a uniform 404.
 */
import type { Request } from 'express';
import { createLogger } from '../../observability/logger.js';
import type { Doc as YDoc } from 'yjs';
import type { CollabShape } from './collabStateMirror.js';

const log = createLogger('host.collab.registry');

export interface CollabCanvasType {
  canvasTypeId: string;
  /** The canvas type's OWN feature toggle — enforced at the socket alongside `realtime-collab`. */
  toggleId: string;
  /** ADR 0359 Phase 6 — the element-type doc↔Y shape (drift-pinned against the
   *  FE traits). Present ⇒ generic derive + apply-into-room; absent (the
   *  `canvas.document` XmlFragment) ⇒ external writes 409 while a room is live
   *  unless `deriveState` supplies a model-specific derive. */
  shape?: CollabShape;
  /** Model-specific derive of the host.canvas state from the room's Y.Doc
   *  (`canvas.document`: XmlFragment → ProseMirror JSON + preserved title).
   *  Defaults to the generic root-map `toJSON()` when `shape` is present. */
  deriveState?: (ydoc: YDoc, current: Record<string, unknown>) => Record<string, unknown> | null;
  /** The type's save validator — a derive that fails it is SKIPPED (stale
   *  host.canvas beats an invalid one; the CRDT snapshot stays authoritative). */
  validate?: (state: Record<string, unknown>) => { errors: { path: string; message: string }[] };
  /** ADR 0458 grade-pass B1 — an OPTIONAL extra authorization predicate the
   *  ticket-mint / claim-seed paths run AFTER the toggle + tenant-canvas checks
   *  (threaded from the type's `registerCanvasEditorRoutes` cfg, so the room gate
   *  and the REST gate can never drift). Absent ⇒ the room is reachable by any
   *  tenant member with the type toggle on, as before. Throws its own typed error. */
  authorize?: (req: Request) => Promise<void>;
}

const registry = new Map<string, CollabCanvasType>();

/** Idempotent per canvasTypeId (repeat boots overwrite); warns if the toggle binding changes. */
export function registerCollabCanvasType(entry: CollabCanvasType): void {
  const prior = registry.get(entry.canvasTypeId);
  if (prior && prior.toggleId !== entry.toggleId) {
    log.warn('collab canvas type re-registered with a different toggle', {
      canvasTypeId: entry.canvasTypeId, prior: prior.toggleId, next: entry.toggleId,
    });
  }
  registry.set(entry.canvasTypeId, entry);
}

/** The registry lookup the transport authorizes against. `undefined` ⇒ not joinable. */
export function collabCanvasType(canvasTypeId: string): CollabCanvasType | undefined {
  return registry.get(canvasTypeId);
}

