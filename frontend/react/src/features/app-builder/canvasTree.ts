/**
 * App-builder tree helpers — a thin typed adapter over the canvas framework's
 * `treeOps` factory (ADR 0310 Phase A; the logic moved verbatim from here to
 * `canvas/treeOps.ts`, where it originated as ADR 0153 Phase 2b). The editor
 * edits a `canvas.app-builder` design as an immutable App; these operate on an
 * already-cloned `Screen` in place (the page clones before calling).
 */
import { treeOps } from '../../canvas/treeOps.js';

// `hidden`/`locked` are the ADR 0344 2b chassis traits; `actions`/`bindings`
// are the ADR 0343 closed facets (executed by the ADR 0345 preview runtime).
export interface CompNode {
  type: string;
  props?: Record<string, unknown>;
  children?: CompNode[];
  hidden?: boolean;
  locked?: boolean;
  actions?: Record<string, unknown>[];
  bindings?: Record<string, { path?: string; fallback?: string; format?: string; mode?: string }>;
}
export interface Screen { id: string; name: string; route?: string; isInitial?: boolean; components?: CompNode[]; x?: number; y?: number }

const ops = treeOps<CompNode, Screen>({ rootKey: 'components', childrenKey: 'children' });

/** The tree-trait instance the app-builder's CanvasTypeDefinition carries. */
export const appBuilderTreeOps = ops;

export const { nodeAt, addChild, deleteAt, setPropAt, insertAt, moveNode, duplicateAt } = ops;
