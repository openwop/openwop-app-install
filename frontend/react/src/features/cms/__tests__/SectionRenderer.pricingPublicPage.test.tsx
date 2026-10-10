/**
 * ADR 0820 §7 / ADR 0821 D7 — the public /pricing page (the `pricing` section in
 * the ONE SectionRenderer). What a visitor must be able to trust:
 *  - features read as human NAMES from the server's label map (the store's
 *    source), never raw ids like `csm`;
 *  - one Monthly / Yearly switch (the store's labels) drives plans AND bundles;
 *  - a bundle no plan grants says it is sold separately;
 *  - AI credit packs appear only when the server lists priced ones;
 *  - unconfigured ⇒ no invented price, and an empty catalog says so.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

const PRICING: Section = { sectionId: 'p1', type: 'pricing', data: { heading: 'Plans' } };

interface Payload { tiers: unknown[]; featureLabels?: Record<string, string>; creditPacks?: unknown[] }
function mockReads(pricing: Payload, bundles: unknown[] = []): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes('/public/pricing')) return { ok: true, status: 200, json: async () => pricing } as Response;
    return { ok: true, status: 200, json: async () => ({ bundles }) } as Response;
  }));
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const renderPricing = () => render(<MemoryRouter><RenderSection section={PRICING} mode="public" /></MemoryRouter>);

const FREE = { tier: 'free', name: 'Free', features: ['docs', 'cdp'], display: { price: '$0', blurb: 'Free forever' } };
const PRO = {
  tier: 'pro', name: 'Pro', features: ['docs', 'cdp', 'csm', 'advisory-board'], limits: { aiCreditsMonthly: 5000 },
  display: { price: '$39', cadence: '/mo', priceAnnual: '$390', cadenceAnnual: '/yr', annualNote: '2 months free', highlighted: true },
};
const ENTERPRISE = { tier: 'enterprise', name: 'Enterprise', features: '*', display: { blurb: 'Contact us' } };
const LABELS = { docs: 'Docs', cdp: 'Customer data platform', csm: 'Customer success', 'advisory-board': 'Advisory board', 'job-search': 'Job search' };
const BUNDLES = [
  { bundleId: 'agents', label: 'Agents', features: ['advisory-board'], priceDisplay: { price: '$29', cadence: '/mo', priceAnnual: '$290', cadenceAnnual: '/yr', blurb: 'AI advisory board' } },
  { bundleId: 'job-search', label: 'Job search', features: ['job-search'], standalone: true, priceDisplay: { price: '$19', cadence: '/mo', priceAnnual: '$190', cadenceAnnual: '/yr' } },
];

describe('public pricing page — feature names', () => {
  it('renders the server label for a feature id, never the raw id', async () => {
    mockReads({ tiers: [FREE, PRO], featureLabels: LABELS }, BUNDLES);
    const { container } = renderPricing();
    await screen.findAllByText('Customer success');
    expect(screen.queryByText('Csm')).toBeNull();
    expect(screen.queryByText('csm')).toBeNull();
    // Pro builds on Free: its card names only what it ADDS.
    const proCard = container.querySelectorAll('.fp-pricing__plans .fp-tier')[1] as HTMLElement;
    expect(within(proCard).getByText('Everything in Free, plus:')).toBeTruthy();
    expect(within(proCard).getByText('Customer success')).toBeTruthy();
    expect(within(proCard).queryByText('Docs')).toBeNull();
  });
});

describe('public pricing page — cadence', () => {
  it('uses the store’s Monthly / Yearly labels, defaults to monthly, and drives plans AND bundles', async () => {
    mockReads({ tiers: [FREE, PRO], featureLabels: LABELS }, BUNDLES);
    renderPricing();
    const group = await screen.findByRole('radiogroup', { name: 'Billing period' });
    const monthly = within(group).getByRole('radio', { name: /^Monthly/ });
    const yearly = within(group).getByRole('radio', { name: /^Yearly/ });
    expect(monthly.getAttribute('aria-checked')).toBe('true');
    expect(within(yearly).getByText('2 months free')).toBeTruthy();
    expect(screen.getByText('$39')).toBeTruthy();
    expect(screen.getByText('$29')).toBeTruthy(); // the Agents bundle, monthly
    expect(screen.getByText('or $390/yr')).toBeTruthy();

    fireEvent.click(yearly);
    expect(yearly.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('$390')).toBeTruthy();
    expect(screen.getByText('$290')).toBeTruthy(); // the bundle follows the same switch
    expect(screen.queryByText('$39')).toBeNull();
  });
});

describe('public pricing page — bundles and credits', () => {
  it('marks a standalone bundle as sold separately, and only that one', async () => {
    mockReads({ tiers: [FREE, PRO], featureLabels: LABELS }, BUNDLES);
    const { container } = renderPricing();
    await screen.findByRole('heading', { name: 'Job search' });
    const cards = Array.from(container.querySelectorAll('.fp-pricing__addons .fp-tier')) as HTMLElement[];
    const js = cards.find((c) => within(c).queryByRole('heading', { name: 'Job search' }))!;
    const agents = cards.find((c) => within(c).queryByRole('heading', { name: 'Agents' }))!;
    expect(within(js).getByText('Sold separately — not part of any plan')).toBeTruthy();
    expect(within(agents).queryByText('Sold separately — not part of any plan')).toBeNull();
    // Positive control: the plan-grantable bundle names the plan that includes it.
    expect(within(agents).getByText('Included in Pro')).toBeTruthy();
  });

  it('lists priced AI credit packs, and renders no credits block when there are none', async () => {
    mockReads({ tiers: [FREE, PRO], featureLabels: LABELS, creditPacks: [{ credits: 1000, price: '$10' }, { credits: 5000, price: '$40', label: 'Best value' }] }, BUNDLES);
    renderPricing();
    expect(await screen.findByRole('heading', { name: 'AI credits' })).toBeTruthy();
    expect(screen.getByText('1,000 credits')).toBeTruthy();
    expect(screen.getByText('$40')).toBeTruthy();
    expect(screen.getByText('Best value')).toBeTruthy();

    cleanup();
    mockReads({ tiers: [FREE, PRO], featureLabels: LABELS, creditPacks: [] }, BUNDLES);
    renderPricing();
    await screen.findAllByText('Pro');
    expect(screen.queryByRole('heading', { name: 'AI credits' })).toBeNull();
  });
});

describe('public pricing page — CTAs and honesty', () => {
  it('free starts free, a priced plan is chosen in the store, an unpriced plan is “let’s talk”', async () => {
    mockReads({ tiers: [FREE, PRO, ENTERPRISE], featureLabels: LABELS }, BUNDLES);
    renderPricing();
    const start = await screen.findByRole('link', { name: 'Start free' });
    expect(start.getAttribute('href')).toBe('/chat');
    expect(screen.getByRole('link', { name: 'Choose Pro' }).getAttribute('href')).toBe('/marketplace/bundles');
    expect(screen.getByText('Let’s talk')).toBeTruthy();
  });

  it('never invents a price for an unconfigured tier, and an empty catalog says so', async () => {
    mockReads({ tiers: [{ tier: 'free', name: 'Free', features: ['docs'] }, { tier: 'pro', name: 'Pro', features: ['docs', 'csm'] }], featureLabels: LABELS }, []);
    const { container } = renderPricing();
    await screen.findAllByText('Pro');
    expect(container.textContent).not.toMatch(/\$\d/);
    expect(screen.queryByRole('radiogroup')).toBeNull(); // no annual price anywhere ⇒ no switch

    cleanup();
    mockReads({ tiers: [], creditPacks: [] }, []);
    renderPricing();
    expect(await screen.findByText('No plans configured yet.')).toBeTruthy();
  });
});
