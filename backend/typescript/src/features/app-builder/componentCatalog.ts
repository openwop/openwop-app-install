/**
 * App-builder component catalog (ADR 0153 Phase 2 + ADR 0305 Phase C). The closed set
 * of components the App Architect agent may emit and the editor palette offers —
 * contributed into the shared `host/canvasComponentCatalog` registry at boot. This is
 * the single source that drives the agent prompt, the palette, closed-world
 * validation, the live renderer, and all six export generators (which import
 * `APP_BUILDER_COMPONENTS` — never a hand-copied type list; that drifted once).
 *
 * Style depth (ADR 0305 Phase C) is TOKEN-SCALE, never free-form CSS: enum props like
 * `padding`/`radius`/`shadow`/`tone` carry closed scales the renderer + generators map
 * to framework idioms. Free-form transform/animation/gradient editing is a recorded
 * exclusion. Actions are `navigateTo` (prop type `screen`); data binding is
 * `list.bind` → a `dataSources[]` entry with `{{field}}` interpolation.
 */
import { registerCanvasComponents, type ComponentDef } from '../../host/canvasComponentCatalog.js';

export const APP_BUILDER_CANVAS_TYPE = 'canvas.app-builder';

/** Closed icon vocabulary for the `icon` component (curated Lucide names). The FE
 *  renderer keeps a name→glyph map with a safe generic fallback; keep the two in
 *  sync via the parity tests on both sides. */
export const ICON_NAMES = [
  'home', 'search', 'settings', 'user', 'users', 'heart', 'star', 'bell',
  'calendar', 'clock', 'mail', 'phone', 'camera', 'image', 'map-pin', 'send',
  'plus', 'check', 'x', 'arrow-right', 'arrow-left', 'menu', 'filter', 'download',
] as const;

/** Shared token-scale prop defs (ADR 0305 Phase C style depth). */
const SIZE_SCALE = ['none', 'sm', 'md', 'lg'] as const;
const padding = { name: 'padding', type: 'enum', options: SIZE_SCALE, default: 'none' } as const;
const radius = { name: 'radius', type: 'enum', options: ['none', 'sm', 'md', 'lg', 'pill'], default: 'none' } as const;
const shadow = { name: 'shadow', type: 'enum', options: ['none', 'sm', 'md'], default: 'none' } as const;
const hideOn = { name: 'hideOn', type: 'enum', options: ['never', 'mobile', 'desktop'], default: 'never' } as const;
const tone = { name: 'tone', type: 'enum', options: ['default', 'muted', 'accent', 'success', 'warning', 'danger'], default: 'default' } as const;

export const APP_BUILDER_COMPONENTS: readonly ComponentDef[] = [
  // — layout (containers) —
  { type: 'stack', label: 'Stack', category: 'layout', acceptsChildren: true,
    description: 'Vertical or horizontal stack of children.',
    props: [{ name: 'direction', type: 'enum', options: ['vertical', 'horizontal'], default: 'vertical' }, { name: 'gap', type: 'enum', options: SIZE_SCALE, default: 'md' }, padding, hideOn] },
  { type: 'grid', label: 'Grid', category: 'layout', acceptsChildren: true,
    description: 'Responsive grid of children.',
    props: [{ name: 'columns', type: 'number', default: 2 }, { name: 'columnsMobile', type: 'number', label: 'Columns (mobile)', default: 1 }, { name: 'gap', type: 'enum', options: SIZE_SCALE, default: 'md' }, hideOn] },
  { type: 'card', label: 'Card', category: 'layout', acceptsChildren: true,
    description: 'Bordered surface grouping content.',
    props: [{ name: 'title', type: 'string' }, { name: 'navigateTo', type: 'screen', label: 'Opens screen' }, padding, radius, shadow, hideOn] },
  { type: 'accordion', label: 'Accordion', category: 'layout', acceptsChildren: true,
    description: 'Collapsible section with a summary title.',
    props: [{ name: 'title', type: 'string', required: true }, { name: 'open', type: 'boolean', default: true }] },
  { type: 'tabs', label: 'Tabs', category: 'layout', acceptsChildren: true,
    description: 'Tabbed container — each child is one tab panel.',
    props: [{ name: 'labels', type: 'string', label: 'Tab labels (comma-separated)' }] },
  { type: 'dialog', label: 'Dialog', category: 'layout', acceptsChildren: true,
    description: 'Modal dialog (rendered as a framed representation at design time).',
    props: [{ name: 'title', type: 'string', required: true }] },
  { type: 'drawer', label: 'Drawer', category: 'layout', acceptsChildren: true,
    description: 'Side panel (rendered as a framed representation at design time).',
    props: [{ name: 'title', type: 'string' }, { name: 'side', type: 'enum', options: ['left', 'right'], default: 'left' }] },
  { type: 'spacer', label: 'Spacer', category: 'layout',
    description: 'Empty vertical space.',
    props: [{ name: 'size', type: 'enum', options: SIZE_SCALE, default: 'md' }] },
  // — display —
  { type: 'heading', label: 'Heading', category: 'display',
    props: [{ name: 'text', type: 'string', required: true }, { name: 'level', type: 'enum', options: ['1', '2', '3'], default: '2' }, { name: 'color', type: 'color' }] },
  { type: 'text', label: 'Text', category: 'display',
    props: [{ name: 'text', type: 'longtext', required: true }, { name: 'fontSize', type: 'enum', options: ['sm', 'md', 'lg'], default: 'md' }, { name: 'color', type: 'color' }, tone] },
  { type: 'badge', label: 'Badge', category: 'display',
    props: [{ name: 'text', type: 'string', required: true }, { name: 'variant', type: 'enum', options: ['neutral', 'accent', 'success', 'warning', 'danger'], default: 'neutral' }] },
  { type: 'chip', label: 'Chip', category: 'display',
    props: [{ name: 'text', type: 'string', required: true }, tone] },
  { type: 'divider', label: 'Divider', category: 'display', props: [] },
  { type: 'alert', label: 'Alert', category: 'display',
    description: 'Inline callout with a severity tone.',
    props: [{ name: 'text', type: 'string', required: true }, { name: 'variant', type: 'enum', options: ['info', 'success', 'warning', 'danger'], default: 'info' }] },
  { type: 'avatar', label: 'Avatar', category: 'display',
    props: [{ name: 'name', type: 'string', required: true }, { name: 'src', type: 'mediaRef', label: 'Image' }, { name: 'size', type: 'enum', options: ['sm', 'md', 'lg'], default: 'md' }] },
  { type: 'icon', label: 'Icon', category: 'display',
    props: [{ name: 'name', type: 'enum', options: ICON_NAMES, required: true, default: 'star' }, { name: 'size', type: 'enum', options: ['sm', 'md', 'lg'], default: 'md' }, { name: 'color', type: 'color' }] },
  { type: 'progress', label: 'Progress', category: 'display',
    props: [{ name: 'value', type: 'number', label: 'Percent (0–100)', default: 50 }, { name: 'label', type: 'string' }] },
  { type: 'rating', label: 'Rating', category: 'display',
    props: [{ name: 'value', type: 'number', label: 'Stars (0–5)', default: 4 }, { name: 'max', type: 'number', default: 5 }] },
  { type: 'calendar', label: 'Calendar', category: 'display',
    description: 'Static month view (display-only).',
    props: [{ name: 'month', type: 'string', label: 'Month label' }] },
  { type: 'snackbar', label: 'Snackbar', category: 'display',
    description: 'Transient toast message (rendered inline at design time).',
    props: [{ name: 'text', type: 'string', required: true }, { name: 'variant', type: 'enum', options: ['info', 'success', 'warning', 'danger'], default: 'info' }] },
  { type: 'stepper', label: 'Stepper', category: 'display',
    description: 'Progress steps, e.g. checkout stages.',
    props: [{ name: 'steps', type: 'string', label: 'Step labels (comma-separated)', required: true }, { name: 'active', type: 'number', label: 'Active step (1-based)', default: 1 }] },
  // — media —
  // ADR 0342 Phase 0 (DS-06): `src` is a mediaRef — the editor gets the shared
  // media picker (the avatar precedent) instead of a raw string field. The VALUE
  // stays a plain string URL (host serve URL or external), so the validator,
  // renderer scheme-allowlist, and every generator are unchanged; existing docs
  // with external URLs remain valid, and the widget keeps a manual-URL entry.
  { type: 'image', label: 'Image', category: 'media',
    props: [{ name: 'src', type: 'mediaRef', label: 'Image', required: true }, { name: 'alt', type: 'string' }, radius] },
  { type: 'video', label: 'Video', category: 'media',
    description: 'Embedded video (placeholder at design time; exports emit a real <video> where the target supports it).',
    props: [{ name: 'src', type: 'string', label: 'Video URL (mp4/webm)' }, { name: 'caption', type: 'string' }, hideOn] },
  { type: 'carousel', label: 'Carousel', category: 'media', acceptsChildren: true,
    description: 'Horizontally swipeable children (design-time: a horizontal strip).',
    props: [] },
  // — input —
  { type: 'button', label: 'Button', category: 'input',
    props: [{ name: 'label', type: 'string', required: true }, { name: 'variant', type: 'enum', options: ['primary', 'secondary', 'ghost'], default: 'primary' }, { name: 'navigateTo', type: 'screen', label: 'Opens screen' }, radius] },
  { type: 'fab', label: 'Floating action button', category: 'input',
    props: [{ name: 'icon', type: 'enum', options: ICON_NAMES, default: 'plus' }, { name: 'label', type: 'string' }, { name: 'navigateTo', type: 'screen', label: 'Opens screen' }] },
  { type: 'textInput', label: 'Text input', category: 'input',
    props: [{ name: 'label', type: 'string' }, { name: 'placeholder', type: 'string' }, { name: 'kind', type: 'enum', options: ['text', 'email', 'password', 'number'], default: 'text' }] },
  { type: 'textarea', label: 'Text area', category: 'input',
    props: [{ name: 'label', type: 'string' }, { name: 'placeholder', type: 'string' }, { name: 'rows', type: 'number', label: 'Rows (2–12)', default: 3 }] },
  { type: 'dateInput', label: 'Date/time input', category: 'input',
    props: [{ name: 'label', type: 'string' }, { name: 'kind', type: 'enum', options: ['date', 'time', 'datetime'], default: 'date' }] },
  { type: 'fileUpload', label: 'File upload', category: 'input',
    description: 'A file-picker affordance (placeholder — real upload wiring arrives with a backend operation).',
    props: [{ name: 'label', type: 'string' }, { name: 'hint', type: 'string', label: 'Hint (e.g. PNG up to 5 MB)' }, { name: 'accept', type: 'enum', options: ['any', 'image', 'document'], default: 'any' }] },
  { type: 'search', label: 'Search', category: 'input',
    description: 'A search field (role=search in exports) — filtering is design intent until an operation backs it.',
    props: [{ name: 'placeholder', type: 'string', default: 'Search…' }, hideOn] },
  { type: 'checkbox', label: 'Checkbox', category: 'input',
    props: [{ name: 'label', type: 'string', required: true }, { name: 'checked', type: 'boolean', default: false }] },
  { type: 'toggle', label: 'Toggle', category: 'input',
    props: [{ name: 'label', type: 'string', required: true }, { name: 'on', type: 'boolean', default: false }] },
  { type: 'select', label: 'Select', category: 'input',
    props: [{ name: 'label', type: 'string' }, { name: 'placeholder', type: 'string' }, { name: 'options', type: 'string', label: 'Options (comma-separated)' }] },
  { type: 'radioGroup', label: 'Radio group', category: 'input',
    props: [{ name: 'label', type: 'string' }, { name: 'options', type: 'string', label: 'Options (comma-separated)', required: true }, { name: 'selected', type: 'number', label: 'Selected (1-based)', default: 1 }] },
  { type: 'slider', label: 'Slider', category: 'input',
    props: [{ name: 'label', type: 'string' }, { name: 'value', type: 'number', default: 50 }, { name: 'min', type: 'number', default: 0 }, { name: 'max', type: 'number', default: 100 }] },
  // ADR 0347 5b — the first CONSTRAINED container (ADR 0344 2c): a form may
  // adopt only form controls + light copy, never arbitrary layout/media.
  { type: 'form', label: 'Form group', category: 'input', acceptsChildren: true,
    allowedChildTypes: ['textInput', 'textarea', 'dateInput', 'fileUpload', 'search', 'checkbox', 'toggle', 'select', 'radioGroup', 'slider', 'button', 'text', 'heading', 'divider', 'alert'],
    minChildren: 1,
    description: 'Groups input controls into one semantic form. Add a button child as its submit; exports render a real <form>/fieldset.',
    props: [{ name: 'title', type: 'string' }, padding, hideOn] },
  // — navigation —
  // ADR 0347 5b — a CONSTRAINED container (the form-group precedent): nav
  // semantics stay owned by link/button `navigateTo`, never a parallel
  // "items with routes" string grammar.
  { type: 'navBar', label: 'Nav bar', category: 'navigation', acceptsChildren: true,
    allowedChildTypes: ['link', 'button'],
    minChildren: 1, maxChildren: 8,
    description: 'Horizontal navigation bar — its children are links/buttons that navigate between screens.',
    props: [{ name: 'brand', type: 'string', label: 'Brand text' }, hideOn] },
  { type: 'sideNav', label: 'Side nav', category: 'navigation', acceptsChildren: true,
    allowedChildTypes: ['link', 'button', 'divider'],
    minChildren: 1, maxChildren: 12,
    description: 'Vertical navigation column — links/buttons (dividers allowed) that navigate between screens.',
    props: [{ name: 'title', type: 'string' }, hideOn] },
  { type: 'link', label: 'Link', category: 'navigation',
    props: [{ name: 'label', type: 'string', required: true }, { name: 'to', type: 'string', label: 'External URL' }, { name: 'navigateTo', type: 'screen', label: 'Opens screen' }] },
  { type: 'breadcrumb', label: 'Breadcrumb', category: 'navigation',
    props: [{ name: 'items', type: 'string', label: 'Trail (comma-separated)', required: true }] },
  { type: 'pagination', label: 'Pagination', category: 'navigation',
    props: [{ name: 'pages', type: 'number', default: 5 }, { name: 'active', type: 'number', label: 'Active page (1-based)', default: 1 }] },
  // — data —
  { type: 'list', label: 'List', category: 'data', acceptsChildren: true,
    description: 'Repeats its children as list rows. Bind a data source to repeat per sample row with {{field}} interpolation.',
    props: [{ name: 'bind', type: 'dataSource', label: 'Data source' }] },
  // Audit gap #5 cherry-picks (catalog 35 → 37): a KPI stat card + a static
  // data table — the highest-value breadth items from the parity audit (B.2).
  { type: 'statCard', label: 'Stat card', category: 'display',
    description: 'A KPI tile: label, headline value, and an optional delta with a tone.',
    props: [
      { name: 'label', type: 'string', required: true },
      { name: 'value', type: 'string', required: true },
      { name: 'delta', type: 'string', label: 'Delta (e.g. +12%)' },
      { name: 'tone', type: 'enum', options: ['default', 'success', 'warning', 'danger'], default: 'default' },
      hideOn,
    ] },
  { type: 'table', label: 'Table', category: 'data',
    description: 'A static data table: comma-separated columns, one row per line.',
    props: [
      { name: 'columns', type: 'string', required: true, label: 'Columns (comma-separated)' },
      { name: 'rows', type: 'longtext', label: 'Rows (one per line, cells comma-separated)' },
      hideOn,
    ] },
];

let registered = false;

/* ── ADR 0358 — the catalog as MACHINE-READABLE data for the model ─────────
 * Two projections, both pure functions of APP_BUILDER_COMPONENTS in array
 * order (registration-time chain-prompt substitution must be deterministic —
 * the templatesAndChain "registration is deterministic" test pins it). These
 * are the ONLY sanctioned ways catalog knowledge reaches an LLM; hand-copied
 * type lists in prompts are the drift class this ADR retires. */

/** The catalog serialized for a schema-requesting consumer (the
 *  `openwop:app-builder.catalog` agent tool + `ctx.features['app-builder']
 *  .getCatalog`). ComponentDef is already plain data — this is a JSON-safe
 *  deep copy so no consumer can mutate the registry's defs. */
export function projectComponentCatalog(): { canvasTypeId: string; components: ComponentDef[] } {
  return JSON.parse(JSON.stringify({ canvasTypeId: APP_BUILDER_CANVAS_TYPE, components: APP_BUILDER_COMPONENTS })) as {
    canvasTypeId: string; components: ComponentDef[];
  };
}

/** The one-line closed-world type list for LLM prompts, derived live. A
 *  constrained container (`allowedChildTypes`) carries its child rule inline
 *  so the model doesn't emit trees that pass render and 422 at editor save. */
export function catalogTypeListForPrompt(): string {
  return APP_BUILDER_COMPONENTS
    .map((c) => (c.allowedChildTypes?.length ? `${c.type} (children: ${c.allowedChildTypes.join('/')} only)` : c.type))
    .join(', ');
}

/** Register the app-builder component catalog. Idempotent; called at boot. */
export function registerAppBuilderComponents(): void {
  if (registered) return;
  registerCanvasComponents(APP_BUILDER_CANVAS_TYPE, APP_BUILDER_COMPONENTS);
  registered = true;
}
