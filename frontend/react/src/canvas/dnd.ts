/**
 * Canvas framework — shared drag-and-drop payload MIME types (ADR 0310;
 * namespaced like the builder's PALETTE_MIME). One vocabulary for every canvas
 * editor: palette-add, node-move, frame-reorder.
 */
export const MIME_ADD = 'application/x-openwop-cv-component';
export const MIME_MOVE = 'application/x-openwop-cv-move';
export const MIME_FRAME = 'application/x-openwop-cv-frame';

export const parsePath = (s: string): number[] => (s === '' ? [] : s.split('.').map(Number));

/** The `data-cv-path` selection/DnD seam the shared renderers stamp in edit mode. */
export const PATH_ATTR = 'data-cv-path';
/** The `data-cv-nav` tap-through seam actionable elements carry. */
export const NAV_ATTR = 'data-cv-nav';
/** ADR 0345 3b — stamped by a type's read renderer on action-bearing nodes;
 *  the InteractiveViewer's delegated handler routes it to the type runtime. */
export const ACT_ATTR = 'data-cv-act';
/**
 * A read-mode form control may bind its current value directly to the preview's
 * ephemeral state store. The renderer only stamps a declared `state.<id>`
 * binding; the chassis owns the event listener and never persists the value.
 */
export const STATE_ATTR = 'data-cv-state';
