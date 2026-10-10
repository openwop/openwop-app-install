/**
 * ADR 0836 D7 — the browser mirror of the backend's ONE internal-link predicate
 * (`backend/typescript/src/host/internalHref.ts`). An internal path is a single
 * leading `/` that cannot become another origin: not `//` or `/\`, and no ASCII
 * control character or whitespace anywhere (the URL parser strips tab/CR/LF, so
 * `"/\t/evil.com"` resolved to `https://evil.com/`). Both copies run the same
 * vector table in `backend/typescript/test/adr0836-internal-href.test.ts`.
 */
export function isInternalHref(href: string): boolean {
  return /^\/(?![/\\])/.test(href) && !/[\u0000-\u001f\u0020\u007f]/.test(href);
}
