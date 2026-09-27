/**
 * The header wordmark + icon mark. Renders the configured brand identity
 * (`brand.markSrc`, `brand.brandMark`) so App.tsx carries no literal
 * product name. The markup + `.brand-mark` / `.app-header-sub` classes
 * are preserved exactly from the previous inline header so styling is
 * unchanged.
 *
 * The mark `alt` is empty + `aria-hidden` on purpose: the adjacent
 * wordmark text already names the product to assistive tech, so the image
 * is decorative and must not be announced twice.
 */
import { BrandLogo } from './BrandLogo.js';
import { useBrand } from './BrandProvider.js';

export function BrandMark() {
  const brand = useBrand(); // re-renders when a super-admin override loads (ADR 0170)
  const { pre, emphasis, sub } = brand.brandMark;
  // The default-mark vs custom-<img> decision lives in BrandLogo (ADR 0510 §6) —
  // shared with the public shell so both chromes follow the app's effective mode.
  // The old `VITE_BRAND_LOGO_SRC` remains a compatibility alias for this slot.
  return (
    <h1 className="brand-mark">
      <BrandLogo src={brand.markSrc} srcDark={brand.markSrcDark || undefined} />
      <span>
        {pre}
        {emphasis ? <em>{emphasis}</em> : null}{' '}
        {sub ? <span className="app-header-sub">{sub}</span> : null}
      </span>
    </h1>
  );
}
