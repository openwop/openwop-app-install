/**
 * Canvas framework — flat element-collection operations (ADR 0310 Phase C, the
 * `elements` trait). A canvas type whose document holds flat element arrays
 * (drawing `shapes`, cad `solids`, campaign `channels`/`funnel`/`assets`) edits
 * them with these helpers; like treeOps/frameOps they mutate an ALREADY-CLONED
 * doc in place (the editor page clones before calling). Elements are addressed
 * positionally — no identity fields, so the working copy stays a pure mirror
 * of the artifact schema.
 */

const dict = (o: object): Record<string, unknown> => o as Record<string, unknown>;

/** The collection at `key`, created on demand (write paths only). */
export function elementList(doc: object, key: string): Record<string, unknown>[] {
  const v = dict(doc)[key];
  if (Array.isArray(v)) return v as Record<string, unknown>[];
  const list: Record<string, unknown>[] = [];
  dict(doc)[key] = list;
  return list;
}

/** Read-only view (never creates the array). */
export function readElements(doc: object, key: string): Record<string, unknown>[] {
  const v = dict(doc)[key];
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

/**
 * STRUCTURAL clone-for-edit (ADR 0333 grade pass DRAW-R1). Returns a new doc
 * safe to mutate through the `elementOps` in-place contract, sharing every
 * UNCHANGED element with prior history snapshots — so a per-frame drag no
 * longer serializes the whole doc each move, and 200 undo snapshots don't each
 * retain a full copy. The safety invariant (ADR 0317: a doc pushed to history
 * is never mutated) holds because the ONLY elements a caller mutates are the
 * `deepIdxs` — deep-copied here (JSON round-trip, so nested `points`/`pressures`
 * are independent); the shallow-`slice`d collection array means `push`/`splice`
 * never touch a shared snapshot's array, and every other element is a shared,
 * never-mutated reference.
 *
 * Use for the per-frame elements hot paths (patch/add/delete). One-shot,
 * opaque-callback edits (`editDoc`) keep the full clone — low frequency, and
 * the callback may touch arbitrary elements.
 */
export function structuralClone<T extends object>(doc: T, col: string, deepIdxs: readonly number[] = []): T {
  const next = { ...doc } as T;
  const list = readElements(doc, col);
  const nextList = list.slice();
  for (const i of deepIdxs) {
    if (i >= 0 && i < nextList.length) nextList[i] = JSON.parse(JSON.stringify(nextList[i])) as Record<string, unknown>;
  }
  dict(next)[col] = nextList;
  return next;
}

/** Append `el`. Returns its index, or -1 at the `max` cap. */
export function addElement(doc: object, key: string, el: Record<string, unknown>, max: number): number {
  const list = elementList(doc, key);
  if (list.length >= max) return -1;
  list.push(el);
  return list.length - 1;
}

/** Remove the element at `index`; refuses below `min` (schema minItems). */
export function removeElement(doc: object, key: string, index: number, min: number): boolean {
  const list = elementList(doc, key);
  if (list.length <= min) return false;
  if (index < 0 || index >= list.length) return false;
  list.splice(index, 1);
  return true;
}

/** Move the element at `index` to `toIndex` (clamped). Returns the new index. */
export function moveElement(doc: object, key: string, index: number, toIndex: number): number {
  const list = elementList(doc, key);
  const el = list[index];
  if (!el) return index;
  list.splice(index, 1);
  const i = Math.max(0, Math.min(toIndex, list.length));
  list.splice(i, 0, el);
  return i;
}

/** Deep-clone the element at `index`, insert right after. Returns the clone's
 *  index, or -1 on invalid index / cap. */
export function duplicateElement(doc: object, key: string, index: number, max: number): number {
  const list = elementList(doc, key);
  const el = list[index];
  if (!el || list.length >= max) return -1;
  list.splice(index + 1, 0, JSON.parse(JSON.stringify(el)) as Record<string, unknown>);
  return index + 1;
}

/** The next free deterministic group id (`g1`, `g2`, …) for a collection —
 *  derived from the DOC, never a clock/random (ADR 0333 Phase 3; extracted in
 *  Phase 7 so the chassis ⌘G and the drawings symmetry commit share ONE
 *  generator). */
export function nextGroupId(list: readonly Record<string, unknown>[]): string {
  const nums = list
    .map((el) => (typeof el.groupId === 'string' ? el.groupId : ''))
    .filter((g) => /^g\d+$/.test(g))
    .map((g) => Number(g.slice(1)));
  return `g${(nums.length ? Math.max(...nums) : 0) + 1}`;
}

// ---- z-order (ADR 0333 Phase 2) -------------------------------------------
// Array order IS paint order (later = on top), so reorder round-trips through
// the positional artifact schemas unchanged.

export type ReorderOp = 'forward' | 'backward' | 'front' | 'back';
export interface ElementBox { x: number; y: number; w: number; h: number }

const boxesOverlap = (a: ElementBox, b: ElementBox): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Reorder the elements at `idxs` (a multi-selection; relative order is
 *  PRESERVED — the tldraw semantics). `forward`/`backward` step past the
 *  nearest sibling — the nearest that VISUALLY OVERLAPS the moved set when
 *  `bboxFor` is supplied (stepping past a non-overlapping shape is a no-op to
 *  the eye), else the adjacent index. `front`/`back` move to the extremes.
 *  Returns the selection's new indices (ascending), or null if nothing moved. */
export function reorderElements(
  doc: object,
  key: string,
  idxs: number[],
  op: ReorderOp,
  bboxFor?: (el: Record<string, unknown>) => ElementBox | null,
): number[] | null {
  const list = elementList(doc, key);
  const sel = [...new Set(idxs)].filter((i) => i >= 0 && i < list.length).sort((a, b) => a - b);
  if (!sel.length || sel.length === list.length) return null;

  const selSet = new Set(sel);
  const moved = sel.map((i) => list[i]!);
  // Non-selected elements in order, each remembering its original index.
  const rest: { el: Record<string, unknown>; orig: number }[] = [];
  list.forEach((el, i) => { if (!selSet.has(i)) rest.push({ el, orig: i }); });

  const selBoxes = bboxFor ? moved.map(bboxFor).filter((b): b is ElementBox => Boolean(b)) : [];
  const overlapsSel = (el: Record<string, unknown>): boolean => {
    if (!bboxFor || !selBoxes.length) return true; // no geometry → plain adjacent step
    const b = bboxFor(el);
    return Boolean(b) && selBoxes.some((s) => boxesOverlap(s, b!));
  };

  /** Insertion position within `rest` (0..rest.length). */
  let insertAt: number;
  if (op === 'front') {
    insertAt = rest.length;
  } else if (op === 'back') {
    insertAt = 0;
  } else if (op === 'forward') {
    // The nearest overlapping non-selected element ABOVE the selection's top;
    // land just after it.
    const target = rest.findIndex((r) => r.orig > sel[sel.length - 1]! && overlapsSel(r.el));
    if (target < 0) return null;
    insertAt = target + 1;
  } else {
    // backward: the nearest overlapping non-selected element BELOW the
    // selection's bottom; land just before it.
    let target = -1;
    for (let ri = rest.length - 1; ri >= 0; ri--) {
      const r = rest[ri]!;
      if (r.orig < sel[0]! && overlapsSel(r.el)) { target = ri; break; }
    }
    if (target < 0) return null;
    insertAt = target;
  }

  const next = [...rest.slice(0, insertAt).map((r) => r.el), ...moved, ...rest.slice(insertAt).map((r) => r.el)];
  // No-op guard: unchanged order → null so callers skip a history step.
  if (next.every((el, i) => el === list[i])) return null;
  list.length = 0;
  list.push(...next);
  return moved.map((el) => next.indexOf(el));
}
