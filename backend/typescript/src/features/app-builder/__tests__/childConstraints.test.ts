/** ADR 0344 2c — child constraints at the catalog boundary: allowedChildTypes
 *  + maxChildren are HARD in `validateComponentTree`; minChildren is a SOFT
 *  document warning (the mid-edit rule). The synthetic types exercise the
 *  mechanics; the production `form` component (ADR 0347 5b) is the first REAL
 *  catalog consumer and is pinned below. */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerCanvasComponents, validateComponentTree } from '../../../host/canvasComponentCatalog.js';
import { registerAppBuilderComponents, APP_BUILDER_CANVAS_TYPE } from '../componentCatalog.js';
import { validateAppDoc } from '../validateAppDoc.js';

const SCRATCH = 'canvas.test-constraints';

beforeAll(() => {
  registerAppBuilderComponents();
  registerCanvasComponents(SCRATCH, [
    { type: 'form', label: 'Form', category: 'layout', acceptsChildren: true, allowedChildTypes: ['field'], maxChildren: 2, props: [] },
    { type: 'field', label: 'Field', category: 'input', props: [] },
    { type: 'stray', label: 'Stray', category: 'display', props: [] },
  ]);
  // A test-only container in the app-builder catalog exercises the SOFT
  // minChildren warning through validateAppDoc (no production component
  // carries constraints yet — annotations land with their consumers).
  registerCanvasComponents(APP_BUILDER_CANVAS_TYPE, [
    { type: 'testMinPair', label: 'Test pair', category: 'layout', acceptsChildren: true, minChildren: 2, props: [] },
  ]);
});

describe('validateComponentTree — HARD constraints', () => {
  it('rejects a child type outside allowedChildTypes', () => {
    const errs = validateComponentTree(SCRATCH, [{ type: 'form', children: [{ type: 'stray' }] }]);
    expect(errs.some((e) => e.code === 'illegal_children' && e.path === 'components[0].children[0]')).toBe(true);
  });
  it('rejects more than maxChildren', () => {
    const errs = validateComponentTree(SCRATCH, [{ type: 'form', children: [{ type: 'field' }, { type: 'field' }, { type: 'field' }] }]);
    expect(errs.some((e) => e.code === 'illegal_children' && e.path === 'components[0].children')).toBe(true);
  });
  it('accepts a legal constrained subtree', () => {
    expect(validateComponentTree(SCRATCH, [{ type: 'form', children: [{ type: 'field' }, { type: 'field' }] }])).toEqual([]);
  });
});

describe('validateAppDoc — SOFT minChildren', () => {
  const doc = (children: unknown[]): Record<string, unknown> => ({
    name: 'Min', screens: [{ id: 'home', name: 'Home', isInitial: true, components: [{ type: 'testMinPair', children }] }],
  });
  it('warns (never blocks) when a container is under its minimum', () => {
    const v = validateAppDoc(doc([{ type: 'text', props: { text: 'one' } }]));
    expect(v.errors).toEqual([]);
    expect(v.warnings.some((w) => w.message.includes('at least 2'))).toBe(true);
  });
  it('quiet at or above the minimum', () => {
    const v = validateAppDoc(doc([{ type: 'text', props: { text: 'a' } }, { type: 'text', props: { text: 'b' } }]));
    expect(v.warnings.filter((w) => w.message.includes('at least'))).toEqual([]);
  });
});

describe("the production `navBar` component (ADR 0347 5b — nav semantics stay on link/button)", () => {
  const doc = (children: unknown[]): Record<string, unknown> => ({
    name: 'N', screens: [{ id: 'home', name: 'Home', isInitial: true, components: [{ type: 'navBar', props: { brand: 'Aurora' }, children }] }],
  });
  it('HARD-rejects a non-link child (free text cannot live in a nav bar)', () => {
    const v = validateAppDoc(doc([{ type: 'text', props: { text: 'nope' } }]));
    expect(v.errors.some((e) => e.code === 'illegal_children')).toBe(true);
  });
  it('accepts links/buttons up to the cap of 8', () => {
    const links = Array.from({ length: 8 }, (_, i) => ({ type: 'link', props: { label: `L${i}`, navigateTo: 'home' } }));
    expect(validateAppDoc(doc(links)).errors).toEqual([]);
    const nine = [...links, { type: 'button', props: { label: 'More' } }];
    expect(validateAppDoc(doc(nine)).errors.some((e) => e.code === 'illegal_children')).toBe(true);
  });
});

describe("the production `form` component (ADR 0347 5b — the catalog's first real constrained container)", () => {
  const doc = (children: unknown[]): Record<string, unknown> => ({
    name: 'F', screens: [{ id: 'home', name: 'Home', isInitial: true, components: [{ type: 'form', props: { title: 'Sign in' }, children }] }],
  });
  it('HARD-rejects a non-form child (a chip cannot live in a form)', () => {
    const v = validateAppDoc(doc([{ type: 'chip', props: { text: 'nope' } }]));
    expect(v.errors.some((e) => e.code === 'illegal_children')).toBe(true);
  });
  it('accepts controls + copy + a submit button; an empty form warns SOFTLY', () => {
    const v = validateAppDoc(doc([
      { type: 'heading', props: { text: 'Sign in', level: '2' } },
      { type: 'textInput', props: { label: 'Email', kind: 'email' } },
      { type: 'button', props: { label: 'Submit' } },
    ]));
    expect(v.errors).toEqual([]);
    const empty = validateAppDoc(doc([]));
    expect(empty.errors).toEqual([]);
    expect(empty.warnings.some((w) => w.message.includes('at least 1'))).toBe(true);
  });
});
