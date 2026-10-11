/**
 * UX_UPGRADE-site ROUND 2 (R2-G4) — the two public sections whose failed read
 * still rendered as "nothing there": `entityDetail` (the one sibling the
 * failed-read sweep missed — SITE-R2-3) and the pricing add-on bundles (a
 * revenue surface — READ-1). A failed read renders the designed note; a genuine
 * 404 stays silent (the positive case, or the fix degrades into always-error).
 *
 * Sabotage-witnessed (/grade-tests w17): a `.catch` that clears the error flag
 * reds each failed-read case; treating 404 as a failure reds each silent case;
 * a success that stores "missing" reds the entity case.
 *
 * Ceiling: for entityDetail "silent after a 404" and "still loading" render the
 * same nothing. The bound is a settled drain plus proof the read was made.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const settle = async (): Promise<void> => {
  await act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); });
};
/** A fetch stub that routes by URL: the bundle read gets `bundles`, every other read the tier catalog. */
const pricingFetch = (bundles: () => Response) => vi.fn<typeof fetch>(async (input) => (
  String(input).includes('/public/bundle-pricing') ? bundles() : json({ tiers: [{ tier: 'free', name: 'Free', features: [] }] })
));

const DETAIL: Section = {
  sectionId: 'e1', type: 'entityDetail',
  data: { tenantId: 'org-1', typeName: 'caseStudy', entityId: 'cs-1', titleField: 'name' },
};

function renderSection(section: Section) {
  return render(<MemoryRouter><RenderSection section={section} mode="public" /></MemoryRouter>);
}

describe('entityDetail — failed ≠ missing (SITE-R2-3)', () => {
  it('renders the designed section-load note when the read FAILS', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => json({}, 500)));
    renderSection(DETAIL);
    await screen.findByText('Couldn’t load this section.');
  });

  it('stays silent on a genuine 404 (the positive case)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json({}, 404));
    vi.stubGlobal('fetch', fetchMock);
    renderSection(DETAIL);
    await settle();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/entities/cs-1'), expect.anything());
    expect(screen.queryByText('Couldn’t load this section.')).toBeNull();
  });

  it('renders the entity when the read succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => json({ entityId: 'cs-1', values: { name: 'Acme case study' } })));
    renderSection(DETAIL);
    await screen.findByText('Acme case study');
  });
});

describe('pricing add-on bundles — failed ≠ none configured (READ-1)', () => {
  const PRICING: Section = { sectionId: 'p1', type: 'pricing', data: { heading: 'Plans' } };

  it('says the bundles could not load while the tier grid still renders', async () => {
    vi.stubGlobal('fetch', pricingFetch(() => json({}, 500)));
    renderSection(PRICING);
    await screen.findByText('Free');
    await screen.findByText('Couldn’t load add-on bundles.');
  });

  it('stays silent when bundles are genuinely unconfigured (404 or empty)', async () => {
    for (const bundles of [() => json({}, 404), () => json({ bundles: [] })]) {
      const fetchMock = pricingFetch(bundles);
      vi.stubGlobal('fetch', fetchMock);
      renderSection(PRICING);
      await screen.findByText('Free');
      await settle();
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/public/bundle-pricing'))).toBe(true);
      expect(screen.queryByText('Couldn’t load add-on bundles.')).toBeNull();
      cleanup();
    }
  });
});
