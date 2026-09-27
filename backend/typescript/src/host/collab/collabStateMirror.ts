/**
 * Backend state↔Y mirror for element/tree canvas types (ADR 0359 Phase 6 / D6).
 *
 * The FE binding (`frontend/react/src/canvas/collabDocBinding.ts`) maps an
 * editor doc onto a Y.Doc as: root Y.Map('doc') — declared COLLECTIONS as
 * Y.Array of Y.Map items (tree nodes recursing through their children field),
 * every other value opaque/plain. This module is the byte-compatible backend
 * half:
 *
 *  - `replaceRootFromState` — a whole-doc SERVER-origin replace used by the
 *    apply-into-room seam (an external `host.canvas` write — AI authoring, a
 *    run, a restore — landing on a LIVE room). It MUST build the same shapes
 *    the FE binding expects, or the FE materializer would leak Y types into
 *    plain docs. The shape comes from the type's registration and is
 *    drift-pinned against the FE traits on both sides.
 *
 *  - `defaultDeriveState` — the generic derive for element types: the root
 *    map's `toJSON()` IS the editor doc (that's the point of the mapping).
 *
 * External-import semantics (the ADR's documented rule): a whole-doc replace
 * clobbers concurrent keystrokes in the apply window and resets per-user undo
 * over replaced items — standard import behavior, never a second authority.
 */
import * as Y from 'yjs';

export interface CollabNestedSpec { field: string; childrenKey?: string }
export interface CollabCollectionSpec { key: string; nested?: CollabNestedSpec }
export interface CollabShape { collections: CollabCollectionSpec[] }

type Dict = Record<string, unknown>;

const childSpec = (childrenKey: string | undefined): CollabNestedSpec | undefined =>
  childrenKey ? { field: childrenKey, childrenKey } : undefined;

function buildItem(item: Dict, nested: CollabNestedSpec | undefined): Y.Map<unknown> {
  const ymap = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(item)) {
    if (v === undefined) continue;
    if (nested && k === nested.field && Array.isArray(v)) {
      ymap.set(k, buildArray(v as Dict[], childSpec(nested.childrenKey)));
    } else {
      ymap.set(k, v);
    }
  }
  return ymap;
}

function buildArray(items: Dict[], nested: CollabNestedSpec | undefined): Y.Array<unknown> {
  const yarr = new Y.Array<unknown>();
  yarr.insert(0, items.filter((it): it is Dict => !!it && typeof it === 'object').map((it) => buildItem(it, nested)));
  return yarr;
}

/** Whole-doc replace of the room's root map from a host.canvas state (call
 *  inside a `ydoc.transact(…, SERVER_ORIGIN)`). */
export function replaceRootFromState(root: Y.Map<unknown>, shape: CollabShape, state: Dict): void {
  const specs = new Map(shape.collections.map((c) => [c.key, c]));
  for (const k of [...root.keys()]) root.delete(k);
  for (const [k, v] of Object.entries(state)) {
    if (v === undefined) continue;
    const spec = specs.get(k);
    if (spec) root.set(k, buildArray(Array.isArray(v) ? (v as Dict[]) : [], spec.nested));
    else root.set(k, v);
  }
}

/** Generic element-type derive: the root map materialized back to the doc. */
export function defaultDeriveState(ydoc: Y.Doc): Dict {
  return ydoc.getMap<unknown>('doc').toJSON();
}
