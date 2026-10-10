/**
 * ADR 0836 D7 — the ONE "is this an internal app path?" predicate for authored
 * links. An internal path is a single leading `/` that a browser cannot turn into
 * a different origin:
 *
 * - not `//host` or `/\host` (protocol-relative → external);
 * - no ASCII control character or whitespace anywhere. The URL parser STRIPS tab,
 *   CR and LF before it resolves, so `"/\t/evil.com"` passed the old
 *   `/^\/(?![/\\])/` test and still resolved to `https://evil.com/`.
 *
 * Used at write time (`cmsService.safeLink`) and at every render exit
 * (`publishing/sectionHtml.ts`). The two frontend renderers mirror it, pinned by
 * the shared vector table in `test/adr0836-internal-href.test.ts`.
 */
export function isInternalHref(href: string): boolean {
  return /^\/(?![/\\])/.test(href) && !/[\u0000-\u001f\u0020\u007f]/.test(href);
}
