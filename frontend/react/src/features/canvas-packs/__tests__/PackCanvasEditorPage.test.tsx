/**
 * UX_UPGRADE-canvas-packs CP-G1 + CP-G2.
 *
 * CP-G1: "this canvas type is not available here" (the 404 that both a
 * toggle-off and a not-installed pack produce) and "the request failed" are
 * DIFFERENT user situations — install the pack vs try again. `asJson` already
 * attaches `status` to the Error and this page threw it away, so both rendered
 * the same dead end. Reading the status to CHOOSE a message leaks nothing; the
 * status is still never rendered.
 *
 * CP-G2: the error state had no way forward at all on a deep-linked route.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

const { getCatalog, listOrgs, listPlugins } = vi.hoisted(() => ({
  getCatalog: vi.fn(), listOrgs: vi.fn(), listPlugins: vi.fn(),
}));

vi.mock('../../../canvas/canvasClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../canvas/canvasClient.js')>()),
  listOrgs,
  createCanvasClient: () => ({ root: '/x', getCatalog, getCanvas: vi.fn(), seedFromArtifact: vi.fn(), deleteCanvas: vi.fn(), listVersions: vi.fn(), getVersion: vi.fn(), restoreVersion: vi.fn(), saveCanvas: vi.fn() }),
}));
vi.mock('../../ui-plugins/pluginClient.js', async (orig) => ({
  ...(await orig<typeof import('../../ui-plugins/pluginClient.js')>()),
  listPlugins,
}));
// The chassis only mounts on the success path; keep it out of the failure tests.
vi.mock('../../../canvas/CanvasEditorPage.js', () => ({
  CanvasEditorPage: () => <div data-testid="chassis" />,
}));
const EMPTY_SEARCH = new URLSearchParams();

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useParams: () => ({ typeId: 'canvas.demo-board', canvasId: 'c1' }),
  // The page reads `?org=` now (the canvas API is org-scoped and the route does
  // not carry it). Stubbed alongside useParams rather than wrapping every render
  // in a MemoryRouter, so these tests keep asserting exactly what they did.
  useSearchParams: () => [EMPTY_SEARCH, vi.fn()],
}));

import { PackCanvasEditorPage } from '../PackCanvasEditorPage.js';

const statusError = (status: number): Error => {
  const e = new Error('request failed');
  (e as { status?: number }).status = status;
  return e;
};

const mount = async (): Promise<void> => {
  render(<PackCanvasEditorPage />);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
  listPlugins.mockResolvedValue({ plugins: [] });
});

describe('CP-G1 — an unavailable TYPE is not a failed request', () => {
  it('a 404 says the type is unavailable and offers no retry', async () => {
    getCatalog.mockRejectedValue(statusError(404));
    await mount();
    expect(document.body.textContent).toContain('not available in this workspace');
    // Asking again will not install a pack.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    // The status itself is still never shown.
    expect(document.body.textContent).not.toContain('404');
  });

  it('any other failure keeps the generic message AND offers a retry', async () => {
    getCatalog.mockRejectedValue(statusError(503));
    await mount();
    expect(document.body.textContent).not.toContain('not available in this workspace');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('503');
  });

  it('a failure with no status at all still gets the retry', async () => {
    getCatalog.mockRejectedValue(new Error('network down'));
    await mount();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('CP-G2 — the retry actually re-runs the load', () => {
  it('recovers to the editor when the second attempt succeeds', async () => {
    getCatalog
      .mockRejectedValueOnce(statusError(503))
      .mockResolvedValueOnce({ canvasTypeId: 'canvas.demo-board', components: [], promptSchema: '', editor: { collections: [{ key: 'items', label: 'Items', max: 50, adders: [{ id: 'item', label: 'Item' }], fields: [] }] } });
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(screen.getByTestId('chassis')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});
