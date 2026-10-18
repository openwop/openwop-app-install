/**
 * SL-G7 (docs/steward/UX_UPGRADE-slides.md) — a prop whose LABEL varies by context.
 *
 * `PropertyForm` derives its label key from the prop NAME (`prop_<name>`). Slides
 * stores one `title` field but calls it "Title" on most layouts, "Quote" on the
 * quote layout and "Section title" on a section — so a single `prop_title` key
 * could not serve all three, and `title` ended up the ONLY untranslated field in
 * a panel whose other 18 props were fully covered. The absence was structural,
 * not an oversight.
 *
 * `CanvasPropDef.labelKey` lifts that ceiling, and both label lookups
 * (`PropertyForm` and `QuickPropsCluster`) honour it — kept in step so a def
 * cannot translate in the panel and fall back to English in the quick cluster.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { PropertyField } from '../PropertyForm.js';
import type { CanvasPropDef } from '../types.js';
import { slidesDefinition, SLIDE_LAYOUTS, type EditorSlide } from '../../features/slides/definition.js';
import { messages as slidesEn } from '../../features/slides/i18n/en.js';

const CATALOG: Record<string, string> = {
  prop_title: 'Titre',
  prop_quoteTitle: 'Citation',
  prop_sectionTitle: 'Titre de section',
};
const tt = (key: string, opts: { defaultValue: string }): string => CATALOG[key] ?? opts.defaultValue;

const view = (def: CanvasPropDef, withTt = true) => render(
  <PropertyField
    def={def}
    value=""
    frames={[]}
    docState={{}}
    orgId="org-1"
    onChange={() => {}}
    onChangeText={() => {}}
    {...(withTt ? { tt } : {})}
  />,
);

afterEach(cleanup);

describe('a prop label can be keyed explicitly', () => {
  it('prefers labelKey over the derived prop_<name>', () => {
    view({ name: 'title', type: 'string', label: 'Quote', labelKey: 'prop_quoteTitle' });
    expect(screen.getByText('Citation')).toBeTruthy();
    // The derived key's translation must NOT win.
    expect(screen.queryByText('Titre')).toBeNull();
  });

  it('the SAME prop name resolves differently per call site', () => {
    view({ name: 'title', type: 'string', label: 'Section title', labelKey: 'prop_sectionTitle' });
    expect(screen.getByText('Titre de section')).toBeTruthy();
    cleanup();
    view({ name: 'title', type: 'string', label: 'Title', labelKey: 'prop_title' });
    // This is the whole point: one stored field, three labels.
    expect(screen.getByText('Titre')).toBeTruthy();
  });

  it('falls back to the derived key when no labelKey is given', () => {
    view({ name: 'title', type: 'string', label: 'Title' });
    expect(screen.getByText('Titre')).toBeTruthy();
  });

  it('an unknown labelKey falls back to the English label, never a bare key', () => {
    view({ name: 'title', type: 'string', label: 'Quote', labelKey: 'prop_notInCatalog' });
    expect(screen.getByText('Quote')).toBeTruthy();
    expect(screen.queryByText('prop_notInCatalog')).toBeNull();
  });

  it('with no translator at all the English label still renders', () => {
    view({ name: 'title', type: 'string', label: 'Quote', labelKey: 'prop_quoteTitle' }, false);
    expect(screen.getByText('Quote')).toBeTruthy();
  });
});

describe('every slides title call site is keyed', () => {
  it('no layout leaves the title prop on the shared derived key', () => {
    // Layouts come from the product's own list (SLIDE_LAYOUTS), not a copy, so a
    // new layout is checked the day it ships.
    const catalog: Readonly<Record<string, string>> = slidesEn;
    const seen = new Set<string>();
    for (const layout of SLIDE_LAYOUTS) {
      const slide: EditorSlide = { id: `s-${layout}`, name: layout, layout };
      for (const def of slidesDefinition.frames?.propDefs?.(slide) ?? []) {
        if (def.name !== 'title') continue;
        // A `title` def without a labelKey is the bug this closes.
        expect(def.labelKey, `layout ${layout} has an unkeyed title`).toBeTruthy();
        // …and the key must resolve in the slides catalog, or the label silently
        // falls back to English — the exact failure SL-G7 closed.
        expect(typeof catalog[def.labelKey!], `layout ${layout}: ${def.labelKey} missing from slides en`).toBe('string');
        seen.add(def.labelKey!);
      }
    }
    // Three distinct labels really are in play — this is not a one-key rename.
    expect([...seen].sort()).toEqual(['prop_quoteTitle', 'prop_sectionTitle', 'prop_title']);
  });
});
