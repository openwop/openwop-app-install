/**
 * ADR 1069 D4 — authored `pricing.plans` replace the live billing read with
 * the D3 named tier cards.
 *
 * Pins: with plans, the section makes NO billing fetch and shows each plan's
 * name as its heading, its status as a pill, its blurb and its button; the
 * highlighted plan is the dark card with the primary button; no number is
 * drawn; and a pricing section without plans still reads the billing catalog.
 *
 * Sabotage-witnessed: rendering the billing grid when plans are set (a fetch
 * happens), dropping the inverse tone on the highlight, or drawing the status
 * inside the title each reds a case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ tiers: [], bundles: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { fetchSpy.mockClear(); vi.stubGlobal('fetch', fetchSpy); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const renderPricing = (data: Record<string, unknown>): HTMLElement => {
  const s: Section = { sectionId: 'sec:p', type: 'pricing', data };
  return render(<MemoryRouter><RenderSection section={s} mode="public" /></MemoryRouter>).container;
};
const PLANS = [
  { name: 'Pilot', status: 'Open now', blurb: 'Your first production, made with us.', ctaLabel: 'Request a pilot', ctaUrl: '/p/pilot', highlight: true },
  { name: 'Solo', status: 'Coming', ctaLabel: 'Join the list', ctaUrl: '/p/pilot' },
];

describe('pricing section with authored plans (ADR 1069 D4)', () => {
  it('draws the named tier cards and makes no billing read', async () => {
    const c = renderPricing({ heading: 'Plans', blurb: 'Pilots are open now.', plans: PLANS });
    expect(c.querySelector('.fp-cols--plans-named')).not.toBeNull();
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Pilot', 'Solo']);
    expect([...c.querySelectorAll('.fp-col__status .fp-col__badge')].map((b) => b.textContent)).toEqual(['Open now', 'Coming']);
    expect(screen.getByText('Your first production, made with us.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Join the list' }).getAttribute('href')).toBe('/p/pilot');
    expect(c.textContent).not.toMatch(/\d/);
    await Promise.resolve();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the highlighted plan is the dark card', () => {
    const c = renderPricing({ plans: PLANS });
    const [pilot, solo] = [...c.querySelectorAll<HTMLElement>('.fp-col')];
    expect(pilot!.classList.contains('fp-col--highlight')).toBe(true);
    expect(pilot!.classList.contains('fp-tone--inverse')).toBe(true);
    expect(solo!.classList.contains('fp-col--highlight')).toBe(false);
  });

  it('without plans the section still reads the billing catalog', async () => {
    renderPricing({ heading: 'Plans' });
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(String((fetchSpy.mock.calls[0] as unknown[] | undefined)?.[0])).toContain('/public/pricing');
  });
});
