/**
 * ADR 0510 §6 white-label lockup — the ONE rendering decision for a brand's full
 * identity. A configured lockup renders intact (with its dark-mode variant, both
 * carrying the consumer's lockup class) and no product name; without one, the
 * configured MARK and the product name render as the fallback.
 *
 * Sabotage-witnessed (wave 51): ignore `lockupSrc`, drop its dark variant or pass the
 * mark class → case 1 red; render a different mark src or swap the product class in
 * the fallback → case 2 red.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrandLockup } from '../BrandLockup.js';
import { BRAND_DEFAULTS } from '../defaults.js';

describe('BrandLockup', () => {
  it('renders the supplied full lockup and its dark-mode variant', () => {
    const { container } = render(
      <BrandLockup
        brand={{
          ...BRAND_DEFAULTS,
          productName: 'Acme',
          lockupSrc: '/acme-lockup.svg',
          lockupSrcDark: '/acme-lockup-dark.svg',
        }}
        lockupClassName="lockup"
        markClassName="mark"
        productClassName="product"
      />,
    );

    const images = container.querySelectorAll('img');
    expect(images).toHaveLength(2);
    expect(images[0]?.getAttribute('src')).toBe('/acme-lockup.svg');
    expect(images[0]?.className).toContain('lockup');
    expect(images[0]?.className).toContain('brandlogo--light');
    expect(images[1]?.getAttribute('src')).toBe('/acme-lockup-dark.svg');
    expect(images[1]?.className).toContain('lockup');
    expect(images[1]?.className).toContain('brandlogo--dark');
    expect(screen.queryByText('Acme')).toBeNull();
  });

  it('falls back to the mark and product name when no lockup is configured', () => {
    const { container } = render(
      <BrandLockup
        brand={{ ...BRAND_DEFAULTS, productName: 'Acme', markSrc: '/acme-mark.svg', markSrcDark: '', lockupSrc: '' }}
        lockupClassName="lockup"
        markClassName="mark"
        productClassName="product"
      />,
    );

    const images = container.querySelectorAll('img');
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute('src')).toBe('/acme-mark.svg');
    expect(images[0]?.className).toBe('mark');
    expect(screen.getByText('Acme').className).toBe('product');
  });
});
