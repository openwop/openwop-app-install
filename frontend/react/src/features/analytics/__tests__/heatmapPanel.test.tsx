/**
 * ADR 0951 P1 — the heat-map view.
 *  - empty, failed and loaded states are all named (never a blank card);
 *  - clicks render as a labelled figure AND tables (named elements, top areas);
 *  - scroll reach and attention render as tables;
 *  - a suppressed experiment arm is disclosed;
 *  - the bot count is stated.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type * as Client from '../analyticsClient.js';
import type { HeatmapView } from '../analyticsClient.js';
import { messages as en } from '../i18n/en.js';

const getHeatPages = vi.fn<typeof Client.getHeatPages>();
const getHeatmap = vi.fn<typeof Client.getHeatmap>();
vi.mock('../analyticsClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getHeatPages: (...a: Parameters<typeof Client.getHeatPages>) => getHeatPages(...a),
  getHeatmap: (...a: Parameters<typeof Client.getHeatmap>) => getHeatmap(...a),
}));
const { HeatmapPanel } = await import('../HeatmapPanel.js');

const view = (over: Partial<HeatmapView> = {}): HeatmapView => ({
  pageKey: 'pricing', device: 'all', days: 30, views: 40, bots: 3, totalClicks: 12,
  clicks: [{ cell: 's:cta-buy', count: 7 }, { cell: 'g25.5', count: 4 }, { cell: 'other', count: 1 }],
  scrollReach: Array.from({ length: 21 }, (_, i) => 1 - i * 0.04),
  attention: [{ section: 'hero', avgMs: 4200, views: 40 }],
  arms: [], ...over,
});

beforeEach(() => { getHeatPages.mockReset(); getHeatmap.mockReset(); });
afterEach(() => cleanup());

describe('ADR 0951 P1 — HeatmapPanel', () => {
  it('no measured pages says so', async () => {
    getHeatPages.mockResolvedValue([]);
    render(<HeatmapPanel orgId="org:1" />);
    expect(await screen.findByText(en.heatNoPages)).toBeTruthy();
    expect(getHeatmap).not.toHaveBeenCalled();
  });

  it('a failed page list says so', async () => {
    getHeatPages.mockRejectedValue(new Error('x'));
    render(<HeatmapPanel orgId="org:1" />);
    expect(await screen.findByText(en.heatPagesFailed)).toBeTruthy();
  });

  it('clicks: a labelled figure plus the named-element and area tables, and the bot count', async () => {
    getHeatPages.mockResolvedValue([{ pageKey: 'pricing', firstSeen: '2026-10-01', lastSeen: '2026-10-20' }]);
    getHeatmap.mockResolvedValue(view());
    render(<HeatmapPanel orgId="org:1" />);
    expect(await screen.findByRole('img', { name: /12 clicks/ })).toBeTruthy();
    expect(screen.getByText('cta-buy')).toBeTruthy();
    expect(screen.getByText('50% across, 10% down')).toBeTruthy();
    expect(screen.getByText(/3 bot visits left out/)).toBeTruthy();
    expect(getHeatmap).toHaveBeenCalledWith('org:1', { page: 'pricing', device: 'all', days: 30 });
  });

  it('scroll and attention render as tables', async () => {
    getHeatPages.mockResolvedValue([{ pageKey: 'pricing', firstSeen: '2026-10-01', lastSeen: '2026-10-20' }]);
    getHeatmap.mockResolvedValue(view());
    render(<HeatmapPanel orgId="org:1" />);
    await screen.findByRole('img');
    fireEvent.click(screen.getByRole('tab', { name: en.heatModeScroll }));
    expect(screen.getByRole('table', { name: en.heatScrollCaption })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: en.heatModeAttention }));
    expect(screen.getByText('hero')).toBeTruthy();
    expect(screen.getByText('4.2')).toBeTruthy();
  });

  it('discloses a suppressed experiment arm', async () => {
    getHeatPages.mockResolvedValue([{ pageKey: 'pricing', firstSeen: '2026-10-01', lastSeen: '2026-10-20' }]);
    getHeatmap.mockResolvedValue(view({ arms: [{ arm: 'exp/b', views: 12, suppressed: true }] }));
    render(<HeatmapPanel orgId="org:1" />);
    expect(await screen.findByText(en.heatArmsSuppressed.replace('{{n}}', '30'))).toBeTruthy();
  });

  it('no data for the selection is an empty state, not zeros', async () => {
    getHeatPages.mockResolvedValue([{ pageKey: 'pricing', firstSeen: '2026-10-01', lastSeen: '2026-10-20' }]);
    getHeatmap.mockResolvedValue(view({ views: 0, totalClicks: 0, clicks: [], attention: [] }));
    render(<HeatmapPanel orgId="org:1" />);
    expect(await screen.findByText(en.heatEmpty)).toBeTruthy();
  });

  it('attention-only data remains visible when no click or scroll batch arrived', async () => {
    getHeatPages.mockResolvedValue([{ pageKey: 'pricing', firstSeen: '2026-10-01', lastSeen: '2026-10-20' }]);
    getHeatmap.mockResolvedValue(view({ views: 0, totalClicks: 0, clicks: [] }));
    render(<HeatmapPanel orgId="org:1" />);
    fireEvent.click(await screen.findByRole('tab', { name: en.heatModeAttention }));
    expect(await screen.findByText('hero')).toBeTruthy();
    expect(screen.queryByText(en.heatEmpty)).toBeNull();
  });
});
