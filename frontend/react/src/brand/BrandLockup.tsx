/**
 * One rendering decision for a white-label's full brand identity.
 *
 * A configured lockup is artwork: render it intact, including its dark-mode
 * variant. Distributions without one retain the stock mark + product-name
 * fallback. Consumers provide an accessible name on the enclosing link because
 * all logo artwork is decorative by contract (BrandLogo renders alt="").
 */
import type { BrandConfig } from './defaults.js';
import { BrandLogo } from './BrandLogo.js';

export function BrandLockup({
  brand,
  lockupClassName,
  markClassName,
  productClassName,
}: {
  brand: BrandConfig;
  lockupClassName: string;
  markClassName: string;
  productClassName: string;
}): JSX.Element {
  if (brand.lockupSrc) {
    return (
      <BrandLogo
        src={brand.lockupSrc}
        srcDark={brand.lockupSrcDark || undefined}
        imgClassName={lockupClassName}
      />
    );
  }

  return (
    <>
      <BrandLogo
        src={brand.markSrc}
        srcDark={brand.markSrcDark || undefined}
        imgClassName={markClassName}
      />
      <span className={productClassName}>{brand.productName}</span>
    </>
  );
}
