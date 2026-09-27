/**
 * Generic element-doc ↔ Yjs binding (ADR 0359 Phase 3 / D3).
 *
 * Binds a chassis working copy (frames/tree/elements canvas types) to a shared
 * `Y.Doc`: doc-level scalars → the root `Y.Map`; each declared collection →
 * a `Y.Array` of `Y.Map` items (tree nodes recurse through their children
 * field). Everything undeclared is an OPAQUE value (whole-value set on change
 * — no CRDT granularity inside; the declared collections are where concurrency
 * matters).
 *
 * D3 CORRECTION (recorded in the ADR): the structured-op "descriptors" are
 * DERIVED, not plumbed. The chassis op layer's clone-on-edit discipline —
 * a committed doc is never mutated, unchanged items are REFERENCE-SHARED
 * (`structuralClone`), and only `editDoc`-style one-shots full-clone — lets a
 * commit-time reconciliation recover targeted ops without touching any call
 * site:
 *   1. reference-identity match (the hot paths — a moved/kept item is the SAME
 *      object, so a reorder is recognized as a move, never delete+insert of
 *      everything);
 *   2. deep-equal match for full-clone gestures (content-identical ⇒ same item);
 *   3. positional pairing of the leftovers ⇒ per-field `Y.Map.set` (an edited
 *      item KEEPS its CRDT identity, so a peer's concurrent edit to another
 *      field of the same item survives);
 *   4. residual inserts/deletes; ordering via a longest-increasing-subsequence
 *      so only the minimal move set is delete+reinserted (Yjs cannot re-insert
 *      a Y type, so a genuine move rebuilds that item — a peer's concurrent
 *      edit to a locally-MOVED item is lost; the documented loss semantics).
 *
 * Undo: `Y.UndoManager` tracking only `LOCAL_ORIGIN`, `captureTimeout` pinned
 * huge — `set()` (one gesture) calls `stopCapturing()` first, `replace()`
 * (drag phases / text-family coalescing) merges into the open step. This
 * preserves the chassis "one undo step per gesture" contract with PER-USER
 * scope (a peer's edits are never undone by your Ctrl+Z).
 *
 * Remote/undo transactions rebuild only the CHANGED slices into a fresh plain
 * doc (unchanged collections keep object identity) and report an index remap
 * for top-level collections so the chassis can shift `multiSel`/`frameIdx`
 * in the same commit (ADR 0359 D4).
 *
 * KNOWN RACE (accepted, one-render window): a gesture whose closure captured a
 * doc from BEFORE a remote insert landed commits a `next` that lacks the
 * remote element — the reconciler reads that as a user delete. The window is
 * a single React render (observers → setState → next render's closures see the
 * merged doc); an explicit user delete is indistinguishable by construction in
 * a positional document. Verified per-type in the Phase 5 rollout.
 *
 * BUNDLE: imports yjs statically — consumers MUST dynamic-import this module
 * (the `useCollabDoc` facade does) so yjs never enters an eager chunk.
 */
import * as Y from 'yjs';

export interface CollabNestedSpec {
  /** The item field holding a nested identity-bearing node array (frames:
   *  the tree `rootKey`). Nodes recurse through `childrenKey`. */
  field: string;
  childrenKey?: string;
}
export interface CollabCollectionSpec {
  key: string;
  /** ADR 0364 — id-keyed pairing: when items carry a STABLE identity field
   *  that other items reference (workflow nodes/edges), leftovers pair by
   *  this id instead of positionally — concurrent same-index insertions
   *  would otherwise cross-wire one user's field edits onto another user's
   *  item. Absent ⇒ the positional fallback, byte-identical to before. */
  idKey?: string;
  nested?: CollabNestedSpec;
}
export interface CollabDocShape { collections: CollabCollectionSpec[] }

/** Old index → new index (null = the element was deleted remotely). */
export type CollabIndexRemap = (collectionKey: string, index: number) => number | null;

export interface CollabDocBinding<Doc extends object> {
  /** Seeder-election winner only: write the loaded working copy into the room. */
  seed(doc: Doc): void;
  /** Materialize the current doc from Y (raw — callers coerce). */
  current(): Record<string, unknown>;
  /** Commit a local gesture as a NEW undo step. */
  set(next: Doc): void;
  /** Commit a local coalescing edit into the OPEN undo step (drag phases). */
  replace(next: Doc): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Remote/undo/redo transactions: the rebuilt doc + the selection remap. */
  onDocChanged(cb: (doc: Record<string, unknown>, remap: CollabIndexRemap) => void): () => void;
  onStackChanged(cb: () => void): () => void;
  destroy(): void;
}

/** The tracked-origin sentinel for genuinely-local edits (per-user undo scope). */
export const LOCAL_ORIGIN = Symbol('collab-local');
const SEED_ORIGIN = Symbol('collab-seed');
/** Effectively-infinite capture window; undo-step boundaries are EXPLICIT
 *  (`stopCapturing` on each `set`), never time-based — a slow drag stays one step. */
const CAPTURE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

const stringify = (v: unknown): string => JSON.stringify(v) ?? 'undefined';

type Dict = Record<string, unknown>;
type YItem = Y.Map<unknown>;

export function createCollabDocBinding<Doc extends object>(ydoc: Y.Doc, shape: CollabDocShape): CollabDocBinding<Doc> {
  const root = ydoc.getMap<unknown>('doc');
  const specs = new Map(shape.collections.map((c) => [c.key, c]));
  /** plain item → its Y.Map (survives across commits via reference sharing). */
  const yByPlain = new WeakMap<object, YItem>();
  /** Y.Map → its last materialized plain item (rebuild sharing). */
  const plainByY = new WeakMap<YItem, Dict>();
  /** The plain mirror the next local commit diffs against. */
  let lastDoc: Dict = {};
  const docListeners = new Set<(doc: Dict, remap: CollabIndexRemap) => void>();
  const stackListeners = new Set<() => void>();

  const um = new Y.UndoManager(root, {
    trackedOrigins: new Set([LOCAL_ORIGIN]),
    captureTimeout: CAPTURE_TIMEOUT_MS,
  });
  const notifyStack = (): void => { for (const cb of stackListeners) cb(); };
  um.on('stack-item-added', notifyStack);
  um.on('stack-item-popped', notifyStack);
  um.on('stack-cleared', notifyStack);

  // ── plain → Y ──────────────────────────────────────────────────────────────
  /** A node's children recurse with the SAME childrenKey. */
  const childSpec = (childrenKey: string | undefined): CollabNestedSpec | undefined =>
    childrenKey ? { field: childrenKey, childrenKey } : undefined;

  function buildItem(item: Dict, nested: CollabNestedSpec | undefined): YItem {
    const ymap = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(item)) {
      if (v === undefined) continue;
      if (nested && k === nested.field && Array.isArray(v)) {
        ymap.set(k, buildArray(v as Dict[], childSpec(nested.childrenKey)));
      } else {
        ymap.set(k, v);
      }
    }
    yByPlain.set(item, ymap);
    plainByY.set(ymap, item);
    return ymap;
  }
  function buildArray(items: Dict[], nested: CollabNestedSpec | undefined): Y.Array<unknown> {
    const yarr = new Y.Array<unknown>();
    yarr.insert(0, items.map((it) => buildItem(it, nested)));
    return yarr;
  }

  // ── Y → plain ──────────────────────────────────────────────────────────────
  function materializeItem(ymap: YItem, nested: CollabNestedSpec | undefined, changed: Set<object> | null): Dict {
    const cached = plainByY.get(ymap);
    if (cached && changed && !changed.has(ymap)) return cached;
    const out: Dict = {};
    ymap.forEach((v, k) => {
      if (nested && k === nested.field && v instanceof Y.Array) {
        out[k] = (v as Y.Array<unknown>).toArray().map((c) =>
          c instanceof Y.Map ? materializeItem(c as YItem, childSpec(nested.childrenKey), changed) : c);
      } else {
        out[k] = v;
      }
    });
    yByPlain.set(out, ymap);
    plainByY.set(ymap, out);
    return out;
  }
  function materializeCollection(key: string, changed: Set<object> | null): Dict[] {
    const spec = specs.get(key);
    const v = root.get(key);
    if (!(v instanceof Y.Array)) return [];
    return (v as Y.Array<unknown>).toArray().map((it) =>
      it instanceof Y.Map ? materializeItem(it as YItem, spec?.nested, changed) : (it as Dict));
  }
  function materializeDoc(changed: Set<object> | null, changedKeys: Set<string> | null): Dict {
    const out: Dict = {};
    root.forEach((v, k) => {
      if (specs.has(k)) {
        // Unchanged collection ⇒ keep the previous array (object identity for
        // React + the same-commit remap contract).
        const prev = lastDoc[k];
        if (changedKeys && !changedKeys.has(k) && Array.isArray(prev)) { out[k] = prev; return; }
        out[k] = materializeCollection(k, changed);
      } else {
        out[k] = v;
      }
    });
    return out;
  }

  // ── the reconciler (local commit) ─────────────────────────────────────────
  function updateItem(ymap: YItem, oldItem: Dict, newItem: Dict, nested: CollabNestedSpec | undefined): void {
    const oldKeys = new Set(Object.keys(oldItem));
    for (const [k, v] of Object.entries(newItem)) {
      oldKeys.delete(k);
      if (v === undefined) { if (ymap.has(k)) ymap.delete(k); continue; }
      if (nested && k === nested.field && Array.isArray(v)) {
        const existing = ymap.get(k);
        const oldChildren = Array.isArray(oldItem[k]) ? (oldItem[k] as Dict[]) : [];
        if (existing instanceof Y.Array) {
          // Nested tree nodes carry no guaranteed id — positional pairing stays.
          reconcileArray(existing as Y.Array<unknown>, oldChildren, v as Dict[], childSpec(nested.childrenKey), undefined);
        } else {
          ymap.set(k, buildArray(v as Dict[], childSpec(nested.childrenKey)));
        }
        continue;
      }
      if (stringify(oldItem[k]) !== stringify(v)) ymap.set(k, v);
    }
    for (const k of oldKeys) if (ymap.has(k)) ymap.delete(k);
    yByPlain.set(newItem, ymap);
    plainByY.set(ymap, newItem);
  }

  /** Longest-increasing-subsequence indices (patience sorting, O(n log n)). */
  function lisIndices(seq: number[]): Set<number> {
    const tails: number[] = []; const tailIdx: number[] = []; const prev: number[] = new Array<number>(seq.length).fill(-1);
    for (let i = 0; i < seq.length; i++) {
      let lo = 0, hi = tails.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid]! < seq[i]!) lo = mid + 1; else hi = mid; }
      tails[lo] = seq[i]!; tailIdx[lo] = i;
      prev[i] = lo > 0 ? tailIdx[lo - 1]! : -1;
    }
    const out = new Set<number>();
    let k = tailIdx.length > 0 ? tailIdx[tails.length - 1]! : -1;
    while (k >= 0) { out.add(k); k = prev[k]!; }
    return out;
  }

  function reconcileArray(yarr: Y.Array<unknown>, oldItems: Dict[], newItems: Dict[], nested: CollabNestedSpec | undefined, idKey: string | undefined): void {
    // 1. Reference-identity matches (clone-on-edit sharing — the common case).
    const matched: (YItem | null)[] = newItems.map((it) => {
      const y = yByPlain.get(it);
      return y && y.parent === yarr ? y : null;
    });
    const used = new Set<YItem>(matched.filter((m): m is YItem => m !== null));
    // 2. Deep-equal fallback (full-clone gestures): content-identical ⇒ same item.
    const spareOld = oldItems
      .map((it) => ({ it, y: yByPlain.get(it) }))
      .filter((e): e is { it: Dict; y: YItem } => !!e.y && e.y.parent === yarr && !used.has(e.y));
    for (let i = 0; i < newItems.length; i++) {
      if (matched[i]) continue;
      const sig = stringify(newItems[i]);
      const hit = spareOld.findIndex((e) => stringify(e.it) === sig);
      if (hit >= 0) { matched[i] = spareOld[hit]!.y; used.add(spareOld[hit]!.y); spareOld.splice(hit, 1); }
    }
    // 3. Pairing of the leftovers ⇒ per-field update KEEPS identity.
    if (idKey) {
      // ADR 0364 — id-keyed collections pair by the stable id; an unmatched
      // id is a genuine delete/insert, never a positional cross-wire.
      const byId = new Map<unknown, { it: Dict; y: YItem }>();
      for (const e of spareOld) { const id = e.it[idKey]; if (id !== undefined && !byId.has(id)) byId.set(id, e); }
      for (let i = 0; i < newItems.length; i++) {
        if (matched[i]) continue;
        const id = newItems[i]![idKey];
        const hit = id !== undefined ? byId.get(id) : undefined;
        if (!hit) continue;
        byId.delete(id);
        const at = spareOld.indexOf(hit);
        if (at >= 0) spareOld.splice(at, 1);
        updateItem(hit.y, hit.it, newItems[i]!, nested);
        matched[i] = hit.y; used.add(hit.y);
      }
    } else {
      for (let i = 0; i < newItems.length && spareOld.length > 0; i++) {
        if (matched[i]) continue;
        const pair = spareOld.shift()!;
        updateItem(pair.y, pair.it, newItems[i]!, nested);
        matched[i] = pair.y; used.add(pair.y);
      }
    }
    // 4. Deletes — everything still unmatched.
    const doomed = new Set(spareOld.map((e) => e.y));
    for (let i = yarr.length - 1; i >= 0; i--) {
      const y = yarr.get(i);
      if (y instanceof Y.Map && (doomed.has(y as YItem) || !used.has(y as YItem))) yarr.delete(i, 1);
    }
    // 5. Ordering: keep the LIS of matched items in place; delete+rebuild the rest.
    const posOf = new Map<YItem, number>();
    for (let i = 0; i < yarr.length; i++) { const y = yarr.get(i); if (y instanceof Y.Map) posOf.set(y as YItem, i); }
    const matchedSeq: { newIdx: number; y: YItem; pos: number }[] = [];
    matched.forEach((y, newIdx) => { if (y && posOf.has(y)) matchedSeq.push({ newIdx, y, pos: posOf.get(y)! }); });
    const keep = lisIndices(matchedSeq.map((m) => m.pos));
    const kept = new Set<YItem>();
    matchedSeq.forEach((m, seqIdx) => { if (keep.has(seqIdx)) kept.add(m.y); });
    for (let i = yarr.length - 1; i >= 0; i--) {
      const y = yarr.get(i);
      if (y instanceof Y.Map && !kept.has(y as YItem)) yarr.delete(i, 1); // moved — rebuilt below (identity lost, documented)
    }
    // 6. Insert pass: walk the target order; anything not kept-in-place is
    //    built fresh. MONOTONE cursor (grade-pass CODE-4 — the previous
    //    per-item yarr rescan made every commit O(n²) on the hot drag path):
    //    after steps 4-5 the array holds EXACTLY the kept items, whose relative
    //    order (the LIS) matches ascending new-index order, so as we walk
    //    newItems each kept item is by construction the next un-passed element
    //    — the cursor only ever advances.
    let cursor = 0;
    for (let i = 0; i < newItems.length; i++) {
      const y = matched[i];
      if (y && kept.has(y)) {
        // Registrations refresh so the NEXT commit reference-matches this item.
        const plain = newItems[i]!;
        yByPlain.set(plain, y); plainByY.set(y, plain);
        cursor += 1;
        continue;
      }
      yarr.insert(cursor, [buildItem(newItems[i]!, nested)]);
      cursor += 1;
    }
  }

  function commit(next: Doc, newStep: boolean): void {
    const nextDict = next as Dict;
    if (newStep) um.stopCapturing();
    ydoc.transact(() => {
      const oldKeys = new Set<string>();
      root.forEach((_v, k) => { oldKeys.add(k); });
      for (const [k, v] of Object.entries(nextDict)) {
        oldKeys.delete(k);
        const spec = specs.get(k);
        if (spec) {
          const existing = root.get(k);
          const newArr = Array.isArray(v) ? (v as Dict[]) : [];
          const oldArr = Array.isArray(lastDoc[k]) ? (lastDoc[k] as Dict[]) : [];
          if (existing instanceof Y.Array) reconcileArray(existing as Y.Array<unknown>, oldArr, newArr, spec.nested, spec.idKey);
          else root.set(k, buildArray(newArr, spec.nested));
        } else if (v === undefined) {
          if (root.has(k)) root.delete(k);
        } else if (stringify(lastDoc[k]) !== stringify(v) || !root.has(k)) {
          root.set(k, v);
        }
      }
      for (const k of oldKeys) root.delete(k);
    }, LOCAL_ORIGIN);
    lastDoc = nextDict;
  }

  // ── remote / undo rebuild ──────────────────────────────────────────────────
  const observer = (events: Y.YEvent<Y.AbstractType<unknown>>[], txn: Y.Transaction): void => {
    if (txn.origin === LOCAL_ORIGIN || txn.origin === SEED_ORIGIN) return; // local mirror already current
    // Mark every changed type + its ancestors so materialization rebuilds
    // exactly the touched slices and reuses the rest by identity.
    const changed = new Set<object>();
    const changedKeys = new Set<string>();
    const remaps = new Map<string, (number | null)[]>();
    for (const ev of events) {
      let t: unknown = ev.target;
      while (t && typeof t === 'object' && t !== (root as unknown)) {
        changed.add(t);
        t = (t as { parent?: unknown }).parent ?? null;
      }
      const topKey = ev.path.length > 0 ? String(ev.path[0]) : (ev.target === (root as Y.AbstractType<unknown>) ? null : null);
      if (topKey && specs.has(topKey)) changedKeys.add(topKey);
      if (topKey === null && ev.target === (root as Y.AbstractType<unknown>) && ev instanceof Y.YMapEvent) {
        for (const k of ev.keysChanged) if (specs.has(String(k))) changedKeys.add(String(k));
      }
      // Top-level collection array delta → the old→new index map (ADR 0359 D4).
      if (ev.path.length === 1 && specs.has(String(ev.path[0])) && ev.target instanceof Y.Array) {
        const key = String(ev.path[0]);
        const oldLen = Array.isArray(lastDoc[key]) ? (lastDoc[key] as Dict[]).length : 0;
        const map: (number | null)[] = [];
        let oldIdx = 0; let newIdx = 0;
        for (const d of ev.changes.delta) {
          if (d.retain) { for (let i = 0; i < d.retain; i++) { map[oldIdx++] = newIdx++; } }
          else if (d.delete) { for (let i = 0; i < d.delete; i++) { map[oldIdx++] = null; } }
          else if (d.insert) { newIdx += Array.isArray(d.insert) ? d.insert.length : 1; }
        }
        while (oldIdx < oldLen) map[oldIdx++] = newIdx++;
        remaps.set(key, map);
      }
    }
    lastDoc = materializeDoc(changed, changedKeys);
    const remap: CollabIndexRemap = (key, idx) => {
      const m = remaps.get(key);
      if (!m) return idx; // collection untouched this transaction
      return idx >= 0 && idx < m.length ? m[idx]! : idx;
    };
    for (const cb of docListeners) cb(lastDoc, remap);
  };
  root.observeDeep(observer);

  return {
    seed(doc: Doc): void {
      ydoc.transact(() => {
        for (const [k, v] of Object.entries(doc as Dict)) {
          if (v === undefined) continue;
          const spec = specs.get(k);
          if (spec) root.set(k, buildArray(Array.isArray(v) ? (v as Dict[]) : [], spec.nested));
          else root.set(k, v);
        }
      }, SEED_ORIGIN);
      lastDoc = doc as Dict;
    },
    current(): Dict {
      lastDoc = materializeDoc(null, null);
      return lastDoc;
    },
    set(next: Doc): void { commit(next, true); },
    replace(next: Doc): void { commit(next, false); },
    undo(): void { um.undo(); },
    redo(): void { um.redo(); },
    canUndo(): boolean { return um.canUndo(); },
    canRedo(): boolean { return um.canRedo(); },
    onDocChanged(cb): () => void { docListeners.add(cb); return () => docListeners.delete(cb); },
    onStackChanged(cb): () => void { stackListeners.add(cb); return () => stackListeners.delete(cb); },
    destroy(): void {
      root.unobserveDeep(observer);
      um.destroy();
      docListeners.clear();
      stackListeners.clear();
    },
  };
}
