/**
 * Pure geometry for the CAD gizmo (ADR 0317 follow-up) — rotate + resize a
 * `canvas.cad` solid. No DOM/React, so the math is unit-testable while
 * `InteractiveCad` stays thin plumbing. Rotation is in-plane (front-elevation,
 * screen-space degrees). Resize is CENTRE-PRESERVING (the footprint centre is
 * the rotate pivot, so resize stays correct under rotation): a handle changes a
 * dimension and shifts the anchor so the centre — and thus the rotation — holds.
 */

type Solid = Record<string, unknown>;
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Rotate (px,py) by `deg` degrees (clockwise, screen convention) about (cx,cy). */
export function rotatePoint(px: number, py: number, cx: number, cy: number, deg: number): { x: number; y: number } {
  const r = (deg * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  const dx = px - cx, dy = py - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

/** The gizmo knob → a `rotation` in degrees. The knob rests ABOVE the shape
 *  (screen angle -90°), so pointing straight up is 0°. Rounded, normalized to
 *  [0,360). */
export function cadRotatePatch(cx: number, cy: number, px: number, py: number): { rotation: number } {
  const deg = (Math.atan2(py - cy, px - cx) * 180) / Math.PI + 90;
  return { rotation: ((Math.round(deg) % 360) + 360) % 360 };
}

/** The MODEL-space footprint centre of a solid (mirrors `cadFootprint`). */
export function solidCenter(s: Solid): { x: number; y: number } {
  const x = num(s.x), y = num(s.y);
  switch (s.kind) {
    case 'box': return { x: x + num(s.width) / 2, y: y + num(s.height) / 2 };
    case 'sphere': return { x: x + num(s.radius), y: y + num(s.radius) };
    case 'cylinder': case 'cone': return { x: x + num(s.radius), y: y + num(s.length) / 2 };
    default: return { x, y };
  }
}

/** Which resize handles a kind exposes (the component positions them). A sphere
 *  gets one uniform-radius handle; a box gets width + height; a cylinder/cone
 *  gets radius + length. `axis` says which local direction drives the value. */
export type CadHandle = { id: string; axis: 'x' | 'y' | 'diag' };
export function cadResizeHandles(kind: unknown): CadHandle[] {
  switch (kind) {
    case 'box': return [{ id: 'w', axis: 'x' }, { id: 'h', axis: 'y' }];
    case 'sphere': return [{ id: 'r', axis: 'diag' }];
    case 'cylinder': case 'cone': return [{ id: 'r', axis: 'x' }, { id: 'len', axis: 'y' }];
    default: return [];
  }
}

/** The patch for setting handle `id` to the new model dimension `newDim`,
 *  keeping the footprint CENTRE fixed (so rotation about it is unaffected).
 *  Dimensions clamp to a 1-unit floor. Unknown handle ⇒ no change. */
export function cadResizePatch(s: Solid, handleId: string, newDim: number): Record<string, unknown> {
  const c = solidCenter(s);
  const d = Math.max(1, Math.round(newDim));
  switch (handleId) {
    case 'w': return { width: d, x: Math.round(c.x - d / 2) };
    case 'h': return { height: d, y: Math.round(c.y - d / 2) };
    case 'len': return { length: d, y: Math.round(c.y - d / 2) };
    case 'r':
      // radius resize: footprint is centred on x+r (box-less kinds), so keep the
      // centre by re-anchoring x (and y for a sphere, whose footprint is square).
      return s.kind === 'sphere'
        ? { radius: d, x: Math.round(c.x - d), y: Math.round(c.y - d) }
        : { radius: d, x: Math.round(c.x - d) };
    default: return {};
  }
}
