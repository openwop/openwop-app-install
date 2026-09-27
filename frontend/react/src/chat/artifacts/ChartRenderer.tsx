/**
 * ChartRenderer (ADR 0128 Phase 4) — render an `interactive.chart` artifact.
 *
 * A chart is untrusted MODEL-GENERATED DATA (not code), so — unlike the HTML/Mermaid
 * renderers (sandboxed iframes) — it renders as inline SVG VIA REACT: every label/number
 * goes through `textContent`/JSX (auto-escaped), there is NO `innerHTML`, NO eval, and NO
 * charting-library dependency. XSS-safe by construction. A malformed/unsupported spec
 * DEGRADES to the raw JSON (never throws, never blanks).
 *
 * Spec (the registered `interactive.chart` schema): `{ chartType, data, options? }` where
 * `data = { labels: string[], datasets: [{ label?, data: number[] }] }` (the common
 * Chart.js-ish shape). v1 supports `bar` + `line`; others fall back to raw.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

interface ChartSpec { chartType: string; data: { labels?: unknown; datasets?: unknown }; options?: unknown }

/** The renderer's ACTUAL closed world — the Visualizer agent prompt is pinned
 *  to this list (XCH-IA-1, LLM-EXCHANGE-AUDIT Wave 3); others fall back raw. */
export const SUPPORTED_CHART_TYPES: readonly string[] = ['bar', 'line'];
interface Series { label: string; values: number[] }

// IART-5: bound the SVG node count — a huge `data` array would otherwise mint an enormous
// inline SVG. Caps are generous for real charts; excess is truncated.
const MAX_SERIES = 24;
const MAX_POINTS = 1000;

function parse(content: string): { chartType: string; labels: string[]; series: Series[] } | null {
  try {
    const spec = JSON.parse(content) as ChartSpec;
    const chartType = typeof spec.chartType === 'string' ? spec.chartType : '';
    const labels = (Array.isArray(spec.data?.labels) ? (spec.data.labels as unknown[]).map((l) => String(l)) : []).slice(0, MAX_POINTS);
    const datasets = (Array.isArray(spec.data?.datasets) ? (spec.data.datasets as Array<{ label?: unknown; data?: unknown }>) : []).slice(0, MAX_SERIES);
    const series: Series[] = datasets.map((d, i) => ({
      label: typeof d.label === 'string' ? d.label : `Series ${i + 1}`,
      values: (Array.isArray(d.data) ? (d.data as unknown[]).map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)) : []).slice(0, MAX_POINTS),
    }));
    if (!chartType || series.length === 0) return null;
    return { chartType, labels, series };
  } catch (err) {
    // IART-4: surface the parse failure (was silently swallowed) — the caller renders the
    // raw spec inert, but chronic malformed chart output is otherwise invisible.
    if (typeof console !== 'undefined') console.warn('[artifact] chart spec parse failed', err instanceof Error ? err.message : err);
    return null;
  }
}

const W = 480, H = 260, PAD = 32;

/** Series ramp — the app's categorical accent tokens (DESIGN.md §3), cycled.
 *  Token-only so both themes stay legible; hue-spaced so adjacent series
 *  differ by hue, not just lightness (ART-1). */
const SERIES_TOKENS = [
  'var(--cat-flow)',
  'var(--cat-data)',
  'var(--cat-control)',
  'var(--cat-ai)',
  'var(--cat-integration)',
] as const;
const seriesColor = (i: number): string => SERIES_TOKENS[i % SERIES_TOKENS.length]!;

export function ChartRenderer({ content }: { content: string }): JSX.Element {
  const { t } = useTranslation('chat');
  const chart = useMemo(() => parse(content), [content]);
  if (!chart || !SUPPORTED_CHART_TYPES.includes(chart.chartType)) {
    // Unsupported/malformed → show the raw spec (inert, escaped by React).
    return <pre className="msgrender-code-pre"><code>{content}</code></pre>;
  }
  const all = chart.series.flatMap((s) => s.values);
  const max = Math.max(1, ...all);
  const n = Math.max(1, chart.labels.length || chart.series[0]!.values.length);
  const plotW = W - PAD * 2, plotH = H - PAD * 2;
  const x = (i: number): number => PAD + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1));
  const y = (v: number): number => PAD + plotH - (plotH * v) / max;

  const ariaLabel = t('chartAria', { type: chart.chartType, series: chart.series.length, points: chart.labels.length });
  return (
    <figure className="chart-figure">
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} className="chartrender-img">
      {/* SVG 1.1 a11y: <title>/<desc> as the first children give AT a text alternative. */}
      <title>{ariaLabel}</title>
      <desc>{ariaLabel}</desc>
      {/* axes */}
      <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} stroke="var(--rule)" />
      <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="var(--rule)" />
      {chart.chartType === 'bar'
        ? chart.series.map((s, si) =>
            // ALL datasets render as grouped bars (the old branch silently
            // dropped every series but the first — ART-1's data-honesty gap).
            s.values.map((v, i) => {
              const group = plotW / (n * 1.5);
              const bw = group / chart.series.length;
              const gx = x(i) - group / 2 + bw * si;
              return <rect key={`${si}-${i}`} x={gx} y={y(v)} width={Math.max(1, bw - 1)} height={Math.max(0, H - PAD - y(v))} fill={seriesColor(si)} />;
            }))
        : chart.series.map((s, si) => (
            <polyline key={si} fill="none" stroke={seriesColor(si)} strokeWidth={2}
              points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />
          ))}
      {/* x labels (React-escaped) */}
      {chart.labels.map((l, i) => (
        <text key={i} x={x(i)} y={H - PAD + 14} textAnchor="middle" fontSize={10} fill="var(--ink)">{l}</text>
      ))}
    </svg>
    {/* Legend — only when there is something to disambiguate. Color swatch is
        aria-hidden; the SERIES NAME is the accessible signal (never color-alone). */}
    {chart.series.length > 1 && (
      <figcaption className="chart-legend">
        {chart.series.map((s, si) => (
          <span key={si} className="chart-legend__item">
            <span className="chart-legend__swatch" aria-hidden style={{ background: seriesColor(si) }} />
            {s.label}
          </span>
        ))}
      </figcaption>
    )}
    </figure>
  );
}
