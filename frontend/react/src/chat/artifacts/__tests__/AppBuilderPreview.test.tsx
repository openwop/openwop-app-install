/**
 * ADR 0305 Phase C — renderer parity for the expanded canvas.app-builder catalog.
 * Mirrors the backend generator-parity test: every catalog type renders as a real
 * element (never the `.canvas-ab__unknown` placeholder), the closed icon map covers
 * the catalog's icon vocabulary with a safe fallback, data binding unrolls sample
 * rows in READ mode but keeps the authored tree (1:1 paths) in EDIT mode, and
 * themeColors only reach the CSS variable when they are strict 6-hex.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppBuilderContentView, AppScreenPreview, APP_BUILDER_ICON_NAMES } from '../AppBuilderPreview.js';

afterEach(cleanup);

/** The catalog's 43 types with minimal valid props — keep in step with
 *  backend componentCatalog.ts (its own parity test pins the other side). */
const ALL_TYPES: Record<string, unknown>[] = [
  { type: 'stack', props: { direction: 'vertical' }, children: [{ type: 'text', props: { text: 'in-stack' } }] },
  { type: 'grid', props: { columns: 2 }, children: [{ type: 'text', props: { text: 'in-grid' } }] },
  { type: 'card', props: { title: 'Card' }, children: [] },
  { type: 'accordion', props: { title: 'More' }, children: [] },
  { type: 'tabs', props: { labels: 'One,Two' }, children: [] },
  { type: 'dialog', props: { title: 'Confirm' }, children: [] },
  { type: 'drawer', props: { title: 'Menu' }, children: [] },
  { type: 'spacer', props: { size: 'md' } },
  { type: 'heading', props: { text: 'Head', level: '1' } },
  { type: 'text', props: { text: 'Body', tone: 'muted' } },
  { type: 'badge', props: { text: 'New' } },
  { type: 'chip', props: { text: 'Tag' } },
  { type: 'divider' },
  { type: 'alert', props: { text: 'Heads up', variant: 'warning' } },
  { type: 'avatar', props: { name: 'Ada Lovelace' } },
  { type: 'icon', props: { name: 'star' } },
  { type: 'progress', props: { value: 40 } },
  { type: 'rating', props: { value: 3 } },
  { type: 'calendar', props: { month: 'July' } },
  { type: 'snackbar', props: { text: 'Saved' } },
  { type: 'stepper', props: { steps: 'Cart,Pay,Done', active: 2 } },
  { type: 'image', props: { src: 'https://example.com/x.png', alt: 'x' } },
  { type: 'carousel', children: [{ type: 'text', props: { text: 'slide' } }] },
  { type: 'video', props: { caption: 'Product tour' } },
  { type: 'button', props: { label: 'Go', navigateTo: 'other' } },
  { type: 'fab', props: { icon: 'plus', label: 'Add' } },
  { type: 'textInput', props: { label: 'Email', kind: 'email' } },
  { type: 'textarea', props: { label: 'Notes', rows: 4 } },
  { type: 'dateInput', props: { label: 'Due', kind: 'date' } },
  { type: 'fileUpload', props: { label: 'Attachment', hint: 'PNG up to 5 MB' } },
  { type: 'search', props: { placeholder: 'Search products' } },
  { type: 'checkbox', props: { label: 'Agree', checked: true } },
  { type: 'toggle', props: { label: 'Dark', on: true } },
  { type: 'select', props: { label: 'Plan', options: 'Free,Pro' } },
  { type: 'radioGroup', props: { options: 'A,B', selected: 2 } },
  { type: 'slider', props: { value: 30 } },
  { type: 'form', props: { title: 'Sign in' }, children: [{ type: 'textInput', props: { label: 'Email' } }, { type: 'button', props: { label: 'Submit' } }] },
  { type: 'link', props: { label: 'Docs', to: 'https://example.com' } },
  { type: 'navBar', props: { brand: 'Aurora' }, children: [{ type: 'link', props: { label: 'Home', navigateTo: 'home' } }] },
  { type: 'sideNav', props: { title: 'Menu' }, children: [{ type: 'link', props: { label: 'Settings', navigateTo: 'home' } }] },
  { type: 'breadcrumb', props: { items: 'Home,Shop,Item' } },
  { type: 'pagination', props: { pages: 3, active: 2 } },
  { type: 'list', children: [{ type: 'text', props: { text: 'row' } }] },
];

const doc = (extra: Record<string, unknown> = {}, components: unknown = ALL_TYPES) => JSON.stringify({
  name: 'Parity', screens: [{ id: 'home', name: 'Home', components }, { id: 'other', name: 'Other' }], ...extra,
});

describe('AppBuilderContentView catalog parity', () => {
  it('renders all 43 catalog types with ZERO unknown placeholders', () => {
    const { container } = render(<MemoryRouter><AppBuilderContentView content={doc()} /></MemoryRouter>);
    expect(container.querySelectorAll('.canvas-ab__unknown').length).toBe(0);
    expect(container.querySelectorAll('.canvas-ab__stepper li').length).toBe(3);
    expect(container.textContent).toContain('Ada Lovelace'.split(' ').map((w) => w[0]).join(''));
  });
  it('an unknown type renders the inert placeholder', () => {
    const { container } = render(<MemoryRouter><AppBuilderContentView content={doc({}, [{ type: 'holo-deck' }])} /></MemoryRouter>);
    expect(container.querySelectorAll('.canvas-ab__unknown').length).toBe(1);
  });
  it('the icon map covers the 24-name vocabulary and falls back safely', () => {
    expect(APP_BUILDER_ICON_NAMES.length).toBe(24);
    const { container } = render(<MemoryRouter><AppBuilderContentView content={doc({}, [
      ...APP_BUILDER_ICON_NAMES.map((n) => ({ type: 'icon', props: { name: n } })),
      { type: 'icon', props: { name: 'not-a-real-icon' } },
    ])} /></MemoryRouter>);
    // Every name (and the fallback) yields an inline SVG glyph.
    expect(container.querySelectorAll('.canvas-ab__icon svg').length).toBe(25);
  });
});

describe('data binding (READ unrolls; EDIT keeps authored paths)', () => {
  const bound = {
    dataSources: [{ id: 'products', name: 'Products', fields: ['title'], rows: [{ title: 'Alpha' }, { title: 'Beta' }] }],
  };
  const comps = [{ type: 'list', props: { bind: 'products' }, children: [{ type: 'text', props: { text: '{{title}}!' } }] }];
  it('READ mode repeats children per sample row with interpolation', () => {
    const { container } = render(<MemoryRouter><AppBuilderContentView content={doc(bound, comps)} /></MemoryRouter>);
    expect(container.textContent).toContain('Alpha!');
    expect(container.textContent).toContain('Beta!');
    expect(container.querySelectorAll('.canvas-ab__list-row').length).toBe(2);
  });
  it('EDIT mode renders the authored tree once (paths stay 1:1) with a binding chip', () => {
    const { container } = render(<MemoryRouter><AppBuilderContentView content={doc(bound, comps)} editPaths /></MemoryRouter>);
    expect(container.querySelectorAll('.canvas-ab__list-row').length).toBe(0);
    expect(container.textContent).toContain('{{title}}!');
    expect(container.textContent).toContain('Products');
    expect(container.querySelectorAll('[data-cv-path]').length).toBe(2); // list + its one child
  });
});

describe('themeColors safety (amendment 3)', () => {
  it('injects the CSS var only for a strict 6-hex value', () => {
    const ok = render(<MemoryRouter><AppBuilderContentView content={doc({ themeColors: { primary: '#123abc' } }, [])} /></MemoryRouter>);
    expect((ok.container.querySelector('.canvas-ab') as HTMLElement).style.getPropertyValue('--canvas-ab-primary')).toBe('#123abc');
    cleanup();
    const bad = render(<MemoryRouter><AppBuilderContentView content={doc({ themeColors: { primary: 'url(javascript:x)' } }, [])} /></MemoryRouter>);
    expect((bad.container.querySelector('.canvas-ab') as HTMLElement).style.getPropertyValue('--canvas-ab-primary')).toBe('');
  });
});

describe('AppScreenPreview — board-node parity (ADR 0342 Phase 0)', () => {
  const screen = {
    id: 'home', name: 'Home',
    components: [{ type: 'list', props: { bind: 'products' }, children: [{ type: 'text', props: { text: '{{title}}' } }] }],
  };
  it('applies generated theme colors through the SAME appThemeVars owner', () => {
    const { container } = render(
      <MemoryRouter><AppScreenPreview screen={screen} theme="dark" themeColors={{ primary: '#123abc', secondary: '#00ff00' }} /></MemoryRouter>,
    );
    const root = container.querySelector('.canvas-ab--node') as HTMLElement;
    expect(root.style.getPropertyValue('--canvas-ab-primary')).toBe('#123abc');
    expect(root.style.getPropertyValue('--canvas-ab-secondary')).toBe('#00ff00');
    expect(root.dataset.theme).toBe('dark');
  });
  it('rejects a non-hex theme color (same safety gate as the full preview)', () => {
    const { container } = render(
      <MemoryRouter><AppScreenPreview screen={screen} themeColors={{ primary: 'url(javascript:x)' }} /></MemoryRouter>,
    );
    expect((container.querySelector('.canvas-ab--node') as HTMLElement).style.getPropertyValue('--canvas-ab-primary')).toBe('');
  });
  it('unrolls bound sample rows on the board node like the full preview', () => {
    const { container } = render(
      <MemoryRouter><AppScreenPreview screen={screen} dataSources={[{ id: 'products', name: 'Products', rows: [{ title: 'Alpha' }, { title: 'Beta' }] }]} /></MemoryRouter>,
    );
    expect(container.textContent).toContain('Alpha');
    expect(container.textContent).toContain('Beta');
    expect(container.querySelectorAll('.canvas-ab__list-row').length).toBe(2);
  });
});

describe('hidden nodes (ADR 0344 2b)', () => {
  const comps = [
    { type: 'text', props: { text: 'VISIBLE' } },
    { type: 'stack', hidden: true, children: [{ type: 'text', props: { text: 'HIDDEN' } }] },
  ];
  it('READ mode: hidden subtrees are absent', () => {
    const { container } = render(<MemoryRouter><AppBuilderContentView content={doc({}, comps)} /></MemoryRouter>);
    expect(container.textContent).toContain('VISIBLE');
    expect(container.textContent).not.toContain('HIDDEN');
  });
  it('EDIT mode: hidden nodes render dimmed with a labeled chip, still path-addressable', () => {
    const { container } = render(<MemoryRouter><AppBuilderContentView content={doc({}, comps)} editPaths /></MemoryRouter>);
    expect(container.textContent).toContain('HIDDEN');
    const wrap = container.querySelector('.canvas-ab__hidden-node');
    expect(wrap).toBeTruthy();
    expect(wrap!.querySelector('[data-cv-path]')).toBeTruthy();
  });
  it('board node (AppScreenPreview) is READ — hidden content absent', () => {
    const { container } = render(<MemoryRouter><AppScreenPreview screen={{ id: 's', name: 'S', components: comps }} /></MemoryRouter>);
    expect(container.textContent).not.toContain('HIDDEN');
  });
});
