/**
 * KeyFigureBand — the canonical "key figures" surface (DESIGN.md §4.5 "stats are
 * filters" + §5.1). Consolidates the bespoke run-stat / wf-figure / wforce-metric
 * patterns into one primitive.
 *
 * REDESIGNED 2026-08-08 (David's directive, from a reference). Each figure is now
 * a SEPARATE card reading top-down — mono uppercase label, then the numeral, then
 * the optional context line — all start-aligned. Previously the band was one ruled
 * container of joined tiles, each centred on the numeral with its label beneath.
 *
 * The numeral is SANS at weight 700. DESIGN.md §1 had listed the figure numeral as
 * one of four surviving Instrument-Serif accents; that is overturned for this
 * component only (correction note recorded there). The wordmark, gate product name
 * and ledger persona names keep the serif.
 *
 * When `onToggle` is supplied the cards become **filter controls** (`aria-pressed`)
 * — the §4.5 law that a figure both reports and filters the data below it — with a
 * clay active wash, border and edge bar. `tone:'attention'` renders an at-risk
 * count in amber. Token-only; no color literals.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export interface KeyFigureItem {
  /** stable key — also the filter value passed to onToggle. */
  key: string;
  label: string;
  value: string | number;
  /** 'attention' tints the numeral amber for at-risk / needs-you counts. */
  tone?: 'default' | 'attention';
  glyph?: ReactNode;
  /** Optional one-line context under the value (e.g. "+12% vs prior 30 days").
   *  `subTone` tints it for direction; 'neutral' stays muted. */
  sub?: string;
  subTone?: 'up' | 'down' | 'neutral';
}

export function KeyFigureBand({
  figures,
  activeKey,
  onToggle,
  ariaLabel,
}: {
  figures: KeyFigureItem[];
  /** when set (incl. null), tiles become filter toggles; null = none active. */
  activeKey?: string | null;
  onToggle?: (key: string) => void;
  ariaLabel?: string;
}): JSX.Element {
  const { t } = useTranslation('ui');
  const interactive = typeof onToggle === 'function';
  return (
    <div className="figure-band" role="group" aria-label={ariaLabel ?? t('keyFiguresLabel')}>
      {figures.map((f) => {
        const active = interactive && activeKey === f.key;
        const cls = `figure-tile${f.tone === 'attention' ? ' figure-tile--attention' : ''}${active ? ' figure-tile--active' : ''}`;
        const body = (
          <>
            {/* Label FIRST — visually (it heads the card) and in the DOM, so a
                screen reader announces "action needed, 9" rather than "9,
                action needed". The old order put the figure ahead of its own
                subject. */}
            <span className="figure-tile__label">
              {f.glyph ? <span className="figure-tile__glyph" aria-hidden="true">{f.glyph}</span> : null}
              {f.label}
            </span>
            <span className="figure-tile__value">{f.value}</span>
            {f.sub ? (
              <span className={`figure-tile__sub${f.subTone === 'up' ? ' figure-tile__sub--up' : f.subTone === 'down' ? ' figure-tile__sub--down' : ''}`}>
                {f.sub}
              </span>
            ) : null}
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
