/** Motion helpers (A11Y-9) — JS-driven animation must honor the same
 *  `prefers-reduced-motion` contract the stylesheet's universal reset does. */

/** `'smooth'` normally, `'auto'` when the OS prefers reduced motion OR the user
 *  set the "Reduce motion" override (ADR 0363 P4 — `data-reduce-motion="reduce"`). */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  if (document.documentElement.getAttribute('data-reduce-motion') === 'reduce') return true;
  // jsdom (and some embedders) lack matchMedia — a MOTION helper must never be
  // the thing that crashes a click handler (ADR 0510 P3 review catch).
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}
