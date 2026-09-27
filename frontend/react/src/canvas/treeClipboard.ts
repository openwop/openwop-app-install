/**
 * Session tree clipboard (ADR 0344 slice 2a — CV-04). Module-scoped so a
 * subtree copied in ONE canvas pastes into ANOTHER canvas of the SAME type
 * (cross-canvas, not just cross-frame), keyed by `canvasTypeId` so a paste can
 * never cross canvas types (the closed-world guard: an app-builder component
 * is not a slides block). Session-local BY DESIGN — never localStorage, never a
 * persistence store (ADR 0342 CV-04); a reload clears it.
 *
 * Entries are deep-cloned on WRITE and on READ, so neither later document
 * edits nor paste-side mutation can ever reach a held copy.
 *
 * The style clipboard carries the CATALOG-approved style vocabulary only —
 * `enum`/`color` typed props (the token scales); content props (string/
 * longtext/screen/dataSource/mediaRef) never ride a style paste.
 */

export interface StyleClipEntry {
  /** The component type the style was copied FROM (shown in paste hints). */
  sourceType: string;
  /** Style prop values, already filtered to enum/color props by the copier. */
  props: Record<string, unknown>;
}

const nodeClips = new Map<string, unknown>();
const styleClips = new Map<string, StyleClipEntry>();

export function setTreeClip(canvasTypeId: string, node: unknown): void {
  nodeClips.set(canvasTypeId, structuredClone(node));
}

export function getTreeClip<N>(canvasTypeId: string): N | null {
  const held = nodeClips.get(canvasTypeId);
  return held === undefined ? null : (structuredClone(held) as N);
}

export function setStyleClip(canvasTypeId: string, entry: StyleClipEntry): void {
  styleClips.set(canvasTypeId, structuredClone(entry));
}

export function getStyleClip(canvasTypeId: string): StyleClipEntry | null {
  const held = styleClips.get(canvasTypeId);
  return held === undefined ? null : structuredClone(held);
}

/** Test seam — clears every held entry. */
export function clearTreeClipboards(): void {
  nodeClips.clear();
  styleClips.clear();
}
