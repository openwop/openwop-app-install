/**
 * CC-HUB-1 — inside the Campaign Studio hub (`/campaign-studio?tab=campaign-brief`),
 * clicking this page's Personas tab wrote `tab=personas` over the hub's own `tab`
 * param, so the hub fell back to its first tab and personas were unreachable
 * (reproduced on app.openwop.dev 2026-11-15). Embedded, the page's tab now rides
 * `section` and leaves the hub's `tab` alone; standalone deep links keep `?tab=`.
 * Red before the fix: the embedded click rewrote `tab` to `personas`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { HubProvider } from '../../../chrome/hubContext.js';

vi.mock('../../kb/kbClient.js', () => ({ listCollections: vi.fn(async () => []) }));
vi.mock('../campaignBriefClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    listBriefs: vi.fn(async () => []),
    listPersonas: vi.fn(async () => []),
    listOrgs: vi.fn(async () => []),
    listBrands: vi.fn(async () => []),
  };
});
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CampaignBriefPage } from '../CampaignBriefPage.js';

function LocationProbe(): JSX.Element {
  const loc = useLocation();
  return <p data-testid="loc">{loc.search}</p>;
}

function renderAt(url: string, embedded: boolean): void {
  const page = embedded ? <HubProvider><CampaignBriefPage /></HubProvider> : <CampaignBriefPage />;
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="*" element={<>{page}<LocationProbe /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe('CC-HUB-1 — the brief page tab never overwrites the hub tab', () => {
  it('embedded: clicking Personas keeps the hub on campaign-brief and selects Personas', async () => {
    renderAt('/campaign-studio?tab=campaign-brief', true);
    fireEvent.click(await screen.findByRole('tab', { name: /personas/i }));
    const search = new URLSearchParams(screen.getByTestId('loc').textContent ?? '');
    expect(search.get('tab')).toBe('campaign-brief');
    expect(search.get('section')).toBe('personas');
    expect(screen.getByRole('tab', { name: /personas/i }).getAttribute('aria-selected')).toBe('true');
  });

  it('standalone: a ?tab=personas deep link still opens Personas', async () => {
    renderAt('/campaign-brief?tab=personas', false);
    expect((await screen.findByRole('tab', { name: /personas/i })).getAttribute('aria-selected')).toBe('true');
  });
});
