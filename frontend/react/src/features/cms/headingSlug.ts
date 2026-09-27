/**
 * Slugify a heading's text into a stable anchor id (UX_UPGRADE-docs R2-D10).
 *
 * Lives in `cms` because the SHARED public renderer (`SectionRenderer`) now
 * emits these ids on section headings, and the docs TOC (`docs/docsToc.ts`)
 * must derive the SAME id for the same text — one algorithm, one home, and the
 * import direction stays docs→cms (docs already composes the cms renderer).
 * The backend prerender (`publishing/sectionHtml.ts`) carries a byte-equal
 * copy pinned by the shared fixture cases in BOTH suites — change one, the
 * other's test goes red.
 */
export function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'section';
}
