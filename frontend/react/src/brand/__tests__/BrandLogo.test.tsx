/**
 * `BrandLogo` must render the inline OpenWOP SVG ONLY for the stock mark path and an
 * `<img>` for any other `src` — including a white-label fork's own default mark. Before
 * this test the component compared `src` against `BRAND_DEFAULTS.markSrc`, which a fork
 * legitimately changes, so the fork's default rendered the stock OpenWOP mark while the
 * branding guard (a string scan) saw nothing wrong. The test is posture-agnostic: it holds
 * in the stock build (defaults ARE the stock mark) and in any fork (defaults are not).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { BrandLogo } from '../BrandLogo.js';
import { BRAND_DEFAULTS, STOCK_OPENWOP_MARK_SRC } from '../defaults.js';

afterEach(cleanup);

describe('BrandLogo — stock vs custom mark', () => {
  it('renders the SHIPPED default mark correctly for this build (inline mark iff the default IS the stock mark)', () => {
    const { container } = render(<BrandLogo src={BRAND_DEFAULTS.markSrc} />);
    if (BRAND_DEFAULTS.markSrc === STOCK_OPENWOP_MARK_SRC) {
      expect(container.querySelector('img')).toBeNull();
      expect(container.querySelector('.brand-logo')).not.toBeNull();
    } else {
      expect(container.querySelector('img')?.getAttribute('src')).toBe(BRAND_DEFAULTS.markSrc);
      expect(container.querySelector('.brand-logo')).toBeNull();
    }
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
  it('a dark variant renders two <img>s', () => {
    const { container } = render(<BrandLogo src="/brand/x.svg" srcDark="/brand/x-dark.svg" />);
    expect(container.querySelectorAll('img')).toHaveLength(2);
  });
});
