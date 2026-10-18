/**
 * ADR 0889 residue — focus hand-back for the Evals tab. A trigger carries a
 * `data-focus-key`; when the view it opened closes, focus returns to it.
 * Matched by attribute value, not a selector, so a key holding a suite ref or
 * run id (`@`, `/`, `.`) needs no escaping (and no `CSS.escape`, absent in jsdom).
 */
export function focusByKey(key: string): boolean {
  const el = Array.from(document.querySelectorAll<HTMLElement>('[data-focus-key]')).find((e) => e.getAttribute('data-focus-key') === key);
  el?.focus();
  return !!el;
}
