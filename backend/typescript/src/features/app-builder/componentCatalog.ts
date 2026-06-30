/**
 * App-builder component catalog (ADR 0153 Phase 2). The closed set of components the
 * App Architect agent may emit and the editor palette offers — contributed into the
 * shared `host/canvasComponentCatalog` registry at boot. This is the single source
 * that drives the agent prompt, the palette, and closed-world validation.
 */
import { registerCanvasComponents, type ComponentDef } from '../../host/canvasComponentCatalog.js';

export const APP_BUILDER_CANVAS_TYPE = 'canvas.app-builder';

const COMPONENTS: readonly ComponentDef[] = [
  // — layout (containers) —
  { type: 'stack', label: 'Stack', category: 'layout', acceptsChildren: true,
    description: 'Vertical or horizontal stack of children.',
    props: [{ name: 'direction', type: 'enum', options: ['vertical', 'horizontal'], default: 'vertical' }, { name: 'gap', type: 'enum', options: ['none', 'sm', 'md', 'lg'], default: 'md' }] },
  { type: 'grid', label: 'Grid', category: 'layout', acceptsChildren: true,
    description: 'Responsive grid of children.',
    props: [{ name: 'columns', type: 'number', default: 2 }] },
  { type: 'card', label: 'Card', category: 'layout', acceptsChildren: true,
    description: 'Bordered surface grouping content.',
    props: [{ name: 'title', type: 'string' }] },
  // — display —
  { type: 'heading', label: 'Heading', category: 'display',
    props: [{ name: 'text', type: 'string', required: true }, { name: 'level', type: 'enum', options: ['1', '2', '3'], default: '2' }] },
  { type: 'text', label: 'Text', category: 'display',
    props: [{ name: 'text', type: 'longtext', required: true }] },
  { type: 'image', label: 'Image', category: 'media',
    props: [{ name: 'src', type: 'string', required: true }, { name: 'alt', type: 'string' }] },
  { type: 'badge', label: 'Badge', category: 'display',
    props: [{ name: 'text', type: 'string', required: true }, { name: 'variant', type: 'enum', options: ['neutral', 'accent', 'success', 'warning', 'danger'], default: 'neutral' }] },
  { type: 'divider', label: 'Divider', category: 'display', props: [] },
  // — input —
  { type: 'button', label: 'Button', category: 'input',
    props: [{ name: 'label', type: 'string', required: true }, { name: 'variant', type: 'enum', options: ['primary', 'secondary', 'ghost'], default: 'primary' }] },
  { type: 'textInput', label: 'Text input', category: 'input',
    props: [{ name: 'label', type: 'string' }, { name: 'placeholder', type: 'string' }] },
  { type: 'checkbox', label: 'Checkbox', category: 'input',
    props: [{ name: 'label', type: 'string', required: true }] },
  { type: 'select', label: 'Select', category: 'input',
    props: [{ name: 'label', type: 'string' }, { name: 'placeholder', type: 'string' }] },
  // — navigation —
  { type: 'link', label: 'Link', category: 'navigation',
    props: [{ name: 'label', type: 'string', required: true }, { name: 'to', type: 'string' }] },
  // — data —
  { type: 'list', label: 'List', category: 'data', acceptsChildren: true,
    description: 'Repeats its children as list rows.', props: [] },
];

let registered = false;

/** Register the app-builder component catalog. Idempotent; called at boot. */
export function registerAppBuilderComponents(): void {
  if (registered) return;
  registerCanvasComponents(APP_BUILDER_CANVAS_TYPE, COMPONENTS);
  registered = true;
}
