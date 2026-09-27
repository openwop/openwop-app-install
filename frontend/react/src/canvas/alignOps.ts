/**
 * Align / distribute over a multi-selection (ADR 0333 Phase 5, the C8 core
 * capability). Pure: takes the selected elements' bboxes + the collection's
 * `movePatchFor` (geometry is TYPE-owned — the chassis never guesses field
 * names) and returns ONE patch batch for `patchElements` (one undo step).
 * Locked/hidden elements are skipped (consistent with the gesture guard).
 * Figma-style tidy (equal-gap smart selection) is a recorded follow-up.
 */
import type { ViewBox } from './viewport.js';

export type AlignOp = 'left' | 'centerH' | 'right' | 'top' | 'middle' | 'bottom' | 'distributeH' | 'distributeV';

export interface AlignItem {
  idx: number;
  box: ViewBox;
  el: Record<string, unknown>;
}

export function computeAlignPatches(
  items: readonly AlignItem[],
  op: AlignOp,
  movePatchFor: (el: Record<string, unknown>, dx: number, dy: number) => Record<string, unknown>,
): { idx: number; patch: Record<string, unknown> }[] {
  const usable = items.filter((it) => it.el.locked !== true && it.el.hidden !== true);
  if (usable.length < 2) return [];

  const minX = Math.min(...usable.map((it) => it.box.x));
  const maxX = Math.max(...usable.map((it) => it.box.x + it.box.w));
  const minY = Math.min(...usable.map((it) => it.box.y));
  const maxY = Math.max(...usable.map((it) => it.box.y + it.box.h));

  const out: { idx: number; patch: Record<string, unknown> }[] = [];
  const push = (it: AlignItem, dx: number, dy: number): void => {
    if (!dx && !dy) return;
    const patch = movePatchFor(it.el, dx, dy);
    if (Object.keys(patch).length) out.push({ idx: it.idx, patch });
  };

  if (op === 'distributeH' || op === 'distributeV') {
    // Outermost keep position; interior boxes spread with equal GAPS between
    // box edges (the Figma distribute semantics). Needs ≥3 to move anything.
    if (usable.length < 3) return [];
    const horiz = op === 'distributeH';
    const sorted = [...usable].sort((a, b) => (horiz ? a.box.x - b.box.x : a.box.y - b.box.y));
    const span = horiz ? maxX - minX : maxY - minY;
    const totalSize = sorted.reduce((acc, it) => acc + (horiz ? it.box.w : it.box.h), 0);
    const gap = (span - totalSize) / (sorted.length - 1);
    let cursor = horiz ? minX : minY;
    for (const it of sorted) {
      const cur = horiz ? it.box.x : it.box.y;
      const d = cursor - cur;
      push(it, horiz ? d : 0, horiz ? 0 : d);
      cursor += (horiz ? it.box.w : it.box.h) + gap;
    }
    return out;
  }

  for (const it of usable) {
    const b = it.box;
    switch (op) {
      case 'left': push(it, minX - b.x, 0); break;
      case 'centerH': push(it, (minX + maxX) / 2 - (b.x + b.w / 2), 0); break;
      case 'right': push(it, maxX - (b.x + b.w), 0); break;
      case 'top': push(it, 0, minY - b.y); break;
      case 'middle': push(it, 0, (minY + maxY) / 2 - (b.y + b.h / 2)); break;
      case 'bottom': push(it, 0, maxY - (b.y + b.h)); break;
    }
  }
  return out;
}
