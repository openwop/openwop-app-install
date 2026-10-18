/**
 * `BrandLogo` must render the inline OpenWOP SVG ONLY for the stock mark path and an
 * `<img>` for any other `src` — including a white-label fork's own default mark. Before
 * this test the component compared `src` against `BRAND_DEFAULTS.markSrc`, which a fork
 * legitimately changes, so the fork's default rendered the stock OpenWOP mark while the
 * branding guard (a string scan) saw nothing wrong. The test is posture-agnostic: it holds
 * in the stock build (defaults ARE the stock mark) and in any fork (defaults are not).
 *
 * Sabotage-witnessed (wave 51): treat any `.svg` as stock → cases 2 + 4 red; treat only
 * a missing src as stock → cases 1 (stock build) + 3 red; ignore `srcDark` → case 4 red.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { BrandLogo } from '../BrandLogo.js';
import { BRAND_DEFAULTS, STOCK_OPENWOP_MARK_SRC } from '../defaults.js';

afterEach(cleanup);

describe('BrandLogo — stock vs custom mark', () => {
  it('renders the SHIPPED default mark correctly for this build (inline mark iff the default IS the stock mark)', () => {
    // One assertion path, still posture-agnostic: the inline mark iff this build's
    // default IS the stock path; otherwise the default renders as its own <img>.
    // (In the stock build this overlaps case 3 by design; in a fork it is the witness.)
    const stock = BRAND_DEFAULTS.markSrc === STOCK_OPENWOP_MARK_SRC;
    const { container } = render(<BrandLogo src={BRAND_DEFAULTS.markSrc} />);
    expect(container.querySelector('.brand-logo') !== null).toBe(stock);
    expect(container.querySelector('img')?.getAttribute('src') ?? null).toBe(stock ? null : BRAND_DEFAULTS.markSrc);
  });
  it('renders a custom mark as an <img>, never the inline OpenWOP SVG (the white-label case)', () => {
    const { container } = render(<BrandLogo src="/brand/acme-mark.svg" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/brand/acme-mark.svg');
    expect(container.querySelector('.brand-logo')).toBeNull();
  });
  it('renders the inline mark only for the STOCK OpenWOP src (lazily — a placeholder span first)', () => {
    const { container } = render(<BrandLogo src={STOCK_OPENWOP_MARK_SRC} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.brand-logo')).not.toBeNull();
  });
  it('a dark variant renders two <img>s: the light one and the dark one, each tagged for its mode', () => {
    // Twin: BrandLockup "renders the supplied full lockup" reaches the same branch through
    // `lockupSrc`; this case owns BrandLogo's contract directly (no consumer class).
    const { container } = render(<BrandLogo src="/brand/x.svg" srcDark="/brand/x-dark.svg" />);
    const images = container.querySelectorAll('img');
    expect(images).toHaveLength(2);
    expect(images[0]?.getAttribute('src')).toBe('/brand/x.svg');
    expect(images[0]?.className).toBe('brandlogo--light');
    expect(images[1]?.getAttribute('src')).toBe('/brand/x-dark.svg');
    expect(images[1]?.className).toBe('brandlogo--dark');
  });
});
