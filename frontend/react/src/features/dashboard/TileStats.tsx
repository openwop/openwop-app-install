/**
 * TileStats (ADR 0375 Phase 3) — the shared compact metric readout for the
 * business-metrics tiles (CRM / Commerce / Campaign / Funnel). A row of
 * label-over-value figures; token-only, no per-tile bespoke layout.
 *
 * ADR 0377 Wave 2: a stat MAY carry a `delta` (change vs the prior period) —
 * rendered as a signed ▲/▼ glyph + the formatted number, so direction is never
 * color-alone (the token color pairs WITH the glyph, per DESIGN.md §5.3).
 */
import type { ReactNode } from 'react';

export interface Stat {
  label: string;
  value: ReactNode;
  /** Signed change vs the prior period; preformatted by the tile. */
  delta?: { value: number; display: string } | undefined;
}

export function TileStats({ stats }: { stats: Stat[] }): JSX.Element {
  return (
    <dl className="dash-tile__stats u-m-0">
      {stats.map((s) => (
        <div key={s.label} className="dash-tile__stat">
          <dt className="dash-tile__stat-label muted">{s.label}</dt>
          <dd className="dash-tile__stat-value u-m-0">
            {s.value}
            {s.delta && s.delta.value !== 0 ? (
              <span className={s.delta.value > 0 ? 'dash-tile__delta dash-tile__delta--up' : 'dash-tile__delta dash-tile__delta--down'}>
                {s.delta.value > 0 ? '▲' : '▼'} {s.delta.display}
              </span>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
