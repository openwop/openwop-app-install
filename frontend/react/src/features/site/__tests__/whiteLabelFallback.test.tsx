/**
 * #5226 — a white-label build never shows OpenWOP's own product copy or art.
 *
 * Seen on the MyndHyve cutover (2026-10-25): until the operator published its
 * CMS home, anonymous '/' rendered the OpenWOP story ("The reference app for
 * the OpenWOP protocol…"), and an un-authored legal-page hero drew the OpenWOP
 * protocol schematic. Red when the root fallback or the hero's default visual
 * stops branching on the stock identity; the stock-brand cases keep the
 * reference app's own page from regressing into the neutral one.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PublicPageResult } from '../siteClient.js';
import type { BrandConfig } from '../../../brand/defaults.js';
import { messages as en } from '../i18n/en.js';

const pageResult = vi.fn<() => Promise<PublicPageResult>>();
let demoMode = false;

vi.mock('../siteClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPublicPageResult: () => pageResult(),
}));
vi.mock('../visitorConsent.js', () => ({ consentTokenFor: () => undefined, loadPosture: async () => null }));
vi.mock('../VisitorConsentBanner.js', () => ({ VisitorConsentBanner: () => null }));
vi.mock('../visitorBeacon.js', () => ({ getVisitorKey: () => null, sendExperimentPageview: () => {} }));
vi.mock('../webVitalsBeacon.js', () => ({ reportWebVitals: () => {} }));
vi.mock('../../../client/useDemoMode.js', () => ({ useDemoMode: () => demoMode }));

const { brand } = await import('../../../brand/brand.js');
const { FrontPage } = await import('../FrontPage.js');
const stock: Pick<BrandConfig, 'productName' | 'tagline'> = { productName: brand.productName, tagline: brand.tagline };

function asWhiteLabel(): void {
  brand.productName = 'Acme Studio';
  brand.tagline = 'Campaigns, planned together';
}

afterEach(() => {
  cleanup(); vi.clearAllMocks(); demoMode = false;
  brand.productName = stock.productName; brand.tagline = stock.tagline;
});

function renderRoot(): void {
  render(<MemoryRouter><FrontPage orgId="org-1" slug="home" surface="root" /></MemoryRouter>);
}

const storyEyebrow = en.heroEyebrow;

describe('#5226 white-label root fallback', () => {
  it('a white-label build whose home is unpublished shows its own name, not the OpenWOP story', async () => {
    asWhiteLabel();
    pageResult.mockResolvedValue({ status: 'notFound' });
    renderRoot();
    expect(await screen.findByRole('heading', { level: 1, name: 'Acme Studio' })).toBeTruthy();
    expect(screen.getByText('Campaigns, planned together')).toBeTruthy();
    expect(screen.getByRole('link', { name: en.neutralCtaLabel })).toBeTruthy();
    expect(screen.queryByText(storyEyebrow)).toBeNull();
    expect(screen.queryByText(en.heroCtaLabel)).toBeNull();
    expect(screen.queryByText(en.heroVignetteOpen)).toBeNull();
  });

  it('the stock OpenWOP build keeps its story fallback', async () => {
    pageResult.mockResolvedValue({ status: 'notFound' });
    renderRoot();
    expect(await screen.findByText(storyEyebrow)).toBeTruthy();
  });
});

describe('#5226 un-authored hero visual', () => {
  const heroOnly: PublicPageResult = {
    status: 'ok',
    page: {
      slug: 'terms', title: 'Terms', updatedAt: '2026-10-25T00:00:00.000Z',
      sections: [{ sectionId: 'h', type: 'hero', data: { heading: 'Terms of Service' } }],
      seo: { title: 'Terms', description: '', canonicalUrl: '', ogTitle: 'Terms', ogDescription: '', noindex: false },
    },
  };

  it('draws no OpenWOP schematic on a white-label build', async () => {
    asWhiteLabel();
    pageResult.mockResolvedValue(heroOnly);
    render(<MemoryRouter><FrontPage orgId="org-1" slug="terms" surface="slug" /></MemoryRouter>);
    expect(await screen.findByRole('heading', { level: 1, name: 'Terms of Service' })).toBeTruthy();
    expect(screen.queryByText(en.heroVignetteOpen)).toBeNull();
  });

  it('keeps the schematic as the stock default', async () => {
    pageResult.mockResolvedValue(heroOnly);
    render(<MemoryRouter><FrontPage orgId="org-1" slug="terms" surface="slug" /></MemoryRouter>);
    expect(await screen.findByRole('heading', { level: 1, name: 'Terms of Service' })).toBeTruthy();
    expect(screen.getByText(en.heroVignetteOpen)).toBeTruthy();
  });
});
