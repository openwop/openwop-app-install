/**
 * Peer-selection scene overlays (ADR 0359 residuals — the deferred D5 half).
 * The ONE SVG renderer both interactive previews (drawings, cad) mount for
 * "who has what selected" IN the scene: a dashed outline in the peer's
 * identity hue (the same hue as their toolbar avatar and document caret —
 * one presence grammar) plus a small name flag. The flag is also the designed
 * answer to hue-proximity at small sizes: glance disambiguation comes from
 * the NAME, never color alone.
 *
 * Grade-pass 3 flag layout (UX findings 2-4): flags COLLISION-STACK (two
 * peers on the same/nearby elements show both names, stacked), FLIP below the
 * box when the element sits at the top edge (never clipped off-canvas), and
 * accept a `flagScale` factor so a preview with screen-constant chrome
 * (drawings) keeps the flag screen-constant too (CAD's own chrome scales with
 * zoom, so its flags scale consistently by omitting the prop). Flag text
 * reads via the theme-STABLE `--collab-flag-text` token over the
 * luminance-clamped peer hue (≥4.5:1 in both themes — see `collabUserColor`).
 *
 * Pointer-inert and `aria-hidden` — the element-list rail markers remain the
 * accessible path (ADR 0317's "pointer enhancements need non-pointer twins").
 * Colors arrive as runtime data (peer hex), the sanctioned caret pattern.
 */

export interface PeerOutline {
  x: number; y: number; w: number; h: number;
  name: string;
  color: string;
  /** SVG transform (a rotated shape's outline must track its rotation, exactly
   *  like the local selection chrome). */
  transform?: string;
}

const PAD = 3;
const FLAG_H = 13;
const MAX_NAME = 18;
const FLAG_GAP = 2;

interface PlacedFlag { x: number; y: number; w: number; h: number }

export function PeerSelectionOverlays({ outlines, flagScale = 1 }: {
  outlines: readonly PeerOutline[];
  /** Multiply flag geometry by this (a screen-constant factor like
   *  `screenConstant(1, zoom)`) so flags hold their on-screen size in a
   *  zoomable scene whose chrome is screen-constant. Default 1 = scene units. */
  flagScale?: number;
}): JSX.Element | null {
  if (outlines.length === 0) return null;
  const fh = FLAG_H * flagScale;
  const gap = FLAG_GAP * flagScale;
  const placed: PlacedFlag[] = [];
  return (
    <g aria-hidden="true" pointerEvents="none" className="cv-peer-outlines">
      {outlines.map((o, i) => {
        const name = o.name.length > MAX_NAME ? `${o.name.slice(0, MAX_NAME - 1)}…` : o.name;
        const fw = (name.length * 6.2 + 10) * flagScale;
        const fx = o.x - PAD;
        // Above the box; FLIP below when that would clip past the scene top
        // (UX finding 3 — elements commonly sit flush to the top edge).
        let fy = o.y - PAD - fh - gap;
        if (fy < 0) fy = o.y + o.h + PAD + gap;
        // Collision stacking (UX finding 2): co-selections must show EVERY
        // name — shift down past any already-placed overlapping flag.
        const overlaps = (): boolean => placed.some((p) => fx < p.x + p.w && p.x < fx + fw && fy < p.y + p.h + gap && p.y < fy + fh + gap);
        while (overlaps()) fy += fh + gap;
        placed.push({ x: fx, y: fy, w: fw, h: fh });
        return (
          <g key={`${o.name}:${o.x}:${o.y}:${i}`} {...(o.transform ? { transform: o.transform } : {})}>
            <rect
              x={o.x - PAD} y={o.y - PAD} width={o.w + PAD * 2} height={o.h + PAD * 2}
              fill="none" stroke={o.color} strokeWidth={1.5} strokeDasharray="5 3"
              vectorEffect="non-scaling-stroke" rx={2}
            />
            {/* The flag lays out at fixed px inside a scaled group, so the
                collision/flip math above and the visual size stay in sync. */}
            <g transform={`translate(${fx}, ${fy}) scale(${flagScale})`}>
              <rect width={fw / flagScale} height={FLAG_H} rx={3} fill={o.color} />
              <text x={5} y={10} className="cv-peer-outlines__name">{name}</text>
            </g>
          </g>
        );
      })}
    </g>
  );
}
