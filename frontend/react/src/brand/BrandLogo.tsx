/**
 * The ONE mark-image decision (ADR 0510 §6, DSA-015/016): the default OpenWOP
 * mark renders as an inline `currentColor` SVG so it follows the APP's
 * effective mode — the manual `html.theme-dark/.theme-light` toggle AND the
 * system preference — while a white-label custom asset stays an `<img>`.
 *
 * Custom brands MAY supply a dark-mode variant (`srcDark`, the additive
 * ADR 0510 §6 schema). Both variants render and CSS shows exactly one per
 * effective mode (`.brandlogo--light/--dark` in foundations) — zero JS, no
 * observer, flips instantly with the theme class. Dimensions are reserved by
 * the consumer's slot classes, so a swap never shifts chrome.
 *
 * Both `BrandMark` (app header) and `PublicShell` (public chrome) render marks
 * through this component; do not re-derive the default-vs-custom choice at a
 * call site.
 *
 * Decorative by contract: the adjacent wordmark/product name carries the
 * accessible name, so the mark is `alt=""` + `aria-hidden` in all branches.
 */
import { STOCK_OPENWOP_MARK_SRC } from './defaults.js';
import { lazy, Suspense } from 'react';
// Lazy (entry-chunk structural split): the inline OpenWOP mark is ~8 kB of SVG that a fork with its
// own mark never renders — keep it out of the entry chunk.
const OpenwopLogo = lazy(() => import('./OpenwopLogo.js').then((m) => ({ default: m.OpenwopLogo })));

export function BrandLogo({ src, srcDark, imgClassName }: {
  src: string | undefined;
  /** Dark-mode variant for a custom brand (ADR 0510 §6, additive). */
  srcDark?: string | undefined;
  imgClassName?: string;
}): JSX.Element {
  // The inline mark is the STOCK OpenWOP identity, so the comparison is against
  // the stock path — not `BRAND_DEFAULTS.markSrc`, which a fork legitimately
  // changes (PracticeMatch ships its own mark as the default; comparing against
  // BRAND_DEFAULTS rendered the OpenWOP mark for the fork's own default).
  const isStock = !src || src === STOCK_OPENWOP_MARK_SRC;
  if (isStock) return <Suspense fallback={<span className="brand-logo" aria-hidden="true" />}><OpenwopLogo /></Suspense>;
  if (!srcDark) return <img src={src} alt="" aria-hidden="true" className={imgClassName} />;
  const base = imgClassName ? `${imgClassName} ` : '';
  return (
    <>
      <img src={src} alt="" aria-hidden="true" className={`${base}brandlogo--light`} />
      <img src={srcDark} alt="" aria-hidden="true" className={`${base}brandlogo--dark`} />
    </>
  );
}
