/**
 * ADR 0305 Phase C parity tests — the catalog is ONE source with five consumers
 * (prompt, palette, validation, renderer, generators). These pin the backend
 * consumers so a catalog change can't drift silently:
 *   1. every catalog type maps in EVERY export generator (zero warnings);
 *   2. the App Architect pack prompt names every catalog type (the prompt is a
 *      static file — this is the drift tripwire the hand-written list needs);
 *   3. document-level validation: hard catalog errors vs soft cross-ref warnings;
 *   4. binding expansion unrolls + interpolates sample rows (escaped downstream).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { APP_BUILDER_COMPONENTS, registerAppBuilderComponents, ICON_NAMES } from '../componentCatalog.js';
import { generate, expandBindings, EXPORT_TARGETS, type AppModel, type ComponentNode } from '../export/generators.js';
import { validateAppDoc, CONNECTOR_TRIGGERS, CONNECTOR_TRANSITIONS, MAX_SCREENS } from '../validateAppDoc.js';

registerAppBuilderComponents();

/** A minimal valid node for a catalog def: required props filled from defaults or
 *  type-appropriate placeholders. */
function sampleNode(type: string): ComponentNode {
  const def = APP_BUILDER_COMPONENTS.find((c) => c.type === type)!;
  const props: Record<string, unknown> = {};
  for (const p of def.props ?? []) {
    if (!p.required && p.default === undefined) continue;
    if (p.default !== undefined) { props[p.name] = p.default; continue; }
    props[p.name] = p.type === 'number' ? 1 : p.type === 'boolean' ? true : p.type === 'enum' ? p.options?.[0] : 'Sample';
  }
  const node: ComponentNode = { type, props };
  if (def.acceptsChildren) node.children = [{ type: 'text', props: { text: 'Child' } }];
  return node;
}

const appWith = (components: ComponentNode[]): AppModel => ({
  name: 'Parity', screens: [{ id: 'home', name: 'Home', isInitial: true, components }],
});

describe('generator parity (every type × every target)', () => {
  for (const target of EXPORT_TARGETS) {
    it(`${target} maps all ${APP_BUILDER_COMPONENTS.length} catalog types with zero warnings`, () => {
      const app = appWith(APP_BUILDER_COMPONENTS.map((c) => sampleNode(c.type)));
      const result = generate(target, app);
      expect(result.warnings).toEqual([]);
      expect(result.files.length).toBeGreaterThan(0);
    });
  }
  it('an unknown type degrades to a warning, never an error', () => {
    for (const target of EXPORT_TARGETS) {
      const result = generate(target, appWith([{ type: 'holo-deck' }]));
      expect(result.warnings.length).toBe(1);
    }
  });
});

// ADR 0358 Phase C INVERTED this tripwire: the prompt no longer carries the
// catalog at all — the agent fetches it live via `openwop:app-builder.catalog`
// (and validation errors teach it what the prompt used to). What must now be
// pinned is the ABSENCE of any reconstructible hand copy: high-churn sentinel
// types (each added in a different catalog wave) may not appear in prose. The
// marked-illustrative JSON example may keep only the stable primitives.
describe('prompt ↔ catalog INDEPENDENCE (the ADR 0358 tripwire)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const promptPath = join(here, '../../../../../../packs/feature.app-builder.agents/prompts/app-architect.md');
  const prompt = readFileSync(promptPath, 'utf8');
  it('carries NO reconstructible catalog (sentinel types absent)', () => {
    for (const sentinel of ['statCard', 'radioGroup', 'fileUpload', 'textarea', 'accordion', 'snackbar', 'form (children']) {
      expect(prompt, `prompt must not hand-carry '${sentinel}'`).not.toContain(sentinel);
    }
    // The icon vocabulary was the other hand-copied enum — spot-check names
    // that are icon-only (never legitimate prose here).
    for (const icon of ['map-pin', 'arrow-right']) {
      expect(prompt).not.toContain(icon);
    }
    void ICON_NAMES; // catalog import stays exercised by the generator suites above
  });
  // XCH-APPB-1 (LLM-EXCHANGE-AUDIT Wave 3): the prompt DOES hand-carry the
  // connector vocabulary (trigger/transition enums + the screens cap) — the
  // one catalog fragment ADR 0358 left inline. Pin it to validateAppDoc.
  it('connector vocabulary + screens cap match validateAppDoc', () => {
    for (const t of CONNECTOR_TRIGGERS) expect(prompt, `prompt must carry trigger '${t}'`).toContain(t);
    for (const t of CONNECTOR_TRANSITIONS) expect(prompt, `prompt must carry transition '${t}'`).toContain(t);
    expect(prompt, `prompt must carry the 1–${MAX_SCREENS} screens cap`).toContain(`1–${MAX_SCREENS}`);
  });

  it('teaches the tool-first flow instead', () => {
    for (const id of ['openwop:app-builder.catalog', 'openwop:app-builder.get-design', 'openwop:app-builder.render']) {
      expect(prompt).toContain(id);
    }
  });
});

describe('validateAppDoc (hard errors vs soft cross-ref warnings)', () => {
  it('accepts a valid doc with zero errors/warnings', () => {
    const v = validateAppDoc({ screens: [{ id: 'home', isInitial: true, components: [sampleNode('button')] }] });
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
  });
  it('hard-rejects an unknown component type', () => {
    const v = validateAppDoc({ screens: [{ id: 'home', components: [{ type: 'holo-deck' }] }] });
    expect(v.errors.length).toBe(1);
    expect(v.errors[0]?.code).toBe('unknown_component_type');
  });
  it('soft-warns on navigateTo → missing screen (mid-edit state)', () => {
    const v = validateAppDoc({ screens: [{ id: 'home', isInitial: true, components: [{ type: 'button', props: { label: 'Go', navigateTo: 'nowhere' } }] }] });
    expect(v.errors).toEqual([]);
    expect(v.warnings.length).toBe(1);
    expect(v.warnings[0]?.message).toContain("missing screen 'nowhere'");
  });
  it('soft-warns on list.bind → missing data source and connector → missing screen', () => {
    const v = validateAppDoc({
      screens: [{ id: 'home', isInitial: true, components: [{ type: 'list', props: { bind: 'ghosts' }, children: [{ type: 'text', props: { text: 'x' } }] }] }],
      connectors: [{ from: 'home', to: 'void' }],
    });
    expect(v.errors).toEqual([]);
    expect(v.warnings.map((w) => w.message).join(' ')).toContain("missing data source 'ghosts'");
    expect(v.warnings.map((w) => w.message).join(' ')).toContain("missing screen 'void'");
  });

  // ADR 0323 — screen-flow graph fields (positions + edge presentation).
  it('accepts screen x/y positions + full connector presentation', () => {
    const v = validateAppDoc({
      screens: [
        { id: 'home', isInitial: true, x: 100, y: 40, components: [sampleNode('button')] },
        { id: 'next', name: 'Next', x: -320.5, y: 260, components: [] },
      ],
      connectors: [{ from: 'home', to: 'next', sourceEdge: 'right', targetEdge: 'left', transition: 'slide', routingStyle: 'bezier', animated: true }],
    });
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
  });
  it('hard-rejects a non-finite / out-of-bounds screen position (editor PATCH runs no JSON Schema)', () => {
    const v = validateAppDoc({ screens: [{ id: 'home', isInitial: true, x: 999999, y: 0, components: [] }] });
    expect(v.errors.length).toBe(1);
    expect(v.errors[0]?.path).toBe('screens[0].x');
  });
  it('hard-rejects an out-of-set connector enum + non-boolean animated', () => {
    const bad = validateAppDoc({
      screens: [{ id: 'home', isInitial: true, components: [] }, { id: 'a', name: 'A', components: [] }],
      connectors: [{ from: 'home', to: 'a', sourceEdge: 'diagonal', animated: 'yes' }],
    });
    const paths = bad.errors.map((e) => e.path);
    expect(paths).toContain('connectors[0].sourceEdge');
    expect(paths).toContain('connectors[0].animated');
  });
  it('soft-warns on a self-looping connector', () => {
    const v = validateAppDoc({ screens: [{ id: 'home', isInitial: true, components: [] }], connectors: [{ from: 'home', to: 'home' }] });
    expect(v.errors).toEqual([]);
    expect(v.warnings.some((w) => w.message.includes('back to itself'))).toBe(true);
  });
});

describe('generated-code injection hardening (grade pass F2)', () => {
  const hostile = {
    name: 'Evil', screens: [{ id: 'home', name: 'Home', isInitial: true, components: [
      { type: 'text', props: { text: '{alert(document.cookie)}' } },
      { type: 'text', props: { text: '{{ 7*7 }}' } },
      { type: 'heading', props: { text: "'; window.x = 1; '", level: '2' } },
    ] }],
  };
  it('braces never survive as live JSX/Vue expressions in any web target', () => {
    for (const target of ['react-tailwind', 'react-styled', 'vue-tailwind', 'html-css', 'nextjs'] as const) {
      const out = generate(target, hostile as AppModel);
      const src = out.files.map((f) => f.content).join('\n');
      expect(src).not.toContain('{alert(document.cookie)}');
      expect(src).not.toContain('{{ 7*7 }}');
      expect(src).toContain('&#123;'); // entity-escaped, renders as literal text
    }
  });
  it('screen ids are slug-sanitized in every JS string interpolation', () => {
    const evilId = { ...hostile, screens: [{ id: "x'); import('http", name: 'X', isInitial: true, components: [{ type: 'button', props: { label: 'Go', navigateTo: "x'); import('http" } }] }] };
    for (const target of ['react-tailwind', 'react-styled', 'vue-tailwind', 'nextjs'] as const) {
      const src = generate(target, evilId as unknown as AppModel).files.map((f) => f.content).join('\n');
      expect(src).not.toContain("x'); import('http");
    }
    // …and the validator hard-rejects such an id at the save path anyway.
    const v = validateAppDoc(evilId);
    expect(v.errors.some((e) => e.path.endsWith('.id'))).toBe(true);
  });
  it('comment/Dart contexts cannot be broken out of (RN + Flutter)', () => {
    const evil = { ...hostile, screens: [{ id: 'a*/b', name: 'N\nline', isInitial: true, components: [{ type: 'button', props: { label: 'Go', navigateTo: 'a*/b' } }] }] };
    for (const target of ['react-native', 'flutter'] as const) {
      const src = generate(target, evil as unknown as AppModel).files.map((f) => f.content).join('\n');
      expect(src).not.toContain('a*/b');
    }
  });
});

describe('expandBindings (data binding v1)', () => {
  const app: AppModel = {
    name: 'Bind', dataSources: [{ id: 'products', name: 'Products', fields: ['title', 'price'], rows: [{ title: 'Alpha', price: '$1' }, { title: 'Beta<b>', price: '$2' }] }],
    screens: [{ id: 'home', name: 'Home', components: [
      { type: 'list', props: { bind: 'products' }, children: [{ type: 'text', props: { text: '{{title}} — {{price}}' } }] },
    ] }],
  };
  it('unrolls children per sample row with interpolated props', () => {
    const out = expandBindings(app);
    const list = out.screens[0]?.components?.[0];
    expect(list?.children?.length).toBe(2);
    expect(list?.children?.[0]?.props?.text).toBe('Alpha — $1');
    expect(list?.children?.[1]?.props?.text).toBe('Beta<b> — $2');
    expect(list?.props?.bind).toBeUndefined();
  });
  it('interpolated values pass through each generator ESCAPED (amendment 2)', () => {
    const html = generate('html-css', app);
    const page = html.files.find((f) => f.path.endsWith('.html'))?.content ?? '';
    expect(page).toContain('Beta&lt;b&gt;');
    expect(page).not.toContain('Beta<b>');
  });
  it('an unknown bind id leaves the list as-authored', () => {
    const out = expandBindings({ ...app, dataSources: [] });
    expect(out.screens[0]?.components?.[0]?.children?.length).toBe(1);
    expect(out.screens[0]?.components?.[0]?.props?.bind).toBe('products');
  });
});

describe('ADR 0323 Phase 3 — dataSource binding (declarative, export-safe)', () => {
  it('the list `bind` prop is a dataSource ref, not raw text', () => {
    const list = APP_BUILDER_COMPONENTS.find((c) => c.type === 'list');
    expect(list?.props?.find((p) => p.name === 'bind')?.type).toBe('dataSource');
  });
  it('validateAppDoc accepts a string bind to an existing source (value unchanged → generators/validation unaffected)', () => {
    const v = validateAppDoc({
      screens: [{ id: 'home', isInitial: true, components: [{ type: 'list', props: { bind: 'orders' }, children: [{ type: 'text', props: { text: 'x' } }] }] }],
      dataSources: [{ id: 'orders', name: 'Orders', fields: ['id'] }],
    });
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
  });
  it('a non-string bind is a hard bad_prop_value (dataSource is string-valued)', () => {
    const v = validateAppDoc({ screens: [{ id: 'home', isInitial: true, components: [{ type: 'list', props: { bind: 42 } }] }] });
    expect(v.errors.some((e) => e.path.endsWith('.props.bind') && e.code === 'bad_prop_value')).toBe(true);
  });
});

// ── Grade pass (F5/D-F5, code-F8): the editor gate matches the artifact schema
// on EVERY connector/dataSource constraint, and ids need one alphanumeric. ──
describe('validateAppDoc — schema-parity hardening (grade pass)', () => {
  const base = { screens: [{ id: 'a' }, { id: 'b' }] };
  it('rejects a bad trigger, an over-long label, and a missing endpoint HARD', () => {
    const v1 = validateAppDoc({ ...base, connectors: [{ from: 'a', to: 'b', trigger: 'hover' }] });
    expect(v1.errors.some((e) => e.path === 'connectors[0].trigger')).toBe(true);
    const v2 = validateAppDoc({ ...base, connectors: [{ from: 'a', to: 'b', label: 'x'.repeat(121) }] });
    expect(v2.errors.some((e) => e.path === 'connectors[0].label')).toBe(true);
    const v3 = validateAppDoc({ ...base, connectors: [{ to: 'b' }] });
    expect(v3.errors.some((e) => e.path === 'connectors[0].from')).toBe(true);
  });
  it('caps connectors at 200 and sample rows at 10 (the schema bounds)', () => {
    const many = Array.from({ length: 201 }, () => ({ from: 'a', to: 'b' }));
    expect(validateAppDoc({ ...base, connectors: many }).errors.some((e) => e.path === 'connectors')).toBe(true);
    const rows = Array.from({ length: 11 }, () => ({ f: 1 }));
    expect(validateAppDoc({ ...base, dataSources: [{ id: 'src', rows }] }).errors.some((e) => e.path === 'dataSources[0].rows')).toBe(true);
  });
  it("rejects dot-only screen ids ('..' collided in the Next.js route paths)", () => {
    const v = validateAppDoc({ screens: [{ id: '..' }] });
    expect(v.errors.some((e) => e.path === 'screens[0].id')).toBe(true);
    expect(validateAppDoc({ screens: [{ id: 'v1.2' }] }).errors.length).toBe(0); // dots WITH alphanumerics stay legal
  });
});
