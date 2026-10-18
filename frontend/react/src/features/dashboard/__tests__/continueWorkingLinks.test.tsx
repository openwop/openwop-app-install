/**
 * UX_UPGRADE-dashboard (2026-08-01), ADR 0377 Wave 3 — Continue working
 * deep-links each canvas to its own editor route, not the generic list. What
 * breaks it: a row landing on `/documents` (or dropping `?org=`), so the
 * "resume" tile resumes nothing.
 *
 * Split out of `uxUpgradeAug.test.tsx` (issue 4511). There it reached its
 * mocks with `vi.resetModules()` + `vi.doMock`, and the reset re-imported the
 * app's i18n bootstrap (`src/i18n/index.ts`), whose `init({ resources })`
 * REPLACES the shared i18next store with the eager catalogs only — MEASURED:
 * 131 `en` namespaces before, 38 after. The setup file's preload of the lazy
 * `dashboard` namespace was gone, so the next DashboardPage render suspended in
 * `useTranslation('dashboard')` while the lazy backend refetched it, and a
 * click landing in that window threw "A component suspended while responding to
 * synchronous input" and unmounted the page. Which later test it hit depended
 * on timing, which is why it read as a regression of #4498 (the larger default
 * home moved the window onto DASH-1's focus test). File-level mocks need no
 * reset, so nothing is re-bootstrapped.
 */
import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

// Every canvas type's feature on, as in the page tests this came from.
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureVisible: () => () => true,
  useFeatureLocked: () => () => false,
  useAllFeatureAccess: () => ({ loading: false }),
  useFeatureAccess: () => makeFeatureAccess({ enabled: true }),
}));
vi.mock('../useDashboardOrg.js', () => ({ useDashboardOrg: () => ({ orgId: 'org1', loading: false, error: false }) }));
// Hoisted: vi.mock factories run before module-level consts exist.
const { CANVASES } = vi.hoisted(() => {
  const rows: import('../../documents/documentsClient.js').CanvasSourceRow[] = [
    { canvasId: 'c1', canvasTypeId: 'canvas.slides', name: 'Deck', version: 1, updatedAt: '2026-08-01T00:00:00Z' },
    { canvasId: 'c2', canvasTypeId: 'pack.custom', name: 'Pack thing', version: 1, updatedAt: '2026-07-31T00:00:00Z' },
  ];
  return { CANVASES: rows };
});
vi.mock('../../documents/documentsClient.js', () => ({
  listCanvasSources: async (): ReturnType<typeof import('../../documents/documentsClient.js')['listCanvasSources']> =>
    ({ canvases: CANVASES, total: CANVASES.length }),
}));

const { default: Tile } = await import('../tiles/ContinueWorkingTile.js');

describe('Continue-working deep links', () => {
  it('links each canvas to its own editor route (not the generic list)', async () => {
    render(<MemoryRouter><Tile compact={false} /></MemoryRouter>);
    const deck = await screen.findByRole('link', { name: 'Deck' });
    expect(deck.getAttribute('href')).toBe('/slides/c1?org=org1');
    expect(screen.getByRole('link', { name: 'Pack thing' }).getAttribute('href')).toBe('/canvas/pack.custom/c2?org=org1');
  });
});
