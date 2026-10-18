/**
 * App-builder canvas (ADR 0153 Phase 2) — two contracts:
 *  1. the `canvas.app-builder` artifact-type schema gates structure (ADR 0055);
 *  2. the shared component catalog enforces CLOSED-WORLD validation — an unknown
 *     component type / prop, or children under a non-container, are rejected
 *     (the R4 single-catalog promise), and the prompt schema is deterministic.
 *
 * Sabotage witnesses (grade-tests w36): schema `minItems:1` → 0, top-level
 * `additionalProperties:false` → true, component `required:['type']` removed,
 * and in canvasComponentCatalog the unknown-type / unknown-prop / enum /
 * non-container checks disabled and the prompt sort shuffled — each reds the
 * matching case below.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerAppBuilderArtifactType } from '../artifactTypes.js';
import { registerAppBuilderComponents, APP_BUILDER_CANVAS_TYPE } from '../componentCatalog.js';
import { validateArtifact, isRegisteredArtifactType } from '../../../host/artifactTypes.js';
import { validateComponentTree, catalogPromptSchema, listCanvasComponents, __resetCanvasCatalogs } from '../../../host/canvasComponentCatalog.js';

const validApp = {
  name: 'Todo',
  screens: [
    {
      id: 'home', name: 'Home', route: '/', isInitial: true,
      components: [
        { type: 'stack', props: { gap: 'md' }, children: [
          { type: 'heading', props: { text: 'My tasks', level: '1' } },
          { type: 'button', props: { label: 'Add', variant: 'primary' } },
        ] },
      ],
    },
  ],
  connectors: [{ from: 'home', to: 'home', trigger: 'click' }],
};

describe('canvas.app-builder artifact type', () => {
  beforeAll(() => { registerAppBuilderArtifactType(); });

  it('registers canvas.app-builder', () => {
    expect(isRegisteredArtifactType('canvas.app-builder')).toBe(true);
  });
  it('accepts a well-formed app design', () => {
    expect(validateArtifact('canvas.app-builder', validApp)).toMatchObject({ registered: true, valid: true });
  });
  it('rejects an app with no screens', () => {
    const v = validateArtifact('canvas.app-builder', { name: 'X', screens: [] });
    expect(v.valid).toBe(false);
    expect(JSON.stringify(v.errors)).toContain('/screens'); // refused for the empty screens, not another reason
  });
  it('rejects unknown top-level keys (closed schema)', () => {
    expect(validateArtifact('canvas.app-builder', { ...validApp, script: 'x' }).valid).toBe(false);
  });
  it('rejects a component without a type (recursive $ref)', () => {
    const bad = { name: 'X', screens: [{ id: 's', name: 'S', components: [{ props: {} }] }] };
    expect(validateArtifact('canvas.app-builder', bad).valid).toBe(false);
  });
});

describe('app-builder component catalog (closed-world)', () => {
  beforeAll(() => { __resetCanvasCatalogs(); registerAppBuilderComponents(); });

  it('exposes the catalog for the palette + a deterministic prompt schema', () => {
    const a = catalogPromptSchema(APP_BUILDER_CANVAS_TYPE);
    const b = catalogPromptSchema(APP_BUILDER_CANVAS_TYPE);
    expect(a).toBe(b); // stable
    // One line per registered component, in sorted order (derived from the
    // text itself, so a deterministic-but-unsorted output is caught too).
    const types = a.split('\n').map((l) => l.slice(2).split(/[ —]/)[0]!);
    expect(types).toHaveLength(listCanvasComponents(APP_BUILDER_CANVAS_TYPE).length);
    expect(types).toEqual([...types].sort((x, y) => x.localeCompare(y)));
    expect(types).toContain('button');
  });
  it('passes a valid component tree', () => {
    const errs = validateComponentTree(APP_BUILDER_CANVAS_TYPE, validApp.screens[0]!.components);
    expect(errs).toEqual([]);
  });
  it('rejects an unknown component type', () => {
    // 'carousel' joined the catalog in ADR 0305 Phase C — use a genuinely unknown type.
    const errs = validateComponentTree(APP_BUILDER_CANVAS_TYPE, [{ type: 'holo-deck' }]);
    expect(errs.map((e) => e.code)).toContain('unknown_component_type');
  });
  it('rejects an unknown prop and a bad enum value', () => {
    const errs = validateComponentTree(APP_BUILDER_CANVAS_TYPE, [{ type: 'button', props: { label: 'ok', variant: 'neon', bogus: 1 } }]);
    const codes = errs.map((e) => e.code);
    expect(codes).toContain('unknown_prop');
    expect(codes).toContain('bad_prop_value');
  });
  it('rejects children under a non-container', () => {
    const errs = validateComponentTree(APP_BUILDER_CANVAS_TYPE, [{ type: 'text', props: { text: 'x' }, children: [{ type: 'text', props: { text: 'y' } }] }]);
    expect(errs.map((e) => e.code)).toContain('illegal_children');
  });
});
