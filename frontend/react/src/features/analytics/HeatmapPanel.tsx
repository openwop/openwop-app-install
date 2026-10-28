/**
 * ADR 0951 P1 — the heat-map view on the Analytics page (lazy-loaded).
 *
 * Aggregate, identifier-free data only: where visitors clicked (2% squares of the
 * page, plus author-named elements), how far they scrolled, and how long sections
 * stayed in view. Bots are excluded and their count is stated. An experiment arm
 * under the k-anonymity floor is listed as suppressed, never shown on its own.
 *
 * The click map is drawn on the page's own coordinate space (fractions of the
 * document), not over a screenshot: the host has no page-snapshot capability, so
 * the figure says so and links to the live page, and every number is also in a
 * table (the figure is never the only carrier of the data).
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { InlineState } from '../../ui/InlineState.js';
import { Tabs, TabPanel } from '../../ui/Tabs.js';
import { formatNumber } from '../../i18n/format.js';
import { getHeatPages, getHeatmap, type HeatDevice, type HeatPageRef, type HeatmapView } from './analyticsClient.js';

const GRID = 50;
type Mode = 'clicks' | 'scroll' | 'attention';
type Window = 7 | 30 | 90;

function parseGrid(cell: string): { x: number; y: number } | null {
  const m = /^g(\d+)\.(\d+)$/.exec(cell);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

export function HeatmapPanel({ orgId }: { orgId: string }): JSX.Element {
  const { t } = useTranslation('analytics');
  const ids = useId();
  const [pages, setPages] = useState<HeatPageRef[] | 'error' | null>(null);
  const [page, setPage] = useState('');
  const [device, setDevice] = useState<HeatDevice>('all');
  const [days, setDays] = useState<Window>(30);
  const [mode, setMode] = useState<Mode>('clicks');
  const [view, setView] = useState<HeatmapView | 'error' | null>(null);

  useEffect(() => {
    let live = true;
    setPages(null);
    getHeatPages(orgId).then((p) => { if (!live) return; setPages(p); setPage((cur) => (p.some((x) => x.pageKey === cur) ? cur : p[0]?.pageKey ?? '')); })
      .catch(() => { if (live) setPages('error'); });
    return () => { live = false; };
  }, [orgId]);

  useEffect(() => {
    if (!page) return;
    let live = true;
    setView(null);
    getHeatmap(orgId, { page, device, days }).then((v) => { if (live) setView(v); }).catch(() => { if (live) setView('error'); });
    return () => { live = false; };
  }, [orgId, page, device, days]);

  const grid = useMemo(() => {
    if (!view || view === 'error') return { cells: [] as Array<{ x: number; y: number; count: number }>, max: 0, named: [] as Array<{ id: string; count: number }> };
    const cells: Array<{ x: number; y: number; count: number }> = [];
    const named: Array<{ id: string; count: number }> = [];
    for (const c of view.clicks) {
      const g = parseGrid(c.cell);
      if (g) cells.push({ ...g, count: c.count });
      else if (c.cell.startsWith('s:')) named.push({ id: c.cell.slice(2), count: c.count });
    }
    return { cells, max: cells.reduce((m, c) => Math.max(m, c.count), 0), named: named.slice(0, 20) };
  }, [view]);

  if (pages === 'error') return <InlineState kind="failed" message={t('heatPagesFailed')} announce={t('heatPagesFailed')} announcePolite />;
  if (pages === null) return <InlineState kind="loading" message={t('heatLoading')} />;
  if (pages.length === 0) return <InlineState kind="empty" message={t('heatNoPages')} />;

  const pct = (n: number): string => formatNumber(n, { style: 'percent', maximumFractionDigits: 0 });
  const secs = (ms: number): string => formatNumber(ms / 1000, { maximumFractionDigits: 1 });
  const share = (n: number, total: number): string => (total > 0 ? pct(n / total) : pct(0));

  return (
    <div className="u-flex u-flex-col u-gap-3">
      <div className="action-bar u-gap-2 u-items-center">
        <select value={page} onChange={(e) => setPage(e.target.value)} className="u-w-auto" aria-label={t('heatPageLabel')}>
          {pages.map((p) => <option key={p.pageKey} value={p.pageKey}>{p.pageKey}</option>)}
        </select>
        <select value={device} onChange={(e) => setDevice(e.target.value as HeatDevice)} className="u-w-auto" aria-label={t('heatDeviceLabel')}>
          <option value="all">{t('heatDeviceAll')}</option>
          <option value="desktop">{t('heatDeviceDesktop')}</option>
          <option value="tablet">{t('heatDeviceTablet')}</option>
          <option value="mobile">{t('heatDeviceMobile')}</option>
        </select>
        <select value={String(days)} onChange={(e) => setDays(Number(e.target.value) as Window)} className="u-w-auto" aria-label={t('windowPickerLabel')}>
          <option value="7">{t('window7')}</option>
          <option value="30">{t('window30')}</option>
          <option value="90">{t('window90')}</option>
        </select>
      </div>
      <Tabs<Mode>
        idBase={`${ids}-heat`}
        label={t('heatModeLabel')}
        value={mode}
        onChange={setMode}
        items={[{ id: 'clicks', label: t('heatModeClicks') }, { id: 'scroll', label: t('heatModeScroll') }, { id: 'attention', label: t('heatModeAttention') }]}
      />
      <TabPanel idBase={`${ids}-heat`} tabId={mode}>
        {view === 'error' ? (
          <InlineState kind="failed" message={t('heatFailed')} announce={t('heatFailed')} announcePolite />
        ) : view === null ? (
          <InlineState kind="loading" message={t('heatLoading')} />
        ) : view.views === 0 && view.totalClicks === 0 && view.attention.length === 0 ? (
          <InlineState kind="empty" message={t('heatEmpty')} />
        ) : (
          <div className="u-flex u-flex-col u-gap-3">
            <p className="u-m-0 u-fs-12 muted">
              {t('heatSummary', { views: formatNumber(view.views), clicks: formatNumber(view.totalClicks), bots: formatNumber(view.bots) })}
            </p>
            {view.arms.some((a) => a.suppressed) ? <p className="u-m-0 u-fs-12 muted">{t('heatArmsSuppressed', { n: 30 })}</p> : null}
            {mode === 'clicks' ? (
              <div className="u-flex u-flex-col u-gap-3">
                <figure className="u-m-0 u-flex u-flex-col u-gap-1">
                  <svg
                    className="heatmap-grid"
                    viewBox={`0 0 ${GRID} ${GRID}`}
                    preserveAspectRatio="none"
                    role="img"
                    aria-label={t('heatGridAlt', { clicks: formatNumber(view.totalClicks) })}
                  >
                    {grid.cells.map((c) => (
                      <rect key={`${c.x}.${c.y}`} x={c.x} y={c.y} width={1} height={1} fill="var(--clay)" fillOpacity={grid.max > 0 ? 0.15 + 0.85 * (c.count / grid.max) : 0} />
                    ))}
                  </svg>
                  <figcaption className="u-fs-12 muted">
                    {t('heatGridCaption')}{' '}
                    <a href={page === '/' ? '/' : `/p/${encodeURIComponent(page.replace(/^\//, ''))}`} target="_blank" rel="noreferrer">{t('heatOpenPage')}</a>
                  </figcaption>
                </figure>
                {grid.named.length > 0 ? (
                  <table className="u-w-full">
                    <caption className="u-text-left u-fs-12 muted">{t('heatNamedCaption')}</caption>
                    <thead><tr><th className="u-text-left">{t('heatColElement')}</th><th className="u-text-right">{t('heatColClicks')}</th><th className="u-text-right">{t('heatColShare')}</th></tr></thead>
                    <tbody>
                      {grid.named.map((n) => (
                        <tr key={n.id}><td className="u-mono u-fs-12">{n.id}</td><td className="u-text-right">{formatNumber(n.count)}</td><td className="u-text-right">{share(n.count, view.totalClicks)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
                {grid.cells.length > 0 ? (
                  <table className="u-w-full">
                    <caption className="u-text-left u-fs-12 muted">{t('heatAreasCaption')}</caption>
                    <thead><tr><th className="u-text-left">{t('heatColArea')}</th><th className="u-text-right">{t('heatColClicks')}</th></tr></thead>
                    <tbody>
                      {[...grid.cells].sort((a, b) => b.count - a.count).slice(0, 10).map((c) => (
                        <tr key={`${c.x}.${c.y}`}>
                          <td className="u-fs-12">{t('heatArea', { x: c.x * 2, y: c.y * 2 })}</td>
                          <td className="u-text-right">{formatNumber(c.count)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
              </div>
            ) : mode === 'scroll' ? (
              <table className="u-w-full">
                <caption className="u-text-left u-fs-12 muted">{t('heatScrollCaption')}</caption>
                <thead><tr><th className="u-text-left">{t('heatColDepth')}</th><th className="u-text-left">{t('heatColReached')}</th></tr></thead>
                <tbody>
                  {view.scrollReach.map((r, i) => (i % 2 === 0 ? (
                    <tr key={i}>
                      <td className="u-fs-12">{pct(i / 20)}</td>
                      <td className="u-flex u-gap-2 u-items-center">
                        <meter className="heatmap-meter" min={0} max={1} value={r} aria-label={t('heatReachedAria', { depth: pct(i / 20), share: pct(r) })} />
                        <span className="u-fs-12">{pct(r)}</span>
                      </td>
                    </tr>
                  ) : null))}
                </tbody>
              </table>
            ) : view.attention.length === 0 ? (
              <InlineState kind="empty" message={t('heatNoSections')} />
            ) : (
              <table className="u-w-full">
                <caption className="u-text-left u-fs-12 muted">{t('heatAttentionCaption')}</caption>
                <thead><tr><th className="u-text-left">{t('heatColSection')}</th><th className="u-text-right">{t('heatColAvgSeconds')}</th><th className="u-text-right">{t('heatColViews')}</th></tr></thead>
                <tbody>
                  {view.attention.map((a) => (
                    <tr key={a.section}><td className="u-mono u-fs-12">{a.section}</td><td className="u-text-right">{secs(a.avgMs)}</td><td className="u-text-right">{formatNumber(a.views)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </TabPanel>
    </div>
  );
}
