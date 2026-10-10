/**
 * ADR 0820 §7 — the public /pricing fallback's FAQ.
 *
 * Pinned:
 * - with no authored `pricing` CMS page, the fallback renders a `faq` section
 *   (native <details>) plus a "contact support" CTA to /p/support;
 * - an operator-authored page FULLY replaces it (no fallback FAQ leaks in);
 * - the config numbers (trial length, past-due grace, public-lapse grace) come
 *   from the /public/pricing payload, so a changed env changes the copy;
 * - an unconfigured fact is left out, never defaulted; an unpriced deployment
 *   gets no billing FAQ at all;
 * - nothing Stripe-shaped reaches the page.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PublicPage, PublicPageResult } from '../siteClient.js';
import { messages as en } from '../i18n/en.js';

const pageResult = vi.fn<() => Promise<PublicPageResult>>();
vi.mock('../siteClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPublicPageResult: () => pageResult(),
}));

const { PricingPage } = await import('../PricingPage.js');

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

const PAID_TIERS = [
  { tier: 'free', name: 'Free', features: [], display: { price: '$0' } },
  { tier: 'pro', name: 'Pro', features: [], limits: { aiCreditsMonthly: 5000 }, display: { price: '$39', cadence: '/mo' }, trialDays: 14 },
  { tier: 'team', name: 'Team', features: [], limits: { aiCreditsMonthly: 25000 }, display: { price: '$149', cadence: '/mo' }, trialDays: 14 },
];

function stub(pricing: Record<string, unknown>, bundles: unknown[] = []): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes('/public/pricing')) return { ok: true, status: 200, json: async () => pricing } as Response;
    return { ok: true, status: 200, json: async () => ({ bundles }) } as Response;
  }));
}

function authored(): PublicPage {
  return {
    slug: 'pricing', title: 'Pricing', updatedAt: '2026-10-01T00:00:00.000Z',
    sections: [{ sectionId: 'a1', type: 'richText', data: { heading: 'Operator heading', text: 'Operator body' } }],
    seo: { title: 'p', description: '', canonicalUrl: '', ogTitle: 'p', ogDescription: '', noindex: false },
  };
}

async function faqGroups(): Promise<HTMLElement[]> {
  await screen.findByRole('heading', { name: en.pricingFaqHeading });
  return screen.getAllByRole('group'); // <details> ⇒ role=group
}
const answerFor = (groups: HTMLElement[], q: string): string => {
  const g = groups.find((el) => within(el).queryByText(q));
  if (!g) throw new Error(`no FAQ item "${q}"`);
  return g.textContent ?? '';
};

describe('PricingPage fallback FAQ', () => {
  it('renders the FAQ + a support CTA in the fallback, numbers from the payload', async () => {
    stub({
      tiers: PAID_TIERS, creditPacks: [{ credits: 1000, price: '$5' }],
      billingPolicy: { pastDueGraceDays: 7, publicLapseGraceDays: 14 },
    }, [{ bundleId: 'job-search', label: 'Job search', standalone: true, priceDisplay: { price: '$19' } }]);
    pageResult.mockResolvedValue({ status: 'notFound' });
    render(<MemoryRouter><PricingPage /></MemoryRouter>);
    const groups = await faqGroups();
    expect(groups.length).toBe(7);
    expect(answerFor(groups, en.pricingFaqTrialQ)).toContain('You can try Pro and Team free for 14 days.');
    const data = answerFor(groups, en.pricingFaqDataQ);
    expect(data).toContain('keep working for 7 days');
    expect(data).toContain('stay online for 14 days');
    expect(answerFor(groups, en.pricingFaqPlanQ)).toContain('Job search is sold separately');
    expect(answerFor(groups, en.pricingFaqRolloverQ)).toContain('don’t expire');
    const cta = screen.getByRole('link', { name: en.pricingSupportLabel });
    expect(cta.getAttribute('href')).toBe('/p/support');
    expect(document.body.textContent?.toLowerCase()).not.toMatch(/price_|prod_|sk_live|rk_live/);
  });

  it('follows the env: other numbers in ⇒ other numbers out; unset facts are left out', async () => {
    stub({
      tiers: PAID_TIERS.map((x) => (x.tier === 'pro' ? { ...x, trialDays: 30 } : { ...x, trialDays: undefined })),
      creditPacks: [],
      billingPolicy: { pastDueGraceDays: 0, publicLapseGraceDays: null },
    });
    pageResult.mockResolvedValue({ status: 'notFound' });
    render(<MemoryRouter><PricingPage /></MemoryRouter>);
    const groups = await faqGroups();
    expect(answerFor(groups, en.pricingFaqTrialQ)).toContain('You can try Pro free for 30 days.');
    const data = answerFor(groups, en.pricingFaqDataQ);
    expect(data).not.toContain('If a payment fails'); // no grace configured ⇒ unsaid
    expect(data).toContain(en.pricingFaqDataPublicStays);
    expect(answerFor(groups, en.pricingFaqPlanQ)).not.toContain('sold separately');
    // No packs ⇒ the question does not ask about packs, and no pack claim is made.
    expect(screen.queryByText(en.pricingFaqRolloverQ)).toBeNull();
    expect(answerFor(groups, en.pricingFaqRolloverAllowanceQ)).not.toContain('don’t expire');
  });

  it('no trial configured ⇒ no trial question', async () => {
    stub({ tiers: PAID_TIERS.map((x) => ({ ...x, trialDays: undefined })), creditPacks: [], billingPolicy: { pastDueGraceDays: 7, publicLapseGraceDays: 14 } });
    pageResult.mockResolvedValue({ status: 'notFound' });
    render(<MemoryRouter><PricingPage /></MemoryRouter>);
    await faqGroups();
    expect(screen.queryByText(en.pricingFaqTrialQ)).toBeNull();
  });

  it('an unpriced deployment gets no billing FAQ (positive control: the tier grid still renders)', async () => {
    stub({ tiers: [{ tier: 'free', name: 'Free', features: [] }], creditPacks: [] });
    pageResult.mockResolvedValue({ status: 'notFound' });
    render(<MemoryRouter><PricingPage /></MemoryRouter>);
    await screen.findByText('Free');
    await waitFor(() => expect(screen.queryByRole('heading', { name: en.pricingFaqHeading })).toBeNull());
  });

  it('an operator-authored pricing page fully overrides the fallback FAQ', async () => {
    stub({ tiers: PAID_TIERS, creditPacks: [], billingPolicy: { pastDueGraceDays: 7, publicLapseGraceDays: 14 } });
    pageResult.mockResolvedValue({ status: 'ok', page: authored() });
    render(<MemoryRouter><PricingPage /></MemoryRouter>);
    await screen.findByText('Operator body');
    // Give any stray fallback fetch a chance to land before asserting absence.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('heading', { name: en.pricingFaqHeading })).toBeNull();
    expect(screen.queryByRole('link', { name: en.pricingSupportLabel })).toBeNull();
  });
});
