/**
 * Pure component-tree helpers for the app-builder editor (ADR 0153 Phase 2b). The
 * editor edits a `canvas.app-builder` design as an immutable App; these operate on an
 * already-cloned `Screen` in place (the page clones before calling). Kept separate from
 * the React page so the path arithmetic — the bug-prone part — is unit-tested.
 */

export interface CompNode { type: string; props?: Record<string, unknown>; children?: CompNode[] }
export interface Screen { id: string; name: string; route?: string; isInitial?: boolean; components?: CompNode[] }

/** The node at `path` (array of child indices) within a screen's tree, or null. */
export function nodeAt(screen: Screen, path: number[]): CompNode | null {
  let nodes = screen.components ?? [];
  let node: CompNode | null = null;
  for (const i of path) {
    node = nodes[i] ?? null;
    if (!node) return null;
    nodes = node.children ?? [];
  }
  return node;
}

/** Append `node` under the container at `parentPath` (a non-empty path to a container),
 *  or at the screen root when `parentPath` is null/empty. No-op if the path is invalid. */
export function addChild(screen: Screen, parentPath: number[] | null, node: CompNode): void {
  if (!parentPath || parentPath.length === 0) {
    screen.components = [...(screen.components ?? []), node];
    return;
  }
  const target = nodeAt(screen, parentPath);
  if (target) target.children = [...(target.children ?? []), node];
}

/** Remove the node at `path` (must be non-empty — the root list itself is never removed). */
export function deleteAt(screen: Screen, path: number[]): void {
  if (path.length === 0) return;
  const parentPath = path.slice(0, -1);
  const idx = path[path.length - 1]!;
  const list = parentPath.length === 0 ? (screen.components ?? []) : (nodeAt(screen, parentPath)?.children ?? []);
  if (idx >= 0 && idx < list.length) list.splice(idx, 1);
}

/** Set one prop on the node at `path`. No-op if the path is invalid. */
export function setPropAt(screen: Screen, path: number[], name: string, value: unknown): void {
  const n = nodeAt(screen, path);
  if (n) n.props = { ...(n.props ?? {}), [name]: value };
}
