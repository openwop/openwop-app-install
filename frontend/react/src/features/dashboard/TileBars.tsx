/**
 * TileBars (ADR 0377 Wave 2) — the shared horizontal distribution-bar readout
 * for chart-shaped tiles. Generalizes the `.crm-meter` track+fill + the
 * `.crm-funnel-row` label/bar/count layout into ONE dashboard renderer.
 * A11y: the value is ALWAYS rendered as text beside the bar — the bar itself is
 * decorative (`aria-hidden`), so nothing is conveyed by geometry/color alone.
 * Token-only; no chart library (ADR 0377 posture).
 */
export interface TileBar {
  key: string;
  label: string;
  value: number;
  /** Preformatted display for the value (defaults to String(value)). */
  display?: string | undefined;
}

export function TileBars({ bars, max }: { bars: TileBar[]; max?: number }): JSX.Element {
  const top = Math.max(max ?? 0, ...bars.map((b) => b.value), 1);
  return (
    <div className="dash-tile__bars">
      {bars.map((b) => (
        <div key={b.key} className="dash-tile__bar-row">
          <span className="dash-tile__bar-label u-truncate" title={b.label}>{b.label}</span>
          <span className="dash-tile__bar-track" aria-hidden="true">
            <span className="dash-tile__bar-fill" style={{ width: `${Math.max(0, Math.min(100, (b.value / top) * 100))}%` }} />
          </span>
          <span className="dash-tile__bar-value muted">{b.display ?? String(b.value)}</span>
        </div>
      ))}
    </div>
  );
}
