/**
 * ADR 0343 Phase 1a — the comprehensive application-document facets, proven at
 * BOTH gates on the SAME fixtures: the artifact JSON Schema (the emit path,
 * `validateArtifact`) and `validateAppDoc` (the editor PATCH path). The two
 * gates agreeing is the phase's core invariant — a document the AI can emit
 * must be saveable by the editor, and vice versa.
 *
 * The "vice versa" half is ABR-GATES-1 (#4756): an unknown key is refused by
 * BOTH gates (the per-path matrix lives in renderPreservesFacets.test.ts).
 * Sabotage witnesses (grade-tests w36): WORD_RE admitting '-', the duplicate-
 * model check, referenceTo, the adapterRef URL check, the navigate `to`
 * requirement, BINDING_PATH_RE, ENV_KEY_RE, a per-definition node budget, the
 * componentDefinitions catalog walk and each soft cross-reference warning —
 * each reds its case below. (The ADR 0343 `migrateAppDoc` cases were cut in
 * w36: the module has no production importer, so they guarded nothing.)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { validateArtifact } from '../../../host/artifactTypes.js';
import { registerAppBuilderArtifactType } from '../artifactTypes.js';
import { registerAppBuilderComponents } from '../componentCatalog.js';
import { validateAppDoc } from '../validateAppDoc.js';

beforeAll(() => {
  registerAppBuilderArtifactType();
  registerAppBuilderComponents();
});

/** Every ADR 0343 facet populated — the "comprehensive application" fixture. */
const comprehensiveDoc = (): Record<string, unknown> => ({
  schemaVersion: 1,
  name: 'Aurora Tasks',
  description: 'A task tracker with auth and a real domain model.',
  theme: 'dark',
  themeColors: { primary: '#7c5cff', secondary: '#22d3ee' },
  designSystemRef: { id: 'ds_aurora', mode: 'linked' },
  brandRef: { id: 'brand_aurora' },
  stateVariables: [
    { id: 'filter', type: 'string', label: 'Active filter', initial: 'all' },
    { id: 'cartCount', type: 'number', initial: 0 },
  ],
  models: [
    {
      id: 'task', name: 'Task',
      fields: [
        { name: 'title', type: 'string', required: true, validation: { maxLength: 200 } },
        { name: 'done', type: 'boolean', default: false },
        { name: 'owner', type: 'reference', referenceTo: 'user' },
      ],
      relationships: [{ to: 'user', kind: 'belongsTo', name: 'owner' }],
    },
    { id: 'user', name: 'User', fields: [{ name: 'email', type: 'string', required: true }] },
  ],
  operations: [
    {
      id: 'listTasks', name: 'List tasks', kind: 'list', modelId: 'task',
      input: [{ name: 'filter', type: 'string' }],
      output: { type: 'modelList' },
      auth: 'user',
      mock: { status: 'ok', rows: [{ title: 'Ship 0343', done: false }] },
      errors: [{ code: 'not_authorized', message: 'Sign in first.' }],
    },
    { id: 'completeTask', name: 'Complete task', kind: 'update', modelId: 'task', auth: 'role', role: 'admin' },
  ],
  authProfile: {
    kind: 'email-password',
    roles: ['admin', 'member'],
    guards: [{ screenId: 'tasks', requiresRole: 'member', redirectTo: 'login' }],
  },
  envRequirements: [
    { key: 'API_BASE_URL', purpose: 'Backend origin for the generated client.', requiredFor: ['runtime'] },
  ],
  componentDefinitions: [
    { id: 'task-row', name: 'Task row', root: { type: 'stack', props: { direction: 'horizontal' }, children: [{ type: 'text', props: { text: '{{title}}' } }] } },
  ],
  screens: [
    {
      id: 'login', name: 'Login', route: '/login', isInitial: true, x: 40, y: 60,
      components: [
        { type: 'textInput', props: { label: 'Email', kind: 'email' } },
        {
          type: 'button', props: { label: 'Sign in' },
          actions: [{ on: 'click', kind: 'invoke-operation', operation: 'listTasks', onSuccess: { navigate: 'tasks' }, onError: { setState: { state: 'filter', value: 'all' } } }],
        },
      ],
    },
    {
      id: 'tasks', name: 'Tasks', route: '/tasks', x: 420, y: 60,
      components: [
        {
          type: 'text', props: { text: 'placeholder' },
          bindings: { text: { path: 'state.filter', fallback: 'all', format: 'text' } },
        },
        {
          type: 'list',
          bindings: { items: { path: 'op.listTasks.items', mode: 'one-way' } },
          children: [{ type: 'text', props: { text: '{{title}}' } }],
        },
      ],
    },
  ],
  connectors: [{ from: 'login', to: 'tasks', trigger: 'submit', transition: 'push' }],
  dataSources: [{ id: 'seed', name: 'Seed rows', fields: ['title'], rows: [{ title: 'Alpha' }] }],
});

describe('ADR 0343 — both gates accept the comprehensive document', () => {
  it('the artifact JSON Schema (emit gate) accepts it', () => {
    const v = validateArtifact('canvas.app-builder', comprehensiveDoc());
    expect(v.errors ?? []).toEqual([]);
    expect(v.valid).toBe(true);
  });
  it('validateAppDoc (editor gate) accepts it with zero errors AND zero warnings', () => {
    const v = validateAppDoc(comprehensiveDoc());
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
  });
  it('a pre-0343 document (no new facets) still passes both gates', () => {
    const legacy = { name: 'Old', screens: [{ id: 'home', name: 'Home', isInitial: true, components: [] }] };
    expect(validateArtifact('canvas.app-builder', legacy).valid).toBe(true);
    expect(validateAppDoc(legacy).errors).toEqual([]);
  });
  it('an unknown top-level key is refused by BOTH gates (ABR-GATES-1 — the "vice versa" half)', () => {
    const doc = { ...comprehensiveDoc(), script: 'x' };
    expect(validateArtifact('canvas.app-builder', doc).valid).toBe(false);
    expect(validateAppDoc(doc).errors).toEqual([expect.objectContaining({ path: 'script', code: 'unknown_prop' })]);
  });
});

describe('ADR 0343 — hard structural mirrors (editor gate)', () => {
  const withFacet = (patch: Record<string, unknown>): Record<string, unknown> => ({ ...comprehensiveDoc(), ...patch });
  const errorPaths = (doc: Record<string, unknown>): string[] => validateAppDoc(doc).errors.map((e) => e.path);

  it('rejects a non-\\w state-variable id (the RFC 0124 template-var lesson)', () => {
    expect(errorPaths(withFacet({ stateVariables: [{ id: 'cart-count', type: 'number' }] }))).toContain('stateVariables[0].id');
  });
  it('rejects duplicate ids per facet', () => {
    expect(errorPaths(withFacet({ models: [
      { id: 'task', name: 'A', fields: [{ name: 'x', type: 'string' }] },
      { id: 'task', name: 'B', fields: [{ name: 'y', type: 'string' }] },
    ] }))).toContain('models[1].id');
  });
  it('rejects a reference field without referenceTo, and referenceTo on a non-reference field', () => {
    const paths = errorPaths(withFacet({ models: [{ id: 'm', name: 'M', fields: [
      { name: 'a', type: 'reference' },
      { name: 'b', type: 'string', referenceTo: 'm' },
    ] }] }));
    expect(paths).toContain('models[0].fields[0].referenceTo');
    expect(paths).toContain('models[0].fields[1].referenceTo');
  });
  it('rejects a URL-shaped adapterRef (symbolic ids only — never an endpoint)', () => {
    expect(errorPaths(withFacet({ operations: [{ id: 'o', name: 'O', kind: 'action', adapterRef: 'https://evil.example/hook' }] }))).toContain('operations[0].adapterRef');
  });
  it('rejects an action missing its per-kind required param', () => {
    const doc = withFacet({});
    (doc.screens as Record<string, unknown>[])[0]!.components = [
      { type: 'button', props: { label: 'Go' }, actions: [{ on: 'click', kind: 'navigate' }] },
    ];
    expect(errorPaths(doc).some((p) => p.endsWith('.actions[0].to'))).toBe(true);
  });
  it('rejects a malformed binding path', () => {
    const doc = withFacet({});
    (doc.screens as Record<string, unknown>[])[0]!.components = [
      { type: 'text', props: { text: 'x' }, bindings: { text: { path: 'window.location.href' } } },
    ];
    expect(errorPaths(doc).some((p) => p.endsWith('.bindings.text.path'))).toBe(true);
  });
  it('rejects a lowercase env key', () => {
    expect(errorPaths(withFacet({ envRequirements: [{ key: 'api_key', purpose: 'x' }] }))).toContain('envRequirements[0].key');
  });
  it('counts componentDefinitions trees against the document node budget', () => {
    // Sized so ONLY the shared 2000-node budget can trip: no level exceeds the
    // 200 per-level cap, the screen tree alone is 1510 nodes and the three
    // definitions add 600 (a per-definition budget would never fire).
    const dividers = (n: number): Record<string, unknown>[] => Array.from({ length: n }, () => ({ type: 'divider' }));
    const doc = withFacet({
      componentDefinitions: Array.from({ length: 3 }, (_, i) => ({ id: `d${i}`, name: `D${i}`, root: { type: 'stack', children: dividers(199) } })),
    });
    (doc.screens as Record<string, unknown>[])[0]!.components = Array.from({ length: 10 }, () => ({ type: 'stack', children: dividers(150) }));
    const errs = validateAppDoc(doc).errors;
    expect(errs.some((e) => e.path.startsWith('componentDefinitions[') && e.message.includes('exceeds 2000'))).toBe(true);
    // Positive control: the same screen tree without the definitions is in budget.
    expect(validateAppDoc({ ...doc, componentDefinitions: [] }).errors).toEqual([]);
  });
  it('validates componentDefinitions roots against the closed catalog', () => {
    const doc = withFacet({ componentDefinitions: [{ id: 'x', name: 'X', root: { type: 'holo-deck' } }] });
    expect(validateAppDoc(doc).errors.some((e) => e.code === 'unknown_component_type')).toBe(true);
  });
});

describe('ADR 0343 — soft cross-references (mid-edit states stay saveable)', () => {
  const warnPaths = (doc: Record<string, unknown>): string[] => {
    const v = validateAppDoc(doc);
    expect(v.errors).toEqual([]); // soft means SOFT — the save must not block
    return v.warnings.map((w) => w.path);
  };

  it('an action invoking a missing operation warns, never blocks', () => {
    const doc = comprehensiveDoc();
    (doc.screens as Record<string, unknown>[])[0]!.components = [
      { type: 'button', props: { label: 'Go' }, actions: [{ on: 'click', kind: 'invoke-operation', operation: 'ghostOp' }] },
    ];
    expect(warnPaths(doc).some((p) => p.endsWith('.actions[0].operation'))).toBe(true);
  });
  it('a binding to a missing state variable warns', () => {
    const doc = comprehensiveDoc();
    (doc.screens as Record<string, unknown>[])[1]!.components = [
      { type: 'text', props: { text: 'x' }, bindings: { text: { path: 'state.ghost' } } },
    ];
    expect(warnPaths(doc).some((p) => p.endsWith('.bindings.text.path'))).toBe(true);
  });
  it('model reference / relationship / operation.modelId to a missing model warn', () => {
    const doc = comprehensiveDoc();
    doc.models = [{ id: 'task', name: 'Task', fields: [{ name: 'owner', type: 'reference', referenceTo: 'ghost' }], relationships: [{ to: 'ghost2', kind: 'hasOne' }] }];
    doc.operations = [{ id: 'op1', name: 'Op', kind: 'get', modelId: 'ghost3' }];
    const paths = warnPaths(doc);
    expect(paths).toContain('models[0].fields[0].referenceTo');
    expect(paths).toContain('models[0].relationships[0].to');
    expect(paths).toContain('operations[0].modelId');
  });
  it('auth guards referencing missing screens / undeclared roles warn', () => {
    const doc = comprehensiveDoc();
    doc.authProfile = { kind: 'sso', roles: ['admin'], guards: [{ screenId: 'ghost', requiresRole: 'superuser', redirectTo: 'ghost2' }] };
    const paths = warnPaths(doc);
    expect(paths).toContain('authProfile.guards[0].screenId');
    expect(paths).toContain('authProfile.guards[0].redirectTo');
    expect(paths).toContain('authProfile.guards[0].requiresRole');
  });
});
