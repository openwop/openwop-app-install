/**
 * Sparkline (ADR 0377 Wave 2) — the ONE inline-SVG trend line for time-series
 * tiles. No chart library (ADR 0377 posture): a single normalized polyline,
 * stroked with `currentColor` so the tile controls the token color via CSS.
 * A11y: the consuming tile MUST pass `label` (rendered as role="img" +
 * aria-label) or show the series' meaning in adjacent text and pass none
 * (then the SVG is aria-hidden decoration).
 */
const W = 120;
const H = 28;
const PAD = 2;

export function Sparkline({ points, label, className, domain }: {
  points: number[];
  label?: string | undefined;
  /** Consumer-owned styling hook (ux review — a ui/ primitive must not bake
   *  in a feature's BEM class; dashboard tiles pass 'dash-tile__spark'). */
  className?: string | undefined;
  /** Fixed y-domain for BOUNDED series (ux review M6 — min-max normalizing a
   *  0..1 pass rate drew a perfect week as a flatline at the BOTTOM edge and
   *  rendered a 99→100% wiggle indistinguishable from 20→100%). */
  domain?: [number, number] | undefined;
}): JSX.Element | null {
  if (points.length < 2) return null;
  const min = domain ? domain[0] : Math.min(...points);
  const max = domain ? domain[1] : Math.max(...points);
  const span = max - min || 1;
  const step = (W - PAD * 2) / (points.length - 1);
  // SVG coordinate geometry (NOT user-facing text — locale formatting stays in
  // i18n/format.ts): round to 0.1px arithmetically, no toFixed.
  const r1 = (n: number): number => Math.round(n * 10) / 10;
  const pts = points
    .map((p, i) => `${r1(PAD + i * step)},${r1(H - PAD - ((p - min) / span) * (H - PAD * 2))}`)
    .join(' ');
  return (
    <svg
      {...(className ? { className } : {})}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
