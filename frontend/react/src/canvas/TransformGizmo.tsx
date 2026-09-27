/**
 * TransformGizmo (ADR 0388 P3 — the core gizmo seam). The generic selection
 * chrome for a spatial canvas: outline + rotate knob + resize handles,
 * rendered INSIDE the caller's SVG scene. The caller owns all geometry math
 * (screen box, rotation, what a handle does); the gizmo owns the visuals and
 * pointer plumbing — so any canvas type (CAD today; drawings/others may
 * adopt) consumes one look-and-feel without inheriting another type's math.
 *
 * Extracted from InteractiveCad's ADR 0317 selection overlay (the placement
 * rule: it lands in src/canvas/ because a second canvas type can plausibly
 * consume it). Class names are the established cv-draw-interactive vocabulary.
 */

export interface GizmoGeom {
  left: number;
  top: number;
  pw: number;
  ph: number;
  cx: number;
  cy: number;
  rot: number;
}

export interface GizmoHandle {
  id: string;
  /** Where the handle sits + which axis it drags (caller-interpreted). */
  x: number;
  y: number;
}

const KNOB = 22; // viewBox units — the rotate stalk length above the selection

export function TransformGizmo({
  geom,
  handles,
  onRotateStart,
  onResizeStart,
  showRotate = true,
}: {
  geom: GizmoGeom;
  handles: GizmoHandle[];
  onRotateStart: (e: React.PointerEvent) => void;
  onResizeStart: (handleId: string, e: React.PointerEvent) => void;
  showRotate?: boolean;
}): JSX.Element {
  const g = geom;
  return (
    <g aria-hidden transform={g.rot ? `rotate(${g.rot} ${g.cx} ${g.cy})` : undefined}>
      <rect className="cv-draw-interactive__outline" x={g.left - 3} y={g.top - 3} width={g.pw + 6} height={g.ph + 6} />
      <rect className="cv-draw-interactive__outline-top" x={g.left - 3} y={g.top - 3} width={g.pw + 6} height={g.ph + 6} />

      {showRotate ? (
        <>
          <line className="cv-draw-interactive__rotate-stalk" x1={g.cx} y1={g.top - 3} x2={g.cx} y2={g.top - KNOB} />
          <circle className="cv-draw-interactive__handle-hit" cx={g.cx} cy={g.top - KNOB} r={9} onPointerDown={onRotateStart} />
          <circle className="cv-draw-interactive__rotate-knob" cx={g.cx} cy={g.top - KNOB} r={4} />
        </>
      ) : null}

      {handles.map((h) => (
        <g key={h.id}>
          <rect className="cv-draw-interactive__handle-hit" x={h.x - 9} y={h.y - 9} width={18} height={18} onPointerDown={(e) => onResizeStart(h.id, e)} />
          <rect className="cv-draw-interactive__handle" x={h.x - 4} y={h.y - 4} width={8} height={8} />
        </g>
      ))}
    </g>
  );
}
