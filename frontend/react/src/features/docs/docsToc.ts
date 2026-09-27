/**
 * In-page TOC derivation (UX-D3) — DOM-derived per the architect ruling: the
 * doc body renders through the shared FrontPage (sections + markdown), so the
 * only complete heading source is what ACTUALLY renders (section headings AND
 * markdown `##` headings). Pure helpers here; the observer effect lives in the
 * page component. Capped at h3 (an h4 ladder is noise, per the design pass).
 */

export interface TocEntry {
  id: string;
  text: string;
  /** 2 = top-level, 3 = nested one step. */
  level: 2 | 3;
}

/** From the SHARED home (R2-D10): the cms renderer now emits ids with the same
 *  algorithm, so both sides must use one implementation. Re-exported for the
 *  existing consumers/tests. */
import { headingSlug } from '../cms/headingSlug.js';
export { headingSlug };

/** Extract the TOC from a rendered container: h1/h2 → level 2, h3 → level 3
 *  (h4+ ignored). Assigns slugified ids to headings that lack one, deduping
 *  with a numeric suffix. Returns [] when fewer than 2 headings (no TOC). */
export function deriveToc(container: HTMLElement): TocEntry[] {
  const headings = Array.from(container.querySelectorAll<HTMLElement>('h1, h2, h3'));
  const seen = new Map<string, number>();
  const entries: TocEntry[] = [];
  for (const h of headings) {
    const text = (h.textContent ?? '').trim();
    if (!text) continue;
    // R2R-1 — dedupe PRE-ASSIGNED ids too: SectionRenderer now stamps every
    // section heading with its slug (R2-D10), so two sections sharing one
    // heading text arrive as DUPLICATE ids. Guarding only `!h.id` let the
    // duplicate through — invalid HTML, duplicate TOC React keys, and both
    // TOC links jumping to the first section. First occurrence keeps its id
    // (cold-load fragments stay stable); later collisions are rewritten.
    const base = h.id || headingSlug(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    h.id = n === 0 ? base : `${base}-${n + 1}`;
    entries.push({ id: h.id, text, level: h.tagName === 'H3' ? 3 : 2 });
  }
  return entries.length >= 2 ? entries : [];
}
