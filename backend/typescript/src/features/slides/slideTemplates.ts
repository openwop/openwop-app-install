/**
 * Slide layout templates (ADR 0310 Phase B) — the closed set of one-click
 * slide starters served on the editor catalog route (the app-builder screen
 * templates seam, ADR 0305 Phase F). Each carries `content` merged verbatim
 * into the new frame (the fixed-schema template form): one starter per layout
 * in the artifact schema's closed world. Data only — never executable.
 */

export interface SlideTemplate {
  id: string;
  name: string;
  description: string;
  content: Record<string, unknown>;
}

export const SLIDE_TEMPLATES: readonly SlideTemplate[] = [
  {
    id: 'title',
    name: 'Title slide',
    description: 'A deck opener: big title with a supporting subtitle.',
    content: { layout: 'title', title: 'Presentation title', subtitle: 'A one-line supporting subtitle' },
  },
  {
    id: 'title-bullets',
    name: 'Bulleted points',
    description: 'A title with up to twelve short bullet points.',
    content: { layout: 'title-bullets', title: 'Key points', bullets: ['First point', 'Second point', 'Third point'] },
  },
  {
    id: 'section',
    name: 'Section divider',
    description: 'A full-bleed section heading to break the deck into chapters.',
    content: { layout: 'section', title: 'Section title' },
  },
  {
    id: 'quote',
    name: 'Quote',
    description: 'A pull quote with an attribution line.',
    content: { layout: 'quote', title: 'A memorable quote worth a whole slide.', attribution: 'Attribution' },
  },
  {
    id: 'image',
    name: 'Image',
    description: 'A titled slide built around one image.',
    content: { layout: 'image', title: 'Image headline' },
  },
  {
    id: 'blank',
    name: 'Blank',
    description: 'An empty slide with speaker notes only.',
    content: { layout: 'blank' },
  },
];
