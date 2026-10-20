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

/**
 * ADR 0920 D6 — a SAME-PAGE fragment link (`#one-minute-list`): `#` then a letter,
 * then up to 79 letters, digits, `_` or `-`. Nothing else: no bare `#`, no leading
 * digit, no whitespace, no `:` (so `#javascript:…` is refused), no markup. It never
 * leaves the page, so it is never an open-redirect shape. Used at write time
 * (`cmsService.safeLink`) and at the server render exits (`sectionHtml.ts`,
 * `sectionMarkdown.ts`).
 */
export const FRAGMENT_HREF_RE = /^#[A-Za-z][A-Za-z0-9_-]{0,79}$/;
export function isFragmentHref(href: string): boolean {
  return FRAGMENT_HREF_RE.test(href);
}
