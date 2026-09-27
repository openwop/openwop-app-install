/**
 * Pack data→definition adapter tests (ADR 0310 Phase D) — untrusted hint
 * narrowing and the synthesized definition's behavior (coercion, adders,
 * labels, minItems floor).
 */
import { describe, expect, it } from 'vitest';
import { buildPackDefinition, parsePackEditorHints } from '../packDefinition.js';

const HINTS = {
  docNameKey: 'title',
  collections: [{
    key: 'items',
    label: 'Items',
    max: 200,
    min: 1,
    itemLabelField: 'text',
    adders: [{ id: 'item', label: 'Checklist item', defaults: { text: 'New item', done: false } }],
    fields: [
      { name: 'text', type: 'string', label: 'Text', required: true },
      { name: 'done', type: 'boolean', label: 'Done' },
    ],
  }],
};

describe('parsePackEditorHints', () => {
  it('accepts the witness shape and rejects malformed payloads', () => {
    expect(parsePackEditorHints(HINTS)).toMatchObject({ docNameKey: 'title' });
    expect(parsePackEditorHints(null)).toBeNull();
    expect(parsePackEditorHints({ collections: [] })).toBeNull();
    expect(parsePackEditorHints({ collections: [{ key: 'x' }] })).toBeNull();
    expect(parsePackEditorHints({ collections: 'nope' })).toBeNull();
  });
});

describe('buildPackDefinition', () => {
  const def = buildPackDefinition('canvas.checklist', parsePackEditorHints(HINTS)!);

  it('derives identity, paths, and the toggle from the type id', () => {
    expect(def.canvasTypeId).toBe('canvas.checklist');
    expect(def.toggleId).toBe('canvas-packs');
    expect(def.clientBasePath).toBe('/host/openwop-app/canvas-packs/canvas.checklist');
    expect(def.editorPath).toBe('/canvas/canvas.checklist');
    expect(def.docNameKey).toBe('title');
  });

  it('coerces the doc: name default + minItems floor from the first adder', () => {
    const doc = def.coerceDoc({});
    expect(doc.title).toBe('Untitled');
    expect(doc.items).toEqual([{ text: 'New item', done: false }]);
    const kept = def.coerceDoc({ title: 'G', items: [{ text: 'Milk' }] });
    expect(kept.items).toEqual([{ text: 'Milk' }]);
  });

  it('adders deep-clone their defaults (no shared references)', () => {
    const col = def.elements![0]!;
    const a = col.adders[0]!.make();
    const b = col.adders[0]!.make();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(col.label).toBe('Items');
    expect(col.adders[0]!.label).toBe('Checklist item');
  });

  it('labels rows from the item label field with the adder label fallback', () => {
    const col = def.elements![0]!;
    const t = (k: string): string => k;
    expect(col.labelFor({ text: 'Milk' }, t)).toBe('Milk');
    expect(col.labelFor({}, t)).toBe('Checklist item');
    expect(col.propDefs({}).map((p) => p.name)).toEqual(['text', 'done']);
  });
});
