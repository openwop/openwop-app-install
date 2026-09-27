/**
 * ADR 0363 P2 — CMS page → ContentA11yModel projector. Pure; imports only the
 * shared model type. CMS sections carry flat per-section headings (no H1/H2/H3
 * hierarchy) and author no colors, so this projects only images (image + hero)
 * and link text (hero/cta CTAs). heading-skip and low-contrast do not apply.
 */

import type { ContentA11yModel } from '../../a11y/contentA11y.js';
import type { Section } from './cmsClient.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function cmsPageToA11yModel(sections: Section[]): ContentA11yModel {
  const images: ContentA11yModel['images'] = [];
  const links: ContentA11yModel['links'] = [];
  sections.forEach((s, i) => {
    const d = s.data ?? {};
    const ref = s.sectionId || `section-${i}`;
    if (s.type === 'image' && str(d.token)) {
      images.push({ alt: str(d.alt), ref });
    } else if (s.type === 'hero') {
      if (str(d.imageToken)) images.push({ alt: str(d.alt), ref });
      // Hero CTAs are links; check their label text (empty/generic).
      if (str(d.ctaUrl)) links.push({ text: str(d.ctaLabel), ref });
      if (str(d.ctaUrl2)) links.push({ text: str(d.ctaLabel2), ref });
    } else if (s.type === 'cta' && str(d.url)) {
      links.push({ text: str(d.label), ref });
    }
  });
  return { images, headings: [], links };
}
