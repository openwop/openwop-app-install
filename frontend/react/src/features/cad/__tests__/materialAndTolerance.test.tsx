/**
 * UX_UPGRADE-cad CAD-G1..G4 — the property panel's closed vocabularies.
 *
 * CAD-G1: the 12 catalog material ids are kebab WIRE TOKENS ('plastic-red',
 * 'wood-oak'). A plain `enum` renders option labels raw, so the picker read as
 * English tokens in all four locales — the same leak the slides definition fixed
 * in its own grade pass.
 *
 * CAD-G2: `validateCadDoc` REQUIRES an axis on a linear/ordinate dimension, but
 * the panel drew it as a clearable enum, so the panel invited an edit the server
 * refuses.
 *
 * CAD-G4: the tolerance fields are dependent — tolA only once a tolType is set,
 * tolB only for asymmetric/limit. They were shown unconditionally, and (the part
 * that makes hiding them safe) the STORED values have to go with them, or a save
 * fails on a field that is no longer on screen.
 */
import { describe, it, expect } from 'vitest';
import { cadDefinition } from '../definition.js';
import { CAD_MATERIALS } from '../cadMaterials.js';
import { messages as en } from '../i18n/en.js';
import { messages as es } from '../i18n/es.js';
import { messages as fr } from '../i18n/fr.js';
import { messages as ptBR } from '../i18n/pt-BR.js';

const solids = cadDefinition.elements!.find((c) => c.key === 'solids')!;
const dims = cadDefinition.elements!.find((c) => c.key === 'dimensions')!;
const propNames = (defs: { name: string }[]): string[] => defs.map((d) => d.name);

describe('CAD-G1 — closed vocabularies have labels, in every locale', () => {
  const locales: [string, Record<string, string>][] = ([['en', en], ['es', es], ['fr', fr], ['pt-BR', ptBR]] as [string, unknown][]).map(([n, m]) => [n, m as Record<string, string>]);

  it('every catalog material id has a label in all four locales', () => {
    for (const [name, table] of locales) {
      for (const m of CAD_MATERIALS) {
        const key = `opt_materialId_${m.id}`;
        expect(table[key], `${name} is missing ${key}`).toBeTruthy();
        // A label equal to the id would pass a "key exists" check while still
        // showing the wire token — that is the bug, not the fix.
        expect(table[key], `${name}:${key} still shows the wire token`).not.toBe(m.id);
      }
    }
  });

  it('every tolerance type has a label in all four locales', () => {
    const tolDef = dims.propDefs({ kind: 'linear', axis: 'x' }).find((d) => d.name === 'tolType')!;
    for (const [name, table] of locales) {
      for (const o of tolDef.options ?? []) {
        expect(table[`opt_tolType_${o}`], `${name} is missing opt_tolType_${o}`).toBeTruthy();
      }
    }
  });

  it('the material prop uses the cad widget, and the widget is registered', () => {
    const def = solids.propDefs({ kind: 'box' }).find((d) => d.name === 'materialId')!;
    expect(def.type).toBe('cad-material');
    expect(cadDefinition.propertyWidgets?.[def.type]).toBeTruthy();
  });
});

describe('CAD-G2 — a required axis is not clearable', () => {
  it('linear and ordinate dimensions get a REQUIRED axis enum', () => {
    for (const kind of ['linear', 'ordinate']) {
      const axis = dims.propDefs({ kind, axis: 'x' }).find((d) => d.name === 'axis');
      expect(axis, `${kind} should offer an axis`).toBeTruthy();
      // The plain 'enum' branch renders an empty option; the validator rejects
      // a linear/ordinate dimension without an axis.
      expect(axis!.type).toBe('enum-required');
    }
  });

  it('kinds that must NOT carry an axis still do not offer one', () => {
    // The validator also rejects an axis on these ("axis is only valid on
    // linear/ordinate"), so the field must stay absent.
    for (const kind of ['diameter', 'radial', 'angular']) {
      expect(propNames(dims.propDefs({ kind }))).not.toContain('axis');
    }
  });
});

describe('CAD-G4 — the tolerance fields follow the tolerance type', () => {
  const locales: [string, Record<string, string>][] = ([['en', en], ['es', es], ['fr', fr], ['pt-BR', ptBR]] as [string, unknown][]).map(([n, m]) => [n, m as Record<string, string>]);

  it('shows neither tol field until a type is chosen', () => {
    const names = propNames(dims.propDefs({ kind: 'linear', axis: 'x' }));
    expect(names).not.toContain('tolA');
    expect(names).not.toContain('tolB');
  });

  it('a symmetric tolerance keeps the ± wording (no labelKey override)', () => {
    const defs = dims.propDefs({ kind: 'linear', axis: 'x', tolType: 'symmetric' });
    expect(defs.find((d) => d.name === 'tolA')!.labelKey).toBeUndefined();
  });

  it('symmetric takes tolA only', () => {
    const names = propNames(dims.propDefs({ kind: 'linear', axis: 'x', tolType: 'symmetric' }));
    expect(names).toContain('tolA');
    expect(names).not.toContain('tolB');
  });

  it('asymmetric and limit take both', () => {
    for (const tolType of ['asymmetric', 'limit']) {
      const names = propNames(dims.propDefs({ kind: 'linear', axis: 'x', tolType }));
      expect(names).toContain('tolA');
      expect(names).toContain('tolB');
    }
  });

  it('limit relabels the pair as upper/lower — they are limits, not offsets', () => {
    // Via labelKey, NOT the code label: `prop_tolA` exists in the catalog and
    // would silently win over any label passed here (the SL-G7 case).
    const defs = dims.propDefs({ kind: 'linear', axis: 'x', tolType: 'limit' });
    expect(defs.find((d) => d.name === 'tolA')!.labelKey).toBe('prop_tolUpper');
    expect(defs.find((d) => d.name === 'tolB')!.labelKey).toBe('prop_tolLower');
    expect(en.prop_tolUpper).toBe('Upper limit');
    expect(en.prop_tolLower).toBe('Lower limit');
    // Every locale carries them, or a pt-BR user sees the ± wording on limits.
    for (const [name, table] of locales) {
      expect(table.prop_tolUpper, `${name} prop_tolUpper`).toBeTruthy();
      expect(table.prop_tolLower, `${name} prop_tolLower`).toBeTruthy();
    }
  });
});

describe('CAD-G4 — hiding a field also drops its stored value', () => {
  const transform = dims.transformOnPropChange!;

  it('clearing the type drops both tol values', () => {
    // Left behind, they would fail the save with "tolA/tolB require a tolType"
    // — pointing at a field the panel no longer shows.
    const out = transform({ kind: 'linear', axis: 'x', tolType: 'limit', tolA: 0.2, tolB: 0.1 }, 'tolType', '');
    expect(out).toEqual({ kind: 'linear', axis: 'x' });
  });

  it('switching to symmetric drops the now-invalid tolB', () => {
    const out = transform({ kind: 'linear', axis: 'x', tolType: 'asymmetric', tolA: 0.2, tolB: 0.1 }, 'tolType', 'symmetric');
    expect(out).toEqual({ kind: 'linear', axis: 'x', tolType: 'symmetric', tolA: 0.2 });
  });

  it('switching to asymmetric keeps both', () => {
    const out = transform({ kind: 'linear', axis: 'x', tolType: 'symmetric', tolA: 0.2 }, 'tolType', 'asymmetric');
    expect(out).toMatchObject({ tolType: 'asymmetric', tolA: 0.2 });
  });

  it('leaves every OTHER prop change to the default single-field set', () => {
    // Returning an element here would make every edit a whole-element replace.
    expect(transform({ kind: 'linear', axis: 'x' }, 'solid', 2)).toBeUndefined();
    expect(transform({ kind: 'linear', axis: 'x' }, 'label', 'width')).toBeUndefined();
  });

  it('does not mutate the element it was given', () => {
    const el = { kind: 'linear', axis: 'x', tolType: 'limit', tolA: 0.2, tolB: 0.1 };
    transform(el, 'tolType', '');
    expect(el.tolType).toBe('limit');
  });
});
