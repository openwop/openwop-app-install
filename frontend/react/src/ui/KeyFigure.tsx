/**
 * KeyFigureBand — the canonical "key figures" surface (DESIGN.md §4.5 "stats are
 * filters" + §5.1). Consolidates the bespoke run-stat / wf-figure / wforce-metric
 * patterns into one primitive built around the app's most distinctive signature:
 * the Instrument-Serif tabular numeral over a Geist-Mono uppercase label.
 *
 * When `onToggle` is supplied the tiles become **filter controls** (`aria-pressed`)
 * — the §4.5 law that a figure both reports and filters the data below it — with a
 * clay active wash + left bar. `tone:'attention'` renders an at-risk count in amber.
 * Token-only; no color literals.
 */
import type { ReactNode } from 'react';

export interface KeyFigureItem {
  /** stable key — also the filter value passed to onToggle. */
  key: string;
  label: string;
  value: string | number;
  /** 'attention' tints the numeral amber for at-risk / needs-you counts. */
  tone?: 'default' | 'attention';
  glyph?: ReactNode;
}

export function KeyFigureBand({
  figures,
  activeKey,
  onToggle,
  ariaLabel = 'Key figures',
}: {
  figures: KeyFigureItem[];
  /** when set (incl. null), tiles become filter toggles; null = none active. */
  activeKey?: string | null;
  onToggle?: (key: string) => void;
  ariaLabel?: string;
}): JSX.Element {
  const interactive = typeof onToggle === 'function';
  return (
    <div className="figure-band" role="group" aria-label={ariaLabel}>
      {figures.map((f) => {
        const active = interactive && activeKey === f.key;
        const cls = `figure-tile${f.tone === 'attention' ? ' figure-tile--attention' : ''}${active ? ' figure-tile--active' : ''}`;
        const body = (
          <>
            <span className="figure-tile__value">{f.value}</span>
            <span className="figure-tile__label">
              {f.glyph ? <span className="figure-tile__glyph" aria-hidden="true">{f.glyph}</span> : null}
              {f.label}
            </span>
          </>
        );
        return interactive ? (
          <button key={f.key} type="button" className={cls} aria-pressed={active} onClick={() => onToggle!(f.key)}>
            {body}
          </button>
        ) : (
          <div key={f.key} className={cls}>{body}</div>
        );
      })}
    </div>
  );
}
