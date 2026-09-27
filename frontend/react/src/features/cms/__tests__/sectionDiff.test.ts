/**
 * CMSGAP-3 — unit coverage for the version-history diff engine (ADR 0206 B1).
 * Pure function; pins pairing-by-sectionId, base-field + per-locale overlay
 * comparison, and the added/removed/moved/changed classification.
 */
import { describe, expect, it } from 'vitest';
import { diffSections } from '../sectionDiff.js';
import type { Section } from '../cmsClient.js';

const hero = (id: string, heading: string, extra: Partial<Section> = {}): Section =>
  ({ sectionId: id, type: 'hero', data: { heading }, ...extra });

describe('diffSections', () => {
  it('returns [] for identical trees (order + content)', () => {
    const a = [hero('sec:1', 'Hi'), hero('sec:2', 'There')];
    expect(diffSections(a, a.map((s) => ({ ...s })))).toEqual([]);
  });

  it('classifies added and removed sections', () => {
    const out = diffSections([hero('sec:1', 'Hi')], [hero('sec:2', 'New')]);
    expect(out).toEqual([
      { sectionId: 'sec:1', type: 'hero', kind: 'removed', fields: [] },
      { sectionId: 'sec:2', type: 'hero', kind: 'added', fields: [] },
    ]);
  });

  it('reports base-field changes with from/to values', () => {
    const out = diffSections([hero('sec:1', 'Old')], [hero('sec:1', 'New')]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'changed' });
    expect(out[0]!.fields).toEqual([{ key: 'heading', from: 'Old', to: 'New' }]);
  });

  it('reports per-locale overlay changes as `locale · field` (added, changed, removed)', () => {
    const from = [hero('sec:1', 'Hi', { localizations: { 'pt-BR': { heading: 'Oi' }, es: { heading: 'Hola' } } })];
    const to = [hero('sec:1', 'Hi', { localizations: { 'pt-BR': { heading: 'Olá' }, fr: { heading: 'Salut' } } })];
    const fields = diffSections(from, to)[0]!.fields;
    expect(fields).toEqual([
      { key: 'es · heading', from: 'Hola', to: '' },      // overlay removed
      { key: 'fr · heading', from: '', to: 'Salut' },     // overlay added
      { key: 'pt-BR · heading', from: 'Oi', to: 'Olá' },  // overlay changed
    ]);
  });

  it('classifies a same-content reorder as `moved` (not changed)', () => {
    const a = [hero('sec:1', 'One'), hero('sec:2', 'Two')];
    const b = [hero('sec:2', 'Two'), hero('sec:1', 'One')];
    const out = diffSections(a, b);
    expect(out.map((e) => e.kind)).toEqual(['moved', 'moved']);
    expect(out.every((e) => e.fields.length === 0)).toBe(true);
  });

  it('stringifies non-string values so structured fields diff stably', () => {
    const from: Section[] = [{ sectionId: 'sec:1', type: 'columns', data: { columns: [{ title: 'A', text: 'x' }] } }];
    const to: Section[] = [{ sectionId: 'sec:1', type: 'columns', data: { columns: [{ title: 'B', text: 'x' }] } }];
    const fields = diffSections(from, to)[0]!.fields;
    expect(fields).toHaveLength(1);
    expect(fields[0]!.key).toBe('columns');
    expect(fields[0]!.from).toContain('"A"');
    expect(fields[0]!.to).toContain('"B"');
  });
});
