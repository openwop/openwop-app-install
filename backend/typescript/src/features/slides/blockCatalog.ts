/**
 * The slides BLOCK catalog (ADR 0328 Phase 3) — the closed block vocabulary
 * for blocks-based slides, registered through the SAME host machinery as the
 * app-builder catalog (`registerCanvasComponents('canvas.slides', …)`): one
 * source for the editor palette, closed-world validation, and (Phase 6) the
 * AI prompt. Blocks never carry x/y — geometry belongs to the slide VARIANT
 * (blocks-not-freeform, the research doc's constrain-the-substrate rule).
 */
import { registerCanvasComponents, type ComponentDef, type ComponentPropDef } from '../../host/canvasComponentCatalog.js';

export const SLIDES_CANVAS_TYPE = 'canvas.slides';

const hideNever: never[] = []; // slides have no responsive hide — decks are 16:9 fixed

void hideNever;

const RAW_BLOCKS: readonly ComponentDef[] = [
  { type: 'heading', label: 'Heading', category: 'text',
    props: [
      { name: 'text', type: 'string', required: true },
      { name: 'level', type: 'enum', options: ['1', '2', '3'], default: '2' },
    ] },
  { type: 'text', label: 'Text', category: 'text',
    props: [
      { name: 'text', type: 'longtext', required: true },
      { name: 'size', type: 'enum', options: ['sm', 'md', 'lg'], default: 'md' },
      { name: 'tone', type: 'enum', options: ['default', 'muted', 'accent'], default: 'default' },
    ] },
  { type: 'bullets', label: 'Bullets', category: 'text',
    props: [{ name: 'items', type: 'stringlist', label: 'Items (one per line)', required: true }] },
  { type: 'quote', label: 'Quote', category: 'text',
    props: [
      { name: 'text', type: 'longtext', required: true },
      { name: 'attribution', type: 'string' },
    ] },
  { type: 'callout', label: 'Callout', category: 'text',
    props: [
      { name: 'text', type: 'string', required: true },
      { name: 'tone', type: 'enum', options: ['info', 'success', 'warning', 'danger'], default: 'info' },
    ] },
  { type: 'code', label: 'Code', category: 'text',
    props: [
      { name: 'text', type: 'longtext', required: true },
      { name: 'language', type: 'enum', options: ['text', 'js', 'ts', 'python', 'json', 'bash', 'sql'], default: 'text' },
    ] },
  { type: 'image', label: 'Image', category: 'media',
    props: [
      { name: 'src', type: 'mediaRef', label: 'Image' },
      { name: 'fit', type: 'enum', options: ['cover', 'contain'], default: 'cover' },
      { name: 'caption', type: 'string' },
    ] },
  { type: 'chart', label: 'Chart', category: 'data',
    description: 'An interactive.chart spec (JSON) rendered by the shared ChartRenderer.',
    props: [{ name: 'spec', type: 'longtext', label: 'Chart spec (JSON)' }] },
  { type: 'table', label: 'Table', category: 'data',
    props: [
      { name: 'columns', type: 'string', required: true, label: 'Columns (comma-separated)' },
      { name: 'rows', type: 'longtext', label: 'Rows (one per line, cells comma-separated)' },
    ] },
  { type: 'statCard', label: 'Stat card', category: 'data',
    props: [
      { name: 'label', type: 'string', required: true },
      { name: 'value', type: 'string', required: true },
      { name: 'delta', type: 'string' },
      { name: 'tone', type: 'enum', options: ['default', 'success', 'warning', 'danger'], default: 'default' },
    ] },
  { type: 'divider', label: 'Divider', category: 'layout', props: [] },
  { type: 'spacer', label: 'Spacer', category: 'layout',
    props: [{ name: 'size', type: 'enum', options: ['sm', 'md', 'lg'], default: 'md' }] },
];

// ADR 0328 Phase 8 — per-element build timing (the PowerPoint with-previous/
// after-previous canon, two modes): meaningful only while the slide's `build`
// toggle is on; ABSENT = 'after' (a new step — the prior order-is-build
// behavior, byte-identical for old decks). Catalog-declared so the editor
// panel and the closed-world tree validation both follow automatically.
const BUILD_PROP: ComponentPropDef = { name: 'buildTiming', type: 'enum', label: 'Build timing', options: ['after', 'with'], default: 'after' };

export const SLIDE_BLOCKS: readonly ComponentDef[] = RAW_BLOCKS.map((b) => ({
  ...b,
  props: [...(b.props ?? []), BUILD_PROP],
}));

export const SLIDE_VARIANTS = ['full', 'hero', 'split', 'two-col'] as const;
export type SlideVariant = (typeof SLIDE_VARIANTS)[number];

/** XCH-SLIDES-1 (LLM-EXCHANGE-AUDIT Wave 3): the one-line closed type list
 *  the pack nodes interpolate into their prompts — generated from the SSoT so
 *  the pack's pinned fallback can never silently drift. Format matches the
 *  pack's historical BLOCK_TYPES string. */
export function blockTypeListForPrompt(): string {
  return SLIDE_BLOCKS.map((b) => b.type).join(', ');
}

export function registerSlideBlocks(): void {
  registerCanvasComponents(SLIDES_CANVAS_TYPE, SLIDE_BLOCKS);
}
