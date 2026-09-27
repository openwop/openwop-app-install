/**
 * Per-kind style memory (ADR 0333 Phase 2) — "the last style you used becomes
 * the default for the next element" (the tldraw convention, adopted by the
 * research doc's UX commitment #12). SESSION-EPHEMERAL BY DESIGN: this is a
 * default-feeder, not document state — nothing here rides the wire or the
 * artifact schema. Keyed `typeId:collection:kind`; only the collection's
 * declared `styleKeys` are remembered (geometry never is — a new rect should
 * not appear at the last one's position).
 */

const memory = new Map<string, Record<string, unknown>>();

const keyOf = (typeId: string, col: string, kind: string): string => `${typeId}:${col}:${kind}`;

/** Remember the style fields of `el` (filtered to `styleKeys`). Merges over
 *  what's already remembered so a partial patch (one field edited) keeps the
 *  rest of the remembered style. */
export function rememberStyle(
  typeId: string,
  col: string,
  kind: string,
  el: Record<string, unknown>,
  styleKeys: readonly string[],
): void {
  if (!styleKeys.length) return;
  const picked: Record<string, unknown> = {};
  for (const k of styleKeys) {
    const v = el[k];
    if (v !== undefined && v !== null && v !== '') picked[k] = v;
  }
  if (!Object.keys(picked).length) return;
  const key = keyOf(typeId, col, kind);
  memory.set(key, { ...memory.get(key), ...picked });
}

/** The remembered style for a kind (empty object when none). */
export function recallStyle(typeId: string, col: string, kind: string): Record<string, unknown> {
  return { ...memory.get(keyOf(typeId, col, kind)) };
}

/** Test seam. */
export function clearStyleMemory(): void {
  memory.clear();
}
