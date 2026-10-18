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

/** A VALID untrusted payload, built fresh per case (JSON round-trip, as it
 *  arrives off the catalog route — so `__proto__` below is an OWN key). Each
 *  malformed case changes exactly ONE property of this, so the refusal it sees is
 *  the check under test and not an earlier one (round 1: the only malformed
 *  collection lacked `label`, so every later guard was unreached). */
const raw = (): Record<string, unknown> => JSON.parse(JSON.stringify(HINTS)) as Record<string, unknown>;
const col0 = (r: Record<string, unknown>): Record<string, unknown> => (r.collections as Record<string, unknown>[])[0]!;

describe('parsePackEditorHints — one check per malformed fixture', () => {
  it('positive control: the unmodified base parses', () => {
    expect(parsePackEditorHints(raw())).not.toBeNull();
  });

  it('refuses an EMPTY collections array', () => {
    const r = raw(); r.collections = [];
    expect(parsePackEditorHints(r)).toBeNull();
  });

  it('refuses a collection whose max is below 1', () => {
    // `min` is dropped so GC-CV-6 (min > max) cannot be the check that refuses:
    // with the base `min: 1`, `max: 0` was refused by min > max and this check
    // was unreached (re-probe w46g2-pd-maxlt1-r2 vacuous).
    const r = raw(); delete col0(r).min; col0(r).max = 0;
    expect(parsePackEditorHints(r)).toBeNull();
    const ok = raw(); delete col0(ok).min; col0(ok).max = 1; // boundary: max 1 is legal
    expect(parsePackEditorHints(ok)?.collections[0]?.max).toBe(1);
  });

  it('GC-CV-6 — refuses min > max', () => {
    const r = raw(); col0(r).min = 201;
    expect(parsePackEditorHints(r)).toBeNull();
    const ok = raw(); col0(ok).min = 200; // boundary: min === max is legal
    expect(parsePackEditorHints(ok)?.collections[0]?.min).toBe(200);
  });

  it('refuses a collection with no adders', () => {
    const r = raw(); col0(r).adders = [];
    expect(parsePackEditorHints(r)).toBeNull();
  });

  it('GC-CV-5 — refuses a prototype-chain collection key', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const r = raw(); col0(r).key = key;
      expect(parsePackEditorHints(r), key).toBeNull();
    }
  });

  it('GC-CV-5 — screens prototype-chain keys out of adder defaults', () => {
    const r = raw();
    ((col0(r).adders as Record<string, unknown>[])[0]!).defaults = JSON.parse('{"text":"a","__proto__":{"polluted":1},"constructor":1}') as unknown;
    const hints = parsePackEditorHints(r)!;
    const defaults = hints.collections[0]!.adders[0]!.defaults;
    expect(Object.keys(defaults)).toEqual(['text']);
    const made = buildPackDefinition('canvas.checklist', hints).elements![0]!.adders[0]!.make();
    expect(Object.prototype.hasOwnProperty.call(made, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('GC-CV-5 — drops fields with a prototype-chain, empty, or untyped name', () => {
    const r = raw();
    col0(r).fields = [
      { name: 'text', type: 'string', label: 'Text' },
      { name: 'constructor', type: 'string' },
      { name: '', type: 'string' },
      { name: 'noType' },
    ];
    expect(parsePackEditorHints(r)!.collections[0]!.fields.map((f) => f.name)).toEqual(['text']);
  });

  it('GC-CV-5 — drops a prototype-chain docNameKey (the doc name falls back to `name`)', () => {
    const r = raw(); r.docNameKey = '__proto__';
    const hints = parsePackEditorHints(r)!;
    expect('docNameKey' in hints).toBe(false);
    expect(buildPackDefinition('canvas.checklist', hints).docNameKey).toBe('name');
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
    // Non-object entries are dropped (the editor only ever sees element objects).
    const filtered = def.coerceDoc({ title: 'G', items: [null, 'x', [1], { text: 'ok' }] });
    expect(filtered.items).toEqual([{ text: 'ok' }]);
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
    // Long labels truncate to 32 chars + an ellipsis.
    expect(col.labelFor({ text: 'abcdefghijklmnopqrstuvwxyz0123456789XYZ' }, t)).toBe('abcdefghijklmnopqrstuvwxyz012345…');
    expect(col.propDefs({}).map((p) => p.name)).toEqual(['text', 'done']);
  });
});
