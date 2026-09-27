/**
 * TileList (ADR 0377 Wave 1) — the shared compact row list for list-shaped
 * dashboard tiles. Mirrors `TileStats` for the metric shape: one renderer, so
 * every list tile reads identically (row = main label linking into the owning
 * feature + a small muted meta). Token-only; reuses the `.dash-tile__list`
 * classes the Phase-2/3 tiles established.
 */
import { Link } from 'react-router-dom';

export interface TileRow {
  key: string;
  label: string;
  /** In-app deep link into the owning feature (the page whose tier gated this tile).
   *  `| undefined` forms: exactOptionalPropertyTypes-friendly for mapped rows. */
  to?: string | undefined;
  meta?: string | undefined;
  /** Hover tooltip; defaults to the label. */
  title?: string | undefined;
}

export function TileList({ rows }: { rows: TileRow[] }): JSX.Element {
  return (
    <ul className="dash-tile__list u-list-none u-m-0 u-p-0">
      {rows.map((r) => (
        <li key={r.key} className="dash-tile__row">
          {r.to ? (
            <Link to={r.to} className="dash-tile__row-main u-truncate" title={r.title ?? r.label}>{r.label}</Link>
          ) : (
            <span className="dash-tile__row-main u-truncate" title={r.title ?? r.label}>{r.label}</span>
          )}
          {r.meta ? <span className="dash-tile__row-meta muted">{r.meta}</span> : null}
        </li>
      ))}
    </ul>
  );
}
