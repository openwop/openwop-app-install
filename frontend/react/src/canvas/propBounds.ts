/**
 * Canvas framework — property-bound clamping (ADR 0333 grade pass DRAW-R4 /
 * DATA-D9). A `CanvasPropDef` may carry `min`/`max`/`step`/`maxLength` that
 * mirror the type's backend validator. The property widgets apply them live
 * (native input attributes + a blur clamp), and the chassis normalizes the doc
 * once more at the save boundary here — so a value that reached the doc without
 * a blur (paste, a programmatic edit, an AI-authored artifact) is bounded before
 * the CAS save rather than 422ing. The backend validator stays the authority;
 * this only avoids an avoidable rejection.
 */
import { readElements } from './elementOps.js';
import type { CanvasPropDef } from './types.js';

const dict = (o: object): Record<string, unknown> => o as Record<string, unknown>;

/** Clamp a finite number into `[min, max]`. Undefined bounds pass through. */
export function clampNumber(n: number, min?: number, max?: number): number {
  let v = n;
  if (typeof min === 'number' && v < min) v = min;
  if (typeof max === 'number' && v > max) v = max;
  return v;
}

/** Return the bounded value for one field under its def, or the SAME reference
 *  when nothing changed (so callers can detect no-ops cheaply). Only finite
 *  numbers and over-length strings are touched — an undefined/cleared value or a
 *  def without bounds passes through untouched (preserves the "'' clears the
 *  field" contract the number widget relies on). */
export function clampValue(value: unknown, def: CanvasPropDef): unknown {
  if (def.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return value;
    return clampNumber(value, def.min, def.max);
  }
  if ((def.type === 'string' || def.type === 'longtext') && typeof def.maxLength === 'number') {
    if (typeof value === 'string' && value.length > def.maxLength) return value.slice(0, def.maxLength);
  }
  return value;
}

/** Shape the chassis reads off a `CanvasEditorDefinition` to bound a doc. */
interface BoundedDefinition {
  elements?: readonly { key: string; propDefs: (el: Record<string, unknown>) => CanvasPropDef[] }[];
  docPropDefs?: readonly CanvasPropDef[];
}

/** Return a doc whose numeric/text fields are clamped to their propDef bounds —
 *  a NEW object only where something changed (the input, and every unchanged
 *  element/array, are shared, never mutated: the ADR 0317 clone-on-edit
 *  invariant holds at the save boundary too). Doc-level props come from
 *  `docPropDefs`; each elements collection is bounded per element by its own
 *  `propDefs(el)`. */
export function clampDocForSave<D extends object>(doc: D, def: BoundedDefinition): D {
  let out: Record<string, unknown> | null = null;
  const ensure = (): Record<string, unknown> => (out ??= { ...(doc as Record<string, unknown>) });

  for (const pd of def.docPropDefs ?? []) {
    const cur = dict(doc)[pd.name];
    const next = clampValue(cur, pd);
    if (next !== cur) ensure()[pd.name] = next;
  }

  for (const col of def.elements ?? []) {
    const list = readElements(doc, col.key);
    let nextList: Record<string, unknown>[] | null = null;
    list.forEach((el, i) => {
      let nextEl: Record<string, unknown> | null = null;
      for (const pd of col.propDefs(el)) {
        const cur = el[pd.name];
        const next = clampValue(cur, pd);
        if (next !== cur) (nextEl ??= { ...el })[pd.name] = next;
      }
      if (nextEl) (nextList ??= list.slice())[i] = nextEl;
    });
    if (nextList) ensure()[col.key] = nextList;
  }

  return (out ?? doc) as D;
}
