/**
 * UX_UPGRADE-drawings DRAW-G1 — every field the property panel renders has a
 * label key, in every locale.
 *
 * `PropertyForm` resolves `prop_<name>` with the CODE label as its fallback, so
 * a missing key is invisible in English and shows English to everyone else. 23 of
 * the 30 fields had no key: the panel read "Corner radius", "Stroke width",
 * "Font size" in es/fr/pt-BR.
 *
 * Two names carry two meanings and therefore need `labelKey` (the SL-G7 seam,
 * #2537): `width`/`height` are element fields AND doc fields ("Canvas width"),
 * and `rx` is a rect's CORNER radius but an ellipse's radius-X.
 */
import { describe, it, expect } from 'vitest';
import { drawingsDefinition } from '../definition.js';
import type { CanvasPropDef } from '../../../canvas/types.js';
import { messages as en } from '../i18n/en.js';
import { messages as es } from '../i18n/es.js';
import { messages as fr } from '../i18n/fr.js';
import { messages as ptBR } from '../i18n/pt-BR.js';

const LOCALES: [string, Record<string, string>][] = ([['en', en], ['es', es], ['fr', fr], ['pt-BR', ptBR]] as [string, unknown][])
  .map(([n, m]) => [n, m as Record<string, string>]);

const KINDS = ['rect', 'circle', 'ellipse', 'line', 'arrow', 'polyline', 'polygon', 'text', 'image', 'stroke'];
const col = drawingsDefinition.elements![0]!;

/** Every def the panel can render: per-kind element fields + the doc fields. */
const allDefs = (): { def: CanvasPropDef; where: string }[] => [
  ...KINDS.flatMap((kind) => col.propDefs({ kind }).map((def) => ({ def, where: kind }))),
  ...(drawingsDefinition.docPropDefs ?? []).map((def) => ({ def, where: 'doc' })),
];

/** What PropertyForm will actually look up for this def. */
const keyOf = (def: CanvasPropDef): string => def.labelKey ?? `prop_${def.name}`;

describe('DRAW-G1 — property-label coverage', () => {
  it('every rendered field resolves a key in all four locales', () => {
    const missing: string[] = [];
    for (const { def, where } of allDefs()) {
      const key = keyOf(def);
      for (const [locale, table] of LOCALES) {
        if (!table[key]) missing.push(`${locale}: ${key} (${where}.${def.name})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('the check is not vacuous — it really walked the panel', () => {
    const defs = allDefs();
    expect(defs.length).toBeGreaterThan(30);
    expect(new Set(defs.map((d) => d.def.name)).size).toBeGreaterThan(20);
  });

  it('a label that merely repeats the field name is not a label', () => {
    // 'X'/'Y'/'X1' are mathematical notation and identical everywhere; the
    // WORDS are what had to be translated. Check the wordy ones actually differ
    // from English in a non-English locale.
    const wordy = ['prop_cornerRadius', 'prop_fontSize', 'prop_strokeWidth', 'prop_canvasWidth', 'prop_fill'];
    for (const key of wordy) {
      expect(ptBR[key], `pt-BR ${key}`).toBeTruthy();
      expect(ptBR[key], `pt-BR ${key} is still the English string`).not.toBe(en[key]);
    }
  });
});

describe('DRAW-G1 — the two names that carry two meanings', () => {
  it('the doc dims do not share the element fields’ key', () => {
    const doc = drawingsDefinition.docPropDefs!;
    expect(doc.find((d) => d.name === 'width')!.labelKey).toBe('prop_canvasWidth');
    expect(doc.find((d) => d.name === 'height')!.labelKey).toBe('prop_canvasHeight');
    // The element fields keep the derived key — that is what makes the override
    // necessary rather than a rename.
    const rect = col.propDefs({ kind: 'rect' });
    expect(rect.find((d) => d.name === 'width')!.labelKey).toBeUndefined();
    expect(en.prop_width).toBe('Width');
    expect(en.prop_canvasWidth).toBe('Canvas width');
  });

  it('a rect’s rx is a CORNER radius; an ellipse’s rx is radius-X', () => {
    const rect = col.propDefs({ kind: 'rect' }).find((d) => d.name === 'rx')!;
    const ellipse = col.propDefs({ kind: 'ellipse' }).find((d) => d.name === 'rx')!;
    expect(rect.labelKey).toBe('prop_cornerRadius');
    expect(ellipse.labelKey).toBeUndefined();
    expect(en[keyOf(rect)]).not.toBe(en[keyOf(ellipse)]);
  });
});
