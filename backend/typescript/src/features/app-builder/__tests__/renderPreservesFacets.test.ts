/**
 * ABR-RENDER-1 / ABR-REPAIR-1 / ABR-GATES-1 (wave-36 grading of app-builder).
 *
 * The `render` node is the one normalization gate for the chat render tool,
 * the MCP control lane and the governed repair node. It rebuilt every document
 * from a fixed field list, so a get-design → render update CAS-wrote a copy
 * with the user's data model, operations, auth design and every per-node
 * action/binding erased, and reported success. It also dropped invalid values
 * (a non-hex color, an out-of-enum trigger, an 11th sample row) before the
 * validator could see them. And validateAppDoc accepted unknown keys that the
 * artifact schema refuses, so the two gates disagreed.
 *
 * MEASURED: 19 of these 22 tests are red against origin/main d812ae704's pack
 * and validator. The other three are guards that held before and must keep
 * holding: the fixture is valid, render does not mutate its input, and a
 * mid-edit screen with no name is still accepted.
 */
import { describe, expect, it } from 'vitest';
import { validateAppDoc } from '../validateAppDoc.js';
import { registerAppBuilderComponents } from '../componentCatalog.js';

registerAppBuilderComponents();

type NodeFn = (ctx: unknown) => Promise<{ status: string; outputs: Record<string, unknown> }>;
const pack = async () => (await import('../../../../../../packs/feature.app-builder.nodes/index.mjs')) as unknown as Record<string, NodeFn>;

/** A host surface whose validate is the REAL editor gate. */
function surfaceWith(extra: Record<string, unknown> = {}) {
  return {
    'app-builder': {
      validate: async ({ app }: { app: unknown }) => {
        const v = validateAppDoc(app);
        return { ok: v.errors.length === 0, errors: v.errors, warnings: v.warnings };
      },
      ...extra,
    },
  };
}

/** A document that uses every ADR 0343/0344/0345 facet and is VALID. */
function fullDoc(): Record<string, unknown> {
  return {
    name: 'Tasks',
    description: 'A task tracker',
    theme: 'dark',
    themeColors: { primary: '#1d4ed8', secondary: '#f59e0b' },
    schemaVersion: 2,
    designSystemRef: { id: 'ds-1', mode: 'linked' },
    brandRef: { id: 'brand-1', mode: 'detached' },
    stateVariables: [{ id: 'filter', type: 'string', initial: 'all', label: 'Filter' }],
    models: [{
      id: 'task', name: 'Task',
      fields: [{ name: 'title', type: 'string', required: true, validation: { maxLength: 200 } }, { name: 'done', type: 'boolean' }],
    }],
    operations: [{
      id: 'listTasks', name: 'List tasks', kind: 'list', modelId: 'task',
      output: { type: 'modelList' }, auth: 'user', mock: { status: 'ok', rows: [{ title: 'A' }] },
    }],
    authProfile: { kind: 'email-password', roles: ['admin'], guards: [{ screenId: 'Detail', requiresRole: 'admin', redirectTo: 'home' }] },
    envRequirements: [{ key: 'API_BASE', purpose: 'the backend', requiredFor: ['runtime'] }],
    componentDefinitions: [{ id: 'card', name: 'Card', root: { type: 'text', props: { text: 'card' } } }],
    sharePolicy: { sampleData: 'include', perSource: { Products: true } },
    dataSources: [{ id: 'Products', name: 'Products', fields: ['title'], rows: [{ title: 'X' }] }],
    screens: [
      {
        id: 'home', name: 'Home', isInitial: true, route: '/', x: 80, y: 40,
        components: [
          {
            type: 'button', props: { label: 'Open', navigateTo: 'Detail' }, locked: true,
            actions: [{ on: 'click', kind: 'invoke-operation', operation: 'listTasks', onSuccess: { navigate: 'Detail' } }],
            bindings: { label: { path: 'state.filter', fallback: 'all' } },
          },
          { type: 'text', props: { text: 'hidden note' }, hidden: true },
          { type: 'list', props: { bind: 'Products' }, children: [{ type: 'text', props: { text: '{{title}}' } }] },
        ],
      },
      { id: 'Detail', name: 'Detail', route: '/detail' },
    ],
    connectors: [{ from: 'home', to: 'Detail', trigger: 'click', label: 'open', transition: 'push' }],
  };
}

describe('ABR-RENDER-1 — render carries every facet (it used to erase them)', () => {
  it('the fixture is a VALID document (so a failure below is the node, not the fixture)', () => {
    expect(validateAppDoc(fullDoc()).errors).toEqual([]);
  });

  it('a full document round-trips through render UNCHANGED, with the real validator on', async () => {
    const { render } = await pack();
    const res = await render({ inputs: { app: fullDoc() }, features: surfaceWith() });
    expect(res.outputs.validation).toEqual({ ok: true, warnings: 0 });
    expect((res.outputs.artifact as { payload: unknown }).payload).toEqual(fullDoc());
  });

  it('does not mutate the caller’s object (a run snapshot is delivered by reference)', async () => {
    const { render } = await pack();
    const input = fullDoc();
    input.screens = [{ id: 'Home Screen', name: 'Home' }];
    await render({ inputs: { app: input } });
    expect((input.screens as { id: string }[])[0]!.id).toBe('Home Screen');
  });

  it('a renamed id is followed by every reference to it (actions, guards, binds, binding paths, share overrides)', async () => {
    const { render } = await pack();
    const doc = fullDoc();
    (doc.screens as Record<string, unknown>[])[1]!.id = 'Detail Page';
    const home = (doc.screens as { components: Record<string, unknown>[] }[])[0]!;
    (home.components[0]!.props as Record<string, unknown>).navigateTo = 'Detail Page';
    (home.components[0]!.actions as Record<string, unknown>[])[0]!.onSuccess = { navigate: 'Detail Page' };
    (doc.connectors as Record<string, unknown>[])[0]!.to = 'Detail Page';
    (doc.authProfile as { guards: Record<string, unknown>[] }).guards[0]!.screenId = 'Detail Page';
    (doc.dataSources as Record<string, unknown>[])[0]!.id = 'Products!';
    (home.components[2]!.props as Record<string, unknown>).bind = 'Products!';
    home.components[1]!.bindings = { text: { path: 'source.Products!.title' } };
    (doc.sharePolicy as { perSource: Record<string, boolean> }).perSource = { 'Products!': true };

    const res = await render({ inputs: { app: doc } });
    const out = (res.outputs.artifact as { payload: Record<string, unknown> }).payload;
    const outHome = (out.screens as { components: Record<string, unknown>[] }[])[0]!;
    expect((out.screens as { id: string }[])[1]!.id).toBe('detail-page');
    expect((outHome.components[0]!.props as Record<string, unknown>).navigateTo).toBe('detail-page');
    expect((outHome.components[0]!.actions as { onSuccess: unknown }[])[0]!.onSuccess).toEqual({ navigate: 'detail-page' });
    expect((out.connectors as { to: string }[])[0]!.to).toBe('detail-page');
    expect((out.authProfile as { guards: { screenId: string }[] }).guards[0]!.screenId).toBe('detail-page');
    expect((out.dataSources as { id: string }[])[0]!.id).toBe('products');
    expect((outHome.components[2]!.props as Record<string, unknown>).bind).toBe('products');
    expect(out.sharePolicy).toEqual({ sampleData: 'include', perSource: { products: true } });
  });

  it('an id that is already valid is kept verbatim (slugging used to lowercase `Products`)', async () => {
    const { render } = await pack();
    const res = await render({ inputs: { app: fullDoc() } });
    const out = (res.outputs.artifact as { payload: Record<string, unknown> }).payload;
    expect((out.dataSources as { id: string }[])[0]!.id).toBe('Products');
    expect((out.screens as { id: string }[])[1]!.id).toBe('Detail');
  });
});

describe('ABR-RENDER-1 half 2 — an invalid value is a typed failure, never a silent drop', () => {
  const cases: [string, (d: Record<string, unknown>) => void, string][] = [
    ['a non-hex theme color', (d) => { d.themeColors = { primary: 'blue' }; }, 'themeColors.primary'],
    ['an out-of-enum connector trigger', (d) => { (d.connectors as Record<string, unknown>[])[0]!.trigger = 'hover'; }, 'connectors[0].trigger'],
    ['more than 10 sample rows', (d) => { (d.dataSources as Record<string, unknown>[])[0]!.rows = Array.from({ length: 11 }, (_, i) => ({ title: `r${i}` })); }, 'dataSources[0].rows'],
    ['an unknown component key', (d) => { (d.screens as { components: Record<string, unknown>[] }[])[0]!.components[1]!.onClick = 'hack()'; }, 'screens[0].components[1].onClick'],
  ];
  for (const [label, mutate, path] of cases) {
    it(`${label} fails render as app_doc_invalid naming ${path}`, async () => {
      const { render } = await pack();
      const doc = fullDoc();
      mutate(doc);
      const err = await render({ inputs: { app: doc }, features: surfaceWith() }).then(() => null, (e: unknown) => e as { code?: string; details?: { errors: { path: string }[] } });
      expect(err?.code).toBe('app_doc_invalid');
      expect(err?.details?.errors.map((e) => e.path)).toContain(path);
    });
  }
});

describe('ABR-GATES-1 — validateAppDoc refuses every key the artifact schema refuses', () => {
  const unknownAt: [string, (d: Record<string, unknown>) => void, string][] = [
    ['the document', (d) => { d.secretToken = 'x'; }, 'secretToken'],
    ['a screen', (d) => { (d.screens as Record<string, unknown>[])[0]!.colour = 'red'; }, 'screens[0].colour'],
    ['a component', (d) => { (d.screens as { components: Record<string, unknown>[] }[])[0]!.components[0]!.script = 'x'; }, 'screens[0].components[0].script'],
    ['a nested child', (d) => { ((d.screens as { components: { children: Record<string, unknown>[] }[] }[])[0]!.components[2]!.children[0]!).evil = 1; }, 'screens[0].components[2].children[0].evil'],
    ['a connector', (d) => { (d.connectors as Record<string, unknown>[])[0]!.weight = 3; }, 'connectors[0].weight'],
    ['a model field', (d) => { (d.models as { fields: Record<string, unknown>[] }[])[0]!.fields[0]!.sql = 'drop'; }, 'models[0].fields[0].sql'],
    ['an operation', (d) => { (d.operations as Record<string, unknown>[])[0]!.url = 'https://x'; }, 'operations[0].url'],
    ['an action', (d) => { ((d.screens as { components: { actions: Record<string, unknown>[] }[] }[])[0]!.components[0]!.actions[0]!).code = 'x'; }, 'screens[0].components[0].actions[0].code'],
    ['a component definition root', (d) => { ((d.componentDefinitions as { root: Record<string, unknown> }[])[0]!.root).raw = '<b>'; }, 'componentDefinitions[0].root.raw'],
  ];
  for (const [where, mutate, path] of unknownAt) {
    it(`an unknown key on ${where} is a hard unknown_prop error at ${path}`, () => {
      const doc = fullDoc();
      mutate(doc);
      const errs = validateAppDoc(doc).errors.filter((e) => e.code === 'unknown_prop');
      expect(errs.map((e) => e.path)).toEqual([path]);
    });
  }

  it('still allows the legal mid-edit states the schema’s `required` would refuse (a screen with no name yet)', () => {
    const doc = fullDoc();
    delete (doc.screens as Record<string, unknown>[])[1]!.name;
    expect(validateAppDoc(doc).errors).toEqual([]);
  });
});

describe('ABR-REPAIR-1 — governed repair preserves the design and validates its candidate', () => {
  const repairCtx = (replies: string[], current = fullDoc()) => {
    const calls: unknown[] = [];
    return {
      calls,
      ctx: {
        inputs: { canvasId: 'c-1', instructions: 'rename the Open button to Show' },
        config: {},
        features: surfaceWith({
          getDesign: async () => ({ app: current, version: 7 }),
          getCatalog: async () => ({ promptTypeList: 'text, button, list, stack' }),
        }),
        callAI: async (req: unknown) => { calls.push(req); return { content: replies[Math.min(calls.length - 1, replies.length - 1)]! }; },
      },
    };
  };

  it('a facet the model leaves out is carried over, not erased (it used to erase the data model)', async () => {
    const { repair } = await pack();
    const { name, screens, connectors } = fullDoc();
    const { ctx } = repairCtx([JSON.stringify({ name, screens, connectors })]);
    const res = await repair(ctx);
    const payload = (res.outputs.artifact as { payload: Record<string, unknown> }).payload;
    expect(payload).toEqual(fullDoc());
    expect(res.outputs.baseVersion).toBe(7);
  });

  it('an invalid candidate is fed back ONCE; a fixed retry succeeds', async () => {
    const { repair } = await pack();
    const bad = { ...fullDoc(), themeColors: { primary: 'blue' } };
    const { ctx, calls } = repairCtx([JSON.stringify(bad), JSON.stringify(fullDoc())]);
    const res = await repair(ctx);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify((calls[1] as { messages: unknown[] }).messages)).toContain('themeColors.primary');
    expect((res.outputs.artifact as { payload: unknown }).payload).toEqual(fullDoc());
  });

  it('a candidate still invalid after the one retry is a typed failure, never a success', async () => {
    const { repair } = await pack();
    const bad = { ...fullDoc(), themeColors: { primary: 'blue' } };
    const { ctx, calls } = repairCtx([JSON.stringify(bad)]);
    const err = await repair(ctx).then(() => null, (e: unknown) => e as { code?: string; message?: string });
    expect(calls).toHaveLength(2);
    expect(err?.code).toBe('app_doc_invalid');
    expect(err?.message).toContain('themeColors.primary');
  });
});

describe('ABR-REPAIR-2 — a repair keeps each component’s actions, bindings, hidden and locked', () => {
  type Comp = Record<string, unknown>;
  const repairCtx = (replies: string[]) => {
    const calls: unknown[] = [];
    return {
      calls,
      ctx: {
        inputs: { canvasId: 'c-1', instructions: 'rename the Open button to Show' },
        config: {},
        features: surfaceWith({
          getDesign: async () => ({ app: fullDoc(), version: 7 }),
          getCatalog: async () => ({ promptTypeList: 'text, button, list, stack' }),
        }),
        callAI: async (req: unknown) => { calls.push(req); return { content: replies[Math.min(calls.length - 1, replies.length - 1)]! }; },
      },
    };
  };
  /** fullDoc with the home screen's components rewritten by `edit`. */
  const withHome = (edit: (cs: Comp[]) => Comp[]) => {
    const d = fullDoc();
    const screens = d.screens as Array<{ components?: Comp[] }>;
    screens[0]!.components = edit(screens[0]!.components!);
    return d;
  };
  const strip = (c: Comp): Comp => {
    const { actions: _a, bindings: _b, hidden: _h, locked: _l, ...rest } = c;
    return { ...rest, ...(Array.isArray(c.children) ? { children: (c.children as Comp[]).map(strip) } : {}) };
  };
  const homeOf = (res: { outputs: Record<string, unknown> }) =>
    ((res.outputs.artifact as { payload: { screens: Array<{ components: Comp[] }> } }).payload.screens[0]!.components);

  it('same layout: every omitted component facet is carried back from the same position', async () => {
    const { repair } = await pack();
    const candidate = withHome((cs) => cs.map(strip).map((c, i) => (i === 0 ? { ...c, props: { label: 'Show', navigateTo: 'Detail' } } : c)));
    const { ctx, calls } = repairCtx([JSON.stringify(candidate)]);
    const res = await repair(ctx);
    expect(calls).toHaveLength(1);
    const want = withHome((cs) => cs.map((c, i) => (i === 0 ? { ...c, props: { label: 'Show', navigateTo: 'Detail' } } : c)));
    expect((res.outputs.artifact as { payload: unknown }).payload).toEqual(want);
  });

  it('same layout: a facet emitted EMPTY is removed, not carried back', async () => {
    const { repair } = await pack();
    const candidate = withHome((cs) => cs.map((c, i) => (i === 0 ? { ...c, actions: [] } : c)));
    const { ctx } = repairCtx([JSON.stringify(candidate)]);
    const res = await repair(ctx);
    expect(homeOf(res)[0]!.actions).toEqual([]);
    expect(homeOf(res)[0]!.bindings).toEqual({ label: { path: 'state.filter', fallback: 'all' } });
  });

  it('restructured: a dropped action is fed back ONCE, and a retry that keeps it succeeds', async () => {
    const { repair } = await pack();
    const note = { type: 'text', props: { text: 'new heading' } };
    const dropped = withHome((cs) => [note, strip(cs[0]!), ...cs.slice(1)]);
    const fixed = withHome((cs) => [note, ...cs]);
    const { ctx, calls } = repairCtx([JSON.stringify(dropped), JSON.stringify(fixed)]);
    const res = await repair(ctx);
    expect(calls).toHaveLength(2);
    const fedBack = JSON.stringify((calls[1] as { messages: unknown[] }).messages);
    expect(fedBack).toContain("a 'button' component lost its actions");
    expect(fedBack).toContain("a 'button' component lost its bindings");
    expect((res.outputs.artifact as { payload: unknown }).payload).toEqual(fixed);
  });

  it('restructured: dropping it again after the retry is a typed failure, never a silent loss', async () => {
    const { repair } = await pack();
    const dropped = withHome((cs) => [{ type: 'text', props: { text: 'new heading' } }, strip(cs[0]!), ...cs.slice(1)]);
    const { ctx, calls } = repairCtx([JSON.stringify(dropped)]);
    const err = await repair(ctx).then(() => null, (e: unknown) => e as { code?: string; message?: string });
    expect(calls).toHaveLength(2);
    expect(err?.code).toBe('app_doc_invalid');
    expect(err?.message).toContain('lost its actions');
  });

  it('restructured: removing the component, or emptying its facets, is a deliberate edit and passes first time', async () => {
    const { repair } = await pack();
    const removed = withHome((cs) => [{ type: 'text', props: { text: 'new heading' } }, ...cs.slice(1)]);
    const emptied = withHome((cs) => [{ type: 'text', props: { text: 'new heading' } }, { ...cs[0]!, actions: [], bindings: {} }, ...cs.slice(1)]);
    for (const candidate of [removed, emptied]) {
      const { ctx, calls } = repairCtx([JSON.stringify(candidate)]);
      const res = await repair(ctx);
      expect(calls).toHaveLength(1);
      expect((res.outputs.artifact as { payload: unknown }).payload).toEqual(candidate);
    }
  });
});
