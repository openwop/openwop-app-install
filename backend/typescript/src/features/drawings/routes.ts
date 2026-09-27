/**
 * Drawings editor routes (host-extension, ADR 0310 Phase C) — a pure call into
 * the shared canvas-editor route factory, type-pinned to `canvas.drawing` and
 * gated by the `drawings-editor` toggle. No component catalog and no frame
 * templates — an elements-trait type (the shape adders live in the FE
 * definition); no extra verbs; no share resource type this phase.
 */
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { registerCanvasEditorRoutes } from '../canvasEditorRoutes.js';
import { validateDrawingDoc } from './validateDrawingDoc.js';

export function registerDrawingsEditorRoutes(deps: RouteDeps): void {
  registerCanvasEditorRoutes(deps, {
    basePath: '/v1/host/openwop-app/drawings',
    feature: { toggleId: 'drawings', label: 'Drawings' },
    canvasTypeId: 'canvas.drawing',
    // ADR 0359 Phase 5 — collab-capable (both toggles enforced at the socket).
    collab: true,
    // ADR 0359 Phase 6 — the doc↔Y shape (drift-pinned against the FE traits
    // in canvas/__tests__/collabTypes.test.ts + collab-authboundary registry test).
    collabShape: { collections: [{ key: 'shapes' }] },
    validate: validateDrawingDoc,
    // ADR 0314 — blank drawing: one rectangle (the FE adder's exact defaults,
    // so the blank looks identical to what "Add rectangle" produces).
    blankState: (name) => ({ title: name, width: 800, height: 600, shapes: [{ kind: 'rect', x: 20, y: 20, width: 120, height: 80 }] }),
  });
}
