/**
 * Canvas framework — the tree-trait factory (ADR 0310, extracted from the
 * app-builder's canvasTree.ts / ADR 0153 Phase 2b). A canvas type whose document
 * nests components (`tree` trait) instantiates `treeOps()` with its container/child
 * keys; the returned helpers operate on an ALREADY-CLONED container in place (the
 * editor page clones before calling). Kept separate from React so the path
 * arithmetic — the bug-prone part — stays unit-tested.
 */

/** The minimal node shape the tree trait needs; per-type fields (including the
 *  child list, addressed by `childrenKey`) ride along on the concrete type. */
export interface TreeNodeBase {
  type: string;
  props?: Record<string, unknown>;
  /** ADR 0344 2b — authoring traits (optional, additive; each type's schema
   *  persists them). `hidden`: skipped by READ renderers + exports, dimmed in
   *  the outline. `locked`: the editor refuses gestures (drag/drop/delete/
   *  prop-edit) until unlocked. */
  hidden?: boolean;
  locked?: boolean;
}

export interface TreeOpsConfig {
  /** The container key holding the root node list (app-builder: 'components'). */
  rootKey?: string;
  /** The node key holding child nodes (default 'children'). */
  childrenKey?: string;
}

export interface TreeOps<N extends TreeNodeBase, C extends object> {
  nodeAt(container: C, path: number[]): N | null;
  addChild(container: C, parentPath: number[] | null, node: N): void;
  deleteAt(container: C, path: number[]): void;
  setPropAt(container: C, path: number[], name: string, value: unknown): void;
  insertAt(container: C, parentPath: number[] | null, index: number, node: N): void;
  moveNode(container: C, fromPath: number[], toParentPath: number[] | null, toIndex: number): number[] | null;
  duplicateAt(container: C, path: number[]): number[] | null;
}

/** Dynamic-key access confined to this one helper — the concrete container/node
 *  interfaces stay index-signature-free at every call site. */
const dict = (o: object): Record<string, unknown> => o as Record<string, unknown>;

export function treeOps<N extends TreeNodeBase, C extends object>(
  config: TreeOpsConfig = {},
): TreeOps<N, C> {
  const rootKey = config.rootKey ?? 'components';
  const childrenKey = config.childrenKey ?? 'children';

  const rootList = (container: C): N[] | undefined => dict(container)[rootKey] as N[] | undefined;
  const setRootList = (container: C, list: N[]): void => {
    dict(container)[rootKey] = list;
  };
  const childList = (node: N): N[] | undefined => dict(node)[childrenKey] as N[] | undefined;
  const setChildList = (node: N, list: N[]): void => {
    dict(node)[childrenKey] = list;
  };

  /** The node at `path` (array of child indices) within the container's tree, or null. */
  function nodeAt(container: C, path: number[]): N | null {
    let nodes = rootList(container) ?? [];
    let node: N | null = null;
    for (const i of path) {
      node = nodes[i] ?? null;
      if (!node) return null;
      nodes = childList(node) ?? [];
    }
    return node;
  }

  /** Append `node` under the container node at `parentPath` (a non-empty path to a
   *  container), or at the root when `parentPath` is null/empty. No-op if invalid. */
  function addChild(container: C, parentPath: number[] | null, node: N): void {
    if (!parentPath || parentPath.length === 0) {
      setRootList(container, [...(rootList(container) ?? []), node]);
      return;
    }
    const target = nodeAt(container, parentPath);
    if (target) setChildList(target, [...(childList(target) ?? []), node]);
  }

  /** Remove the node at `path` (must be non-empty — the root list itself is never removed). */
  function deleteAt(container: C, path: number[]): void {
    if (path.length === 0) return;
    const parentPath = path.slice(0, -1);
    const idx = path[path.length - 1]!;
    const parent = parentPath.length === 0 ? null : nodeAt(container, parentPath);
    const list = parentPath.length === 0
      ? (rootList(container) ?? [])
      : (parent ? (childList(parent) ?? []) : []);
    if (idx >= 0 && idx < list.length) list.splice(idx, 1);
  }

  /** Set one prop on the node at `path`. No-op if the path is invalid. */
  function setPropAt(container: C, path: number[], name: string, value: unknown): void {
    const n = nodeAt(container, path);
    if (n) n.props = { ...(n.props ?? {}), [name]: value };
  }

  /** The child list a `parentPath` addresses (root when null/empty), or null when
   *  the parent path is invalid. Creates the child array on demand. */
  function listAt(container: C, parentPath: number[] | null): N[] | null {
    if (!parentPath || parentPath.length === 0) {
      if (!rootList(container)) setRootList(container, []);
      return rootList(container)!;
    }
    const parent = nodeAt(container, parentPath);
    if (!parent) return null;
    if (!childList(parent)) setChildList(parent, []);
    return childList(parent)!;
  }

  /** Insert `node` under `parentPath` at `index` (clamped). No-op on invalid parent. */
  function insertAt(container: C, parentPath: number[] | null, index: number, node: N): void {
    const list = listAt(container, parentPath);
    if (!list) return;
    const i = Math.max(0, Math.min(index, list.length));
    list.splice(i, 0, node);
  }

  /**
   * Move the node at `fromPath` under `toParentPath` at `toIndex` (ADR 0305 Phase B).
   * Refuses a move into the node's own subtree. Removal shifts sibling indices, so
   * (with k = fromPath.length - 1):
   *   1. if `toParentPath` descends through a LATER sibling of the moved node
   *      (same first k segments and toParentPath[k] > fromPath[k]), that segment
   *      shifts left by one after removal;
   *   2. if the (adjusted) destination IS the source parent and `toIndex` sits
   *      after the removed slot, it also shifts left by one.
   * Returns the node's NEW path (index clamped), or null when refused/invalid —
   * the editor keeps the moved node selected via this.
   */
  function moveNode(container: C, fromPath: number[], toParentPath: number[] | null, toIndex: number): number[] | null {
    if (fromPath.length === 0) return null;
    const dest = toParentPath ? [...toParentPath] : [];
    // Into itself or its own descendant → refuse.
    if (dest.length >= fromPath.length && fromPath.every((v, i) => dest[i] === v)) return null;
    const node = nodeAt(container, fromPath);
    if (!node) return null;
    const k = fromPath.length - 1;
    let index = toIndex;
    if (dest.length > k && fromPath.slice(0, k).every((v, i) => dest[i] === v) && dest[k]! > fromPath[k]!) {
      dest[k] = dest[k]! - 1; // amendment 1a: destination rides a later sibling
    }
    const sameParent = dest.length === k && fromPath.slice(0, k).every((v, i) => dest[i] === v);
    if (sameParent && index > fromPath[k]!) index -= 1; // amendment 1b
    deleteAt(container, fromPath);
    const list = listAt(container, dest);
    if (!list) return null; // unreachable for a valid dest (delete can't sever it) — defensive
    const i = Math.max(0, Math.min(index, list.length));
    list.splice(i, 0, node);
    return [...dest, i];
  }

  /** Deep-clone the node at `path` and insert it right after the original.
   *  Returns the clone's path, or null when `path` is invalid. */
  function duplicateAt(container: C, path: number[]): number[] | null {
    const n = nodeAt(container, path);
    if (!n || path.length === 0) return null;
    const copy = JSON.parse(JSON.stringify(n)) as N;
    const parentPath = path.slice(0, -1);
    const clonePath = [...parentPath, path[path.length - 1]! + 1];
    insertAt(container, parentPath.length ? parentPath : null, clonePath[clonePath.length - 1]!, copy);
    return clonePath;
  }

  return { nodeAt, addChild, deleteAt, setPropAt, insertAt, moveNode, duplicateAt };
}
