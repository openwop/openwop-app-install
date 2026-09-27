/**
 * UX_UPGRADE-site G5 — the plan-comparison matrix under the pricing tier cards.
 *
 * The invariant worth a test is HONESTY, not layout: the table is built from the
 * same `tiers[].features` the cards render, so a ✓ in the matrix must mean the
 * tier card lists that feature — and a — must mean it doesn't. It must also stay
 * out of the way when there is nothing to compare (one tier, or no features).
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

const PRICING: Section = { sectionId: 'p1', type: 'pricing', data: { heading: 'Plans' } };

/** Stub the two public reads `PricingSection` makes (tiers + add-on bundles). */
function mockPricing(tiers: unknown[]): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes('/public/pricing')) return { ok: true, json: async () => ({ tiers }) } as Response;
    return { ok: true, json: async () => ({ bundles: [] }) } as Response;
  }));
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const renderPricing = () => render(<MemoryRouter><RenderSection section={PRICING} mode="public" /></MemoryRouter>);

describe('pricing comparison matrix', () => {
  it('marks a feature included ONLY for the tiers whose card lists it', async () => {
    mockPricing([
      { tier: 'free', name: 'Free', features: ['Workflows'] },
      { tier: 'pro', name: 'Pro', features: ['Workflows', 'SSO'] },
    ]);
    renderPricing();
    const table = await screen.findByRole('table');

    const ssoRow = within(table).getByRole('rowheader', { name: 'SSO' }).closest('tr')!;
    const cells = within(ssoRow).getAllByRole('cell');
    expect(cells).toHaveLength(2);
    expect(within(cells[0]!).getByText('Not included')).toBeTruthy(); // Free
    expect(within(cells[1]!).getByText('Included')).toBeTruthy();     // Pro

    // Every feature named on ANY card gets a row — the union, deduped.
    expect(within(table).getAllByRole('rowheader').map((r) => r.textContent)).toEqual(['Workflows', 'SSO']);
  });

  it('a "*" (unrestricted) tier renders "Everything included" and NEVER crashes (prod crash regression)', async () => {
    // The live /public/pricing returns `features: "*"` (a STRING sentinel) for
    // unrestricted tiers; `(features ?? []).filter` used to throw and take the
    // whole pricing page down (TypeError: filter is not a function).
    mockPricing([
      { tier: 'free', name: 'Free', features: ['Workflows'] },
      { tier: 'pro', name: 'Pro', features: '*' },
    ]);
    renderPricing();
    // The card for the '*' tier renders its "everything" bullet (proves the page
    // survived — the crash happened before any tier card could paint).
    expect(await screen.findByText('Everything included')).toBeTruthy();
    expect(screen.getAllByText('Pro').length).toBeGreaterThan(0);
  });

  it('the compare matrix marks a "*" tier included for every feature, with no bogus "*" row', async () => {
    mockPricing([
      { tier: 'free', name: 'Free', features: ['Workflows'] },
      { tier: 'pro', name: 'Pro', features: '*' },
    ]);
    renderPricing();
    const table = await screen.findByRole('table');
    // Rows come ONLY from array tiers — 'Workflows', never a stray '*' character.
    expect(within(table).getAllByRole('rowheader').map((r) => r.textContent)).toEqual(['Workflows']);
    const row = within(table).getByRole('rowheader', { name: 'Workflows' }).closest('tr')!;
    const cells = within(row).getAllByRole('cell');
    expect(within(cells[0]!).getByText('Included')).toBeTruthy();  // Free lists it
    expect(within(cells[1]!).getByText('Included')).toBeTruthy();  // Pro '*' ⇒ has everything
  });

  it('humanizes raw feature ids and caps the card list with "and N more"', async () => {
    mockPricing([
      { tier: 'free', name: 'Free', features: ['app-builder', 'cdp', 'campaign-studio', 'crm', 'forms', 'comments', 'canvas-packs', 'commerce'] },
      { tier: 'pro', name: 'Pro', features: ['crm'] },
    ]);
    const { container } = renderPricing();
    // Humanized labels appear in BOTH the card bullets and the matrix rows — wait
    // on any, then scope the assertions to the Free card's feature list.
    await screen.findAllByText('App Builder');
    const card = container.querySelector('.fp-tier__features')! as HTMLElement;
    expect(within(card).getByText('App Builder')).toBeTruthy();
    expect(within(card).getByText('CDP')).toBeTruthy();             // acronym uppercased
    expect(within(card).getByText('Campaign Studio')).toBeTruthy();
    // 8 features, cap 6 → 6 bullets + an "and 2 more" line (never a 30-item wall).
    expect(within(card).getByText('and 2 more')).toBeTruthy();
  });

  it('renders NOTHING to compare with a single tier, or with no features', async () => {
    mockPricing([{ tier: 'pro', name: 'Pro', features: ['SSO'] }]);
    renderPricing();
    await screen.findByText('Pro');
    expect(screen.queryByRole('table')).toBeNull();

    cleanup();
    mockPricing([{ tier: 'free', name: 'Free' }, { tier: 'pro', name: 'Pro' }]);
    renderPricing();
    await screen.findByText('Pro');
    await waitFor(() => expect(screen.queryByRole('table')).toBeNull());
  });

  // R2-G5 (DISCARD-1): the tiers' usage limits rode the payload and were
  // discarded — Free vs Pro with the same feature list but 10× caps looked
  // identical. The matrix now carries one row per limit key.
  it('renders each usage limit as a locale-formatted row — and never invents a period/unit', async () => {
    mockPricing([
      { tier: 'free', name: 'Free', features: ['CRM'], limits: { workflowRuns: 1000 } },
      { tier: 'pro', name: 'Pro', features: ['CRM'], limits: { workflowRuns: 10000, seats: 25 } },
    ]);
    renderPricing();
    const table = await screen.findByRole('table');

    const runsRow = within(table).getByRole('rowheader', { name: 'Workflow Runs' }).closest('tr')!;
    const cells = within(runsRow).getAllByRole('cell').map((c) => c.textContent);
    expect(cells).toEqual(['1,000', '10,000']); // grouped, no fabricated "/month"

    // A tier without the key claims NOTHING — not zero, not unlimited.
    const seatsRow = within(table).getByRole('rowheader', { name: 'Seats' }).closest('tr')!;
    const seatCells = within(seatsRow).getAllByRole('cell');
    expect(within(seatCells[0]!).getByText('Not specified')).toBeTruthy();
    expect(seatCells[1]!.textContent).toContain('25');
  });

  // R2-G7 — the monthly/annual toggle. Additive: no annual price authored
  // anywhere ⇒ no toggle (the Linear annual-only/single-price pattern stays).
  it('renders NO billing toggle when no tier authors an annual price', async () => {
    mockPricing([
      { tier: 'free', name: 'Free', features: ['CRM'], display: { price: '$0', cadence: '/mo' } },
      { tier: 'pro', name: 'Pro', features: ['CRM'], display: { price: '$29', cadence: '/mo' } },
    ]);
    renderPricing();
    await screen.findByText('$29');
    expect(screen.queryByRole('group', { name: 'Billing period' })).toBeNull();
  });

  it('defaults to annual, shows the operator’s own note verbatim, and toggles honestly', async () => {
    mockPricing([
      // free has NO annual price — in annual mode it keeps ITS OWN price+cadence.
      { tier: 'free', name: 'Free', features: ['CRM'], display: { price: '$0', cadence: '/mo' } },
      { tier: 'pro', name: 'Pro', features: ['CRM'], display: { price: '$29', cadence: '/mo', priceAnnual: '$290', cadenceAnnual: '/yr', annualNote: 'Two months free on yearly' } },
    ]);
    renderPricing();
    const group = await screen.findByRole('group', { name: 'Billing period' });
    // Defaults to annual: the authored annual price + cadence render.
    expect(screen.getByText('$290')).toBeTruthy();
    expect(screen.getByText('/yr')).toBeTruthy();
    expect(screen.queryByText('$29')).toBeNull();
    // The tier without an annual price keeps its own single price + cadence.
    expect(screen.getByText('$0')).toBeTruthy();
    expect(screen.getByText('/mo')).toBeTruthy();
    // The note is the operator's claim, verbatim — never a computed figure.
    expect(screen.getByText('Two months free on yearly')).toBeTruthy();

    fireEvent.click(within(group).getByRole('button', { name: 'Pay monthly' }));
    await screen.findByText('$29');
    expect(screen.queryByText('$290')).toBeNull();
    expect(within(group).getByRole('button', { name: 'Pay monthly' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('limit-only tiers (no named features) still get a comparison table', async () => {
    mockPricing([
      { tier: 'free', name: 'Free', features: '*', limits: { workflowRuns: 100 } },
      { tier: 'pro', name: 'Pro', features: '*', limits: { workflowRuns: 10000 } },
    ]);
    renderPricing();
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('rowheader', { name: 'Workflow Runs' })).toBeTruthy();
  });
});
