/**
 * EMPTY-ON-FAIL-4 (ADR 0779 D7, the RTP-EMPTY-1 class) — a failed types read is NOT
 * "No types yet" in the Types RAIL.
 *
 * The catch set `types` to [], and while the main pane's empty state was already
 * guarded (`&& !error`), the rail's twin was not: it said "No types yet — define your
 * first content type." beside the page's error Notice. The rail now offers a Retry
 * on a failed read, and its empty hint needs a successful read.
 *
 * Break it by dropping the `error ?` branch at the top of the Types rail in
 * EntitiesPage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

type Client = typeof import('../entitiesClient.js');
const m = vi.hoisted(() => ({
  listEntityTypesForViewer: vi.fn<Client['listEntityTypesForViewer']>(),
  listRelationships: vi.fn<Client['listRelationships']>(),
  listTaxonomies: vi.fn<Client['listTaxonomies']>(),
  getEntityLocaleContext: vi.fn<Client['getEntityLocaleContext']>(),
}));
vi.mock('../entitiesClient.js', async (orig) => ({
  ...(await orig<Client>()),
  listEntityTypesForViewer: m.listEntityTypesForViewer,
  listRelationships: m.listRelationships,
  listTaxonomies: m.listTaxonomies,
  getEntityLocaleContext: m.getEntityLocaleContext,
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, status: 'on', isBeta: false, variant: null }),
}));

const { EntitiesPage } = await import('../EntitiesPage.js');

const EMPTY_HINT = 'No types yet — define your first content type.';
const MAIN_EMPTY = 'Model your first content type';

function view(): void {
  render(<MemoryRouter><EntitiesPage /></MemoryRouter>);
}

beforeEach(() => {
  m.listEntityTypesForViewer.mockReset();
  m.listRelationships.mockResolvedValue([]);
  m.listTaxonomies.mockResolvedValue([]);
  m.getEntityLocaleContext.mockResolvedValue({ enabled: false });
});
afterEach(cleanup);

describe('EMPTY-ON-FAIL-4 — a failed types read is not "No types yet"', () => {
  it('a rejected read shows the error and a Retry in the rail, and NOT "No types yet"', async () => {
    m.listEntityTypesForViewer.mockRejectedValue(new Error('types_500'));
    view();
    expect(await screen.findByText('types_500')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByText(EMPTY_HINT)).toBeNull();
    expect(screen.queryByText(MAIN_EMPTY)).toBeNull();
  });

  it('Retry re-reads, and a successful empty read then says "No types yet"', async () => {
    m.listEntityTypesForViewer
      .mockRejectedValueOnce(new Error('types_500'))
      .mockResolvedValue({ types: [], viewer: { canWrite: true, canManageTypes: true } });
    view();
    await screen.findByText('types_500');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(EMPTY_HINT)).toBeTruthy();
    expect(screen.queryByText('types_500')).toBeNull();
  });

  it('a successful empty read still says "No types yet" (positive control)', async () => {
    m.listEntityTypesForViewer.mockResolvedValue({ types: [], viewer: { canWrite: true, canManageTypes: true } });
    view();
    expect(await screen.findByText(EMPTY_HINT)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
