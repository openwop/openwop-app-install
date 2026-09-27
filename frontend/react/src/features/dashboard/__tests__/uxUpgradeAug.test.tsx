/**
 * UX_UPGRADE-dashboard (2026-08-01) — the benchmark-driven upgrades:
 * picker search, pointer-drag reorder (keyboard parity kept), per-tile
 * refresh, the greeting lede, and Continue-working deep links.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';

const getLayout = vi.fn();
const putLayout = vi.fn();
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../dashboardClient.js', () => ({
  getLayout: () => getLayout(),
  putLayout: (...a: unknown[]) => putLayout(...a),
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: vi.fn() }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureVisible: () => () => true,
  useFeatureLocked: () => () => false,
  useAllFeatureAccess: () => ({ loading: false }),
  useFeatureAccess: () => makeFeatureAccess({ enabled: true }),
}));
vi.mock('../../../client/useEffectiveAccess.js', () => ({
  useEffectiveAccessState: () => ({ access: {}, resolved: true }),
  isAdminCaller: () => true,
}));

const { DashboardPage } = await import('../DashboardPage.js');

const announced = (): string => document.querySelector('[aria-live="polite"]')?.textContent ?? '';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function renderPage() {
  getLayout.mockResolvedValue(null);
  putLayout.mockResolvedValue({});
  const view = render(<MemoryRouter><DashboardPage /></MemoryRouter>);
  await screen.findByRole('button', { name: /customize/i });
  return view;
}
async function renderCustomizing() {
  const view = await renderPage();
  fireEvent.click(screen.getByRole('button', { name: /customize/i }));
  return view;
}

describe('greeting lede', () => {
  it('greets by time of day (no name — falls back to the plain form)', async () => {
    await renderPage();
    expect(document.body.textContent).toMatch(/good (morning|afternoon|evening)\./i);
  });
});

describe('add-tile picker search', () => {
  it('filters the catalog and clears back to categories', async () => {
    await renderCustomizing();
    const picker = await screen.findByLabelText(/add tiles/i);
    const search = within(picker).getByRole('searchbox', { name: /search tiles/i });
    const before = within(picker).getAllByRole('button', { name: /^add/i }).length;
    fireEvent.change(search, { target: { value: 'knowledge' } });
    const after = within(picker).getAllByRole('button', { name: /^add/i }).length;
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
    fireEvent.change(search, { target: { value: '' } });
    expect(within(picker).getAllByRole('button', { name: /^add/i }).length).toBe(before);
  });

  it('shows a designed no-match state instead of an empty void', async () => {
    await renderCustomizing();
    const picker = await screen.findByLabelText(/add tiles/i);
    fireEvent.change(within(picker).getByRole('searchbox', { name: /search tiles/i }), { target: { value: 'zzzz-no-such-tile' } });
    expect(within(picker).getByRole('status').textContent).toMatch(/no tiles match/i);
    expect(within(picker).queryAllByRole('button', { name: /^add/i }).length).toBe(0);
  });
});

describe('pointer-drag reorder (customize mode)', () => {
  it('drops the dragged tile at the target position and announces it', async () => {
    const { container } = await renderCustomizing();
    const tiles = Array.from(container.querySelectorAll('.dash-tile__dnd')); // the drag surface (generic wrapper inside the section landmark)
    expect(tiles.length).toBeGreaterThan(2);
    const labels = Array.from(container.querySelectorAll('section.dash-tile')).map((s) => s.getAttribute('aria-label'));
    const dt = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(tiles[0]!, { dataTransfer: dt });
    fireEvent.dragOver(tiles[2]!, { dataTransfer: dt });
    fireEvent.drop(tiles[2]!, { dataTransfer: dt });
    await waitFor(() => expect(announced()).toMatch(/moved to position 3/i));
    const after = Array.from(container.querySelectorAll('section.dash-tile')).map((s) => s.getAttribute('aria-label'));
    expect(after[2]).toBe(labels[0]); // dragged tile took the target slot
    expect(after[0]).toBe(labels[1]); // the rest shifted up
  });

  it('keeps the keyboard reorder buttons — drag is additive, not a replacement', async () => {
    await renderCustomizing();
    expect(screen.getAllByRole('button', { name: /move up/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /move down/i }).length).toBeGreaterThan(0);
  });
});

describe('per-tile refresh (view mode)', () => {
  it('offers a labeled refresh control per tile and announces the refresh', async () => {
    await renderPage();
    const refresh = screen.getAllByRole('button', { name: /^refresh /i })[0]!;
    fireEvent.click(refresh);
    await waitFor(() => expect(announced()).toMatch(/refreshed/i));
  });

  it('hides refresh controls while customizing (the bar carries edit controls instead)', async () => {
    await renderCustomizing();
    expect(screen.queryAllByRole('button', { name: /^refresh /i }).length).toBe(0);
  });
});

describe('Continue-working deep links', () => {
  it('links each canvas to its own editor route (not the generic list)', async () => {
    vi.resetModules(); // the tile module is cached from the page renders above
    vi.doMock('../useDashboardOrg.js', () => ({ useDashboardOrg: () => ({ orgId: 'org1', loading: false, error: null }) }));
    vi.doMock('../../documents/documentsClient.js', () => ({
      listCanvasSources: async () => ({
        canvases: [
          { canvasId: 'c1', canvasTypeId: 'canvas.slides', name: 'Deck', version: 1, updatedAt: '2026-08-01T00:00:00Z' },
          { canvasId: 'c2', canvasTypeId: 'pack.custom', name: 'Pack thing', version: 1, updatedAt: '2026-07-31T00:00:00Z' },
        ],
        total: 2,
      }),
    }));
    const { default: Tile } = await import('../tiles/ContinueWorkingTile.js');
    render(<MemoryRouter><Tile compact={false} /></MemoryRouter>);
    const deck = await screen.findByRole('link', { name: 'Deck' });
    expect(deck.getAttribute('href')).toBe('/slides/c1?org=org1');
    expect(screen.getByRole('link', { name: 'Pack thing' }).getAttribute('href')).toBe('/canvas/pack.custom/c2?org=org1');
    vi.doUnmock('../useDashboardOrg.js');
    vi.doUnmock('../../documents/documentsClient.js');
  });
});

describe('DASH-1 (round 2) — move-to-top/bottom closes the keyboard O(n) tail', () => {
  it('move-to-top puts the last tile first and announces position 1', async () => {
    const { container } = await renderCustomizing();
    const labels = Array.from(container.querySelectorAll('section.dash-tile')).map((s) => s.getAttribute('aria-label'));
    const toTops = screen.getAllByRole('button', { name: /move to top/i });
    fireEvent.click(toTops[toTops.length - 1]!);
    await waitFor(() => expect(announced()).toMatch(/moved to position 1 /i));
    const after = Array.from(container.querySelectorAll('section.dash-tile')).map((s) => s.getAttribute('aria-label'));
    expect(after[0]).toBe(labels[labels.length - 1]);
  });

  /**
   * Focus restore (found live 2026-08-03). The reorder itself always worked,
   * but the re-render unmounted the button the user had just activated and
   * focus fell to <body> — so a keyboard user lost their place and could not
   * make CONSECUTIVE moves, which is the whole point of a keyboard alternative
   * to drag-and-drop. The subtlety these pin: after a move to an edge the
   * activated control becomes DISABLED, and focusing a disabled button does
   * nothing, so the restore must fall back to the opposite-edge control.
   */
  it('after move-to-top, focus is still on a usable control of the moved tile', async () => {
    const { container } = await renderCustomizing();
    const toTops = screen.getAllByRole('button', { name: /move to top/i });
    fireEvent.click(toTops[toTops.length - 1]!);
    await waitFor(() => expect(announced()).toMatch(/moved to position 1 /i));
    await waitFor(() => {
      const active = document.activeElement as HTMLButtonElement | null;
      expect(active).toBeTruthy();
      expect(active!.tagName).toBe('BUTTON');           // NOT <body>
      expect(active!.disabled).toBe(false);             // and actually usable
      // …and it belongs to the tile that moved, now first in the grid.
      const first = container.querySelector('section.dash-tile');
      expect(first!.contains(active!)).toBe(true);
    });
  });

  it('move-to-top is disabled on the first tile; move-to-bottom on the last', async () => {
    await renderCustomizing();
    const toTops = screen.getAllByRole('button', { name: /move to top/i }) as HTMLButtonElement[];
    const toBottoms = screen.getAllByRole('button', { name: /move to bottom/i }) as HTMLButtonElement[];
    expect(toTops[0]!.disabled).toBe(true);
    expect(toBottoms[toBottoms.length - 1]!.disabled).toBe(true);
    expect(toTops[toTops.length - 1]!.disabled).toBe(false);
  });
});
