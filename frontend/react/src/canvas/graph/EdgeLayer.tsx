/**
 * The SVG connector overlay for the graph surface (ADR 0323). One `<svg>` under
 * the node layer, a `<path>` per edge (a wide invisible hit-path + the visible
 * stroke), routed by the pure `edgeRouting` helpers. Selectable + deletable via
 * callbacks; the chassis owns the actual mutation. Paint is design-token driven
 * (no raw color literals) — the stroke/marker colors come from CSS on the classes.
 */
import { edgePath, edgeMidpoint, type Box, type Edge, type Routing } from './edgeRouting.js';
import type { GraphEdgeView } from '../types.js';

export interface EdgeLayerProps {
  /** Resolved node boxes in canvas coords, keyed by node id. */
  boxes: Map<string, Box>;
  edges: GraphEdgeView[];
  selectedEdgeId: string | null;
  onSelectEdge: (id: string) => void;
  /** A live connect-drag preview (source port → cursor), canvas coords. */
  preview?: { from: string; sourceEdge: Edge; to: { x: number; y: number } } | null;
  /** Extent of the drawing, so the svg sizes to hold everything. */
  width: number;
  height: number;
}

export function EdgeLayer({ boxes, edges, selectedEdgeId, onSelectEdge, preview, width, height }: EdgeLayerProps): JSX.Element {
  return (
    <svg className="cv-graph__edges" width={width} height={height} aria-hidden>
      <defs>
        <marker id="cv-graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path className="cv-graph__arrowhead" d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
        <marker id="cv-graph-arrow-sel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path className="cv-graph__arrowhead cv-graph__arrowhead--sel" d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>
      {edges.map((e) => {
        const a = boxes.get(e.from);
        const b = boxes.get(e.to);
        if (!a || !b) return null; // dangling edge — the outline surfaces it; nothing to draw
        const routing: Routing = e.routing ?? 'bezier';
        const opts = { ...(e.sourceEdge ? { sourceEdge: e.sourceEdge } : {}), ...(e.targetEdge ? { targetEdge: e.targetEdge } : {}), routing };
        const d = edgePath(a, b, opts);
        const selected = e.id === selectedEdgeId;
        const mid = edgeMidpoint(a, b, opts);
        return (
          <g key={e.id}>
            {/* Wide invisible hit-path for easy clicking. */}
            <path
              className="cv-graph__edge-hit"
              d={d}
              onClick={(ev) => { ev.stopPropagation(); onSelectEdge(e.id); }}
            />
            <path
              className={`cv-graph__edge${selected ? ' cv-graph__edge--sel' : ''}${e.animated ? ' cv-graph__edge--anim' : ''}`}
              d={d}
              markerEnd={`url(#cv-graph-arrow${selected ? '-sel' : ''})`}
            />
            {e.label ? (
              <text className="cv-graph__edge-label" x={mid.x} y={mid.y} dy={-4} textAnchor="middle">{e.label}</text>
            ) : null}
          </g>
        );
      })}
      {preview ? (() => {
        const a = boxes.get(preview.from);
        if (!a) return null;
        const s = { x: preview.sourceEdge === 'left' ? a.x : preview.sourceEdge === 'right' ? a.x + a.w : a.x + a.w / 2, y: preview.sourceEdge === 'top' ? a.y : preview.sourceEdge === 'bottom' ? a.y + a.h : a.y + a.h / 2 };
        return <path className="cv-graph__edge cv-graph__edge--preview" d={`M ${s.x} ${s.y} L ${preview.to.x} ${preview.to.y}`} markerEnd="url(#cv-graph-arrow)" />;
      })() : null}
    </svg>
  );
}
