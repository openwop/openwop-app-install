/**
 * ADR 0363 P2 — CMS page → ContentA11yModel projector. Pure; imports only the
 * shared model type. CMS sections carry flat per-section headings (no H1/H2/H3
 * hierarchy) and author no colors, so this projects images and link text.
 * heading-skip and low-contrast do not apply.
 *
 * ADR 1100 D3 — images are found by the field names every renderer reads, not
 * per section type. Any object in a section's data (list items included, up to
 * {@link CMS_A11Y_MAX_DEPTH} levels) with a non-empty `token` or `imageToken` is a
 * picture whose alt is the `alt` beside it. Before this the projector read
 * `image.token` and `hero.imageToken` only, and called a page with a dozen
 * unlabelled column and gallery pictures clean. The two exceptions are where a
 * renderer shows the top-level picture only for one `visual` (hero, richText),
 * so a token left behind after switching the visual is not reported. CMS inline
 * markdown renders no images, so there is no markdown-image rule. Markdown links
 * in other fields are not checked (`A11Y89-19`). Callers pass the RESOLVED
 * sections, so shared-section content is seen (a reference carries `data: {}`).
 *
 * A section with more than one picture gives each its own ref,
 * `<sectionId>#<n>` (1-based, document order), so the panel can say which one.
 */

import type { ContentA11yModel } from '../../a11y/contentA11y.js';
import type { Section } from './cmsClient.js';
import { HERO_VISUALS } from './sectionStyles.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The image-token field names (the Reviewer prompt names the same set; a
 *  backend test pins the two together). */
export const CMS_IMAGE_TOKEN_KEYS = ['token', 'imageToken'] as const;

/** How deep below a section's `data` a picture is looked for (shared with the
 *  library alt fill, `altFromLibrary.ts`). */
export const CMS_A11Y_MAX_DEPTH = 4;

/** `<sectionId>#<n>` → `{ sectionId, item }`; a bare section id has no item. */
export function splitA11yRef(ref: string): { sectionId: string; item?: number } {
  const m = /^(.*)#(\d+)$/.exec(ref);
  return m ? { sectionId: m[1]!, item: Number(m[2]) } : { sectionId: ref };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function imageTokenOf(o: Record<string, unknown>): string {
  for (const k of CMS_IMAGE_TOKEN_KEYS) if (str(o[k])) return str(o[k]);
  return '';
}

/** The alt of every picture nested BELOW `value` (the value itself is the caller's call). */
function collectNested(value: unknown, out: string[], depth: number): void {
  if (depth > CMS_A11Y_MAX_DEPTH) return;
  const visit = (child: unknown): void => {
    if (isRecord(child) && imageTokenOf(child)) out.push(str(child.alt));
    collectNested(child, out, depth + 1);
  };
  if (Array.isArray(value)) value.forEach(visit);
  else if (isRecord(value)) Object.values(value).forEach(visit);
}

/** The alts of every picture a section renders, in document order. */
function sectionImageAlts(s: Section): string[] {
  const d = s.data ?? {};
  const out: string[] = [];
  if (s.type === 'hero') {
    // `resolveHeroVisual`: an authored visual wins; with none, a picture means
    // `image`. Only that visual's own subtree (`d[visual]`, e.g. the hub) renders.
    const visual = (HERO_VISUALS as readonly string[]).includes(str(d.visual)) ? str(d.visual) : '';
    if ((visual === '' || visual === 'image') && str(d.imageToken)) out.push(str(d.alt));
    if (visual && visual !== 'image' && isRecord(d[visual])) {
      const sub = d[visual] as Record<string, unknown>;
      if (imageTokenOf(sub)) out.push(str(sub.alt));
      collectNested(sub, out, 1);
    }
    return out;
  }
  if (s.type === 'richText') {
    if (d.visual === 'image' && str(d.imageToken)) out.push(str(d.alt));
    collectNested(d, out, 0);
    return out;
  }
  if (imageTokenOf(d)) out.push(str(d.alt));
  collectNested(d, out, 0);
  return out;
}

export function cmsPageToA11yModel(sections: readonly Section[]): ContentA11yModel {
  const images: ContentA11yModel['images'] = [];
  const links: ContentA11yModel['links'] = [];
  sections.forEach((s, i) => {
    const d = s.data ?? {};
    const ref = s.sectionId || `section-${i}`;
    const alts = sectionImageAlts(s);
    alts.forEach((alt, k) => images.push({ alt, ref: alts.length > 1 ? `${ref}#${k + 1}` : ref }));
    if (s.type === 'hero') {
      // Hero CTAs are links; check their label text (empty/generic).
      if (str(d.ctaUrl)) links.push({ text: str(d.ctaLabel), ref });
      if (str(d.ctaUrl2)) links.push({ text: str(d.ctaLabel2), ref });
    } else if (s.type === 'cta' && str(d.url)) {
      links.push({ text: str(d.label), ref });
    }
  });
  return { images, headings: [], links };
}
