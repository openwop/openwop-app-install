/**
 * Builder node clipboard (§7.5 / CV-2) — the copy/paste/duplicate verbs,
 * extracted from BuilderCanvas's ad-hoc keydown listener so the ONE shortcut
 * registry (BuilderShell) and any future chrome can drive them. Module-level
 * clipboard (same lifetime as before — survives canvas remounts within the
 * session, deliberately not cross-tab).
 */
import { useBuilderStore } from './store/builderStore.js';
import type { PasteNodeEntry } from './store/builderStore.js';

/**
 * H37: this module declared its OWN entry shape enumerating
 * `kind/name/config/inputs`, and `copySelection` rebuilt entries field-by-field
 * to match — so copy/paste silently dropped every field neither list named,
 * `outputRole` (RFC 0065 / ADR 0440 P1) included. The shape now comes from the
 * store's `PasteNodeEntry` (a `BuilderNode` minus the `id`/`position` paste
 * mints itself), which carries a compile-time coverage ratchet — one
 * declaration instead of two lists that have to be kept equal by hand.
 *
 * The clipboard is module-level and in-memory (deliberately not localStorage /
 * the system clipboard), so there is no JSON round-trip to drop `undefined`
 * and no persisted entry that can outlive a build. A narrower entry captured
 * by an older build would still paste anyway: `Omit` leaves the optional
 * fields optional, and `pasteNodes` spreads whatever it is handed.
 */
type ClipboardNode = PasteNodeEntry;

let nodeClipboard: ClipboardNode[] | null = null;

const PASTE_OFFSET = 32;

/** Copy the current selection (offsets from the selection's top-left so
 *  paste reconstructs the layout). Returns the count copied. */
export function copySelection(): number {
  const st = useBuilderStore.getState();
  const ids = st.selectedNodeIds;
  if (ids.length === 0) return 0;
  const sel = st.nodes.filter((n) => ids.includes(n.id));
  const minX = Math.min(...sel.map((n) => n.position.x));
  const minY = Math.min(...sel.map((n) => n.position.y));
  nodeClipboard = sel.map(({ id: _id, position, ...rest }) => ({
    // H37 — spread the node, drop only id/position, add the group offsets.
    ...rest,
    config: { ...rest.config },
    ...(rest.inputs ? { inputs: { ...rest.inputs } } : {}),
    dx: position.x - minX,
    dy: position.y - minY,
  }));
  return sel.length;
}

/** Paste anchored near the primary selection (or a fixed spot). Returns the
 *  count pasted (0 = empty clipboard). */
export function pasteClipboard(): number {
  if (!nodeClipboard || nodeClipboard.length === 0) return 0;
  const st = useBuilderStore.getState();
  const primary = st.selectedNodeId ? st.nodes.find((n) => n.id === st.selectedNodeId) ?? null : null;
  const anchor = primary
    ? { x: primary.position.x + PASTE_OFFSET, y: primary.position.y + PASTE_OFFSET }
    : { x: 160, y: 160 };
  st.pasteNodes(nodeClipboard, anchor);
  return nodeClipboard.length;
}

/** Group-aware duplicate of the selection. Returns the count duplicated. */
export function duplicateSelection(): number {
  const st = useBuilderStore.getState();
  const ids = st.selectedNodeIds;
  if (ids.length === 0) return 0;
  st.cloneNodes(ids);
  return ids.length;
}

export function hasClipboard(): boolean {
  return nodeClipboard !== null && nodeClipboard.length > 0;
}

/** Test seam. */
export function clearClipboardForTest(): void {
  nodeClipboard = null;
}
