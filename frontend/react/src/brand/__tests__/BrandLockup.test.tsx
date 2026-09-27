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
    render(
      <BrandLockup
        brand={{ ...BRAND_DEFAULTS, productName: 'Acme' }}
        lockupClassName="lockup"
        markClassName="mark"
        productClassName="product"
      />,
    );

    expect(screen.getByText('Acme').className).toBe('product');
  });
});
