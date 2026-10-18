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
 * - nothing Stripe-shaped reaches the page (the case-1 payload carries
 *   Stripe-shaped extra fields, so a renderer that dumps raw tier data reds).
 *
 * The override is a DOUBLE GUARD (PricingPage.tsx): `fallback` gates the FAQ
 * READ and the sections ternary gates the RENDER. The override case asserts
 * both — the loader is never called (w50g2-faq-override-flag) and the authored
 * sections win (w50g2-faq-override-sections).
 *
 * Sabotages that red it (/grade-tests w50): a trial plan dropped, a grace of 0
 * stated, a null lapse read as 0, swapped grace counts, a non-standalone bundle
 * listed, the both-facts rollover question asked without packs, a trial
 * question with no trial, an unpriced FAQ, a wrong support URL.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PublicPage, PublicPageResult } from '../siteClient.js';
import type { BillingPolicy, CreditPack, PublicBundle, PublicTier } from '../publicPricingClient.js';
import { messages as en } from '../i18n/en.js';

const pageResult = vi.fn<() => Promise<PublicPageResult>>();
vi.mock('../siteClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPublicPageResult: () => pageResult(),
}));
// A spy around the REAL loader (PricingPage imports it dynamically): the cases
// await its settle instead of sleeping, and the override asserts it never ran.
vi.mock('../pricingFaq.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('../pricingFaq.js')>();
  return { ...m, loadPricingFaq: vi.fn(m.loadPricingFaq) };
});

const { PricingPage } = await import('../PricingPage.js');
const { loadPricingFaq } = await import('../pricingFaq.js');

afterEach(() => { cleanup(); vi.mocked(loadPricingFaq).mockClear(); pageResult.mockReset(); vi.unstubAllGlobals(); });

/** The /public/pricing wire body this page reads (featureLabels optional here). */
/** Stripe ids the server must never send — only ever planted as a leak canary. */
interface StripeLeak { stripePriceId?: string; stripeProductId?: string }
interface PricingBody { tiers: Array<PublicTier & StripeLeak>; creditPacks: CreditPack[]; billingPolicy?: BillingPolicy }

const PAID_TIERS: PublicTier[] = [
  { tier: 'free', name: 'Free', features: [], display: { price: '$0' } },
  { tier: 'pro', name: 'Pro', features: [], limits: { aiCreditsMonthly: 5000 }, display: { price: '$39', cadence: '/mo' }, trialDays: 14 },
  { tier: 'team', name: 'Team', features: [], limits: { aiCreditsMonthly: 25000 }, display: { price: '$149', cadence: '/mo' }, trialDays: 14 },
];

/** The tier with NO trial configured (the field absent, as the wire sends it). */
function withoutTrial(x: PublicTier): PublicTier {
  const { trialDays, ...rest } = x;
  void trialDays;
  return rest;
}
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
function stub(pricing: PricingBody, bundles: PublicBundle[] = []): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => (String(url).includes('/public/pricing') ? json(pricing) : json({ bundles }))));
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
      // Wire-extra Stripe ids the server must never send — planted so the
      // "nothing Stripe-shaped" assertion below can fail.
      tiers: PAID_TIERS.map((x) => (x.tier === 'pro' ? { ...x, stripePriceId: 'price_1TestLeak', stripeProductId: 'prod_TestLeak' } : x)),
      creditPacks: [{ credits: 1000, price: '$5' }],
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
      tiers: PAID_TIERS.map((x) => (x.tier === 'pro' ? { ...x, trialDays: 30 } : withoutTrial(x))),
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
    stub({ tiers: PAID_TIERS.map(withoutTrial), creditPacks: [], billingPolicy: { pastDueGraceDays: 7, publicLapseGraceDays: 14 } });
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
    // Absence counts only once the FAQ read has SETTLED (and answered null).
    await waitFor(() => expect(loadPricingFaq).toHaveBeenCalledTimes(1));
    let items: unknown;
    await act(async () => { items = await vi.mocked(loadPricingFaq).mock.results[0]?.value; });
    expect(items).toBeNull();
    expect(screen.queryByRole('heading', { name: en.pricingFaqHeading })).toBeNull();
  });

  it('an operator-authored pricing page fully overrides the fallback FAQ', async () => {
    stub({ tiers: PAID_TIERS, creditPacks: [], billingPolicy: { pastDueGraceDays: 7, publicLapseGraceDays: 14 } });
    pageResult.mockResolvedValue({ status: 'ok', page: authored() });
    render(<MemoryRouter><PricingPage /></MemoryRouter>);
    await screen.findByText('Operator body');
    // Guard 1 (the read): the effect runs at commit, so a fallback FAQ read
    // would already have been started here.
    expect(loadPricingFaq).not.toHaveBeenCalled();
    // Guard 2 (the render): the authored sections, not the fallback's.
    expect(screen.queryByRole('heading', { name: en.pricingFaqHeading })).toBeNull();
    expect(screen.queryByRole('link', { name: en.pricingSupportLabel })).toBeNull();
  });
});
