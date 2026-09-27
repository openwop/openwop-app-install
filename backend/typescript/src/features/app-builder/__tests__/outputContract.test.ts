/** ADR 0348 6b/6c/6d — export preflight, lineage, and OpenAPI generation. */
import { describe, it, expect, beforeAll } from 'vitest';
import { preflightExport } from '../export/preflight.js';
import { generateOpenApi } from '../export/openapiGen.js';
import { generateScrubbed } from '../export/exportService.js';
import { appendExportLineage, listExportLineage, registerExportLineageCleanup } from '../export/lineage.js';
import { buildAppBuilderSurface } from '../surface.js';
import { registerAppBuilderComponents } from '../componentCatalog.js';
import { fireCanvasDeleted, __resetCanvasLifecycleHooks } from '../../../host/canvasLifecycle.js';
import { initHostExtPersistence } from '../../../host/hostExtPersistence.js';
import { openStorage } from '../../../storage/index.js';

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

const design = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'Contract',
  screens: [{
    id: 'home', name: 'Home', isInitial: true,
    components: [
      { type: 'button', props: { label: 'Go' }, actions: [{ on: 'click', kind: 'set-state', state: 'x', value: 1 }] },
      { type: 'text', props: { text: 'p', hideOn: 'mobile' }, bindings: { text: { path: 'state.x' } } },
    ],
  }],
  models: [{ id: 'task', name: 'Task', fields: [{ name: 'title', type: 'string', required: true }, { name: 'due', type: 'date' }] }],
  operations: [
    { id: 'listTasks', name: 'List tasks', kind: 'list', modelId: 'task', input: [{ name: 'filter', type: 'string' }], output: { type: 'modelList' }, auth: 'user' },
    { id: 'createTask', name: 'Create task', kind: 'create', modelId: 'task', input: [{ name: 'title', type: 'string', required: true }], output: { type: 'model' } },
  ],
  ...extra,
});

describe('preflight (6b)', () => {
  it('names exactly what a target drops — actions, bindings, app contract, responsive', () => {
    const notes = preflightExport(design(), 'flutter');
    const codes = notes.map((n) => n.code).sort();
    expect(codes).toEqual(['actions_not_generated', 'bindings_not_generated', 'hideOn_not_generated', 'models_not_generated', 'operations_not_generated']);
  });
  it('a design using only generated semantics preflights clean', () => {
    const clean = { name: 'C', screens: [{ id: 'a', name: 'A', components: [{ type: 'text', props: { text: 'x' } }] }] };
    expect(preflightExport(clean, 'react-tailwind')).toEqual([]);
  });
  it('hideOn preflights clean on targets that map it', () => {
    const notes = preflightExport(design({ models: [], operations: [] }), 'react-styled');
    expect(notes.map((n) => n.code)).not.toContain('hideOn_not_generated');
  });
});

describe('openapi generation (6d)', () => {
  it('emits schemas from models and kind-idiomatic paths with source refs', () => {
    const doc = generateOpenApi(design())!;
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> }).schemas;
    expect(schemas.task).toMatchObject({ 'x-openwop-source': 'models[task]' });
    expect((schemas.task.properties as Record<string, unknown>).due).toEqual({ type: 'string', format: 'date-time' });
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;
    expect(paths['/operations/listTasks']!.get).toMatchObject({ operationId: 'listTasks', 'x-openwop-source': 'operations[listTasks]' });
    expect(paths['/operations/listTasks']!.get!.security).toEqual([{ appAuth: [] }]);
    expect(paths['/operations/createTask']!.post).toBeTruthy();
  });
  it('no operations → no document (never a dead openapi.json)', () => {
    expect(generateOpenApi({ name: 'X', screens: [] })).toBeNull();
  });
  it('openapi.json ships inside the export bundle when declared', () => {
    const { files, preflight } = generateScrubbed(design(), 'react-tailwind');
    expect(files.some((f) => f.path === 'openapi.json')).toBe(true);
    expect(preflight.some((n) => n.code === 'operations_not_generated')).toBe(true); // still honest about runtime
  });
});

const entry = (n: number) => ({ canvasVersion: n, target: 'react-tailwind', fileCount: 3, sizeBytes: 100, hash: `h${n}`, assetToken: `t${n}`, exportedAt: '2026-07-10T00:00:00Z', warningCount: 0 });

describe('export lineage (6c — side collection, never a canvas version bump)', () => {
  it('appends per canvas, tenant-scoped, capped', async () => {
    await appendExportLineage('tA', 'cv1', entry(1));
    await appendExportLineage('tA', 'cv1', entry(2));
    await appendExportLineage('tB', 'cv1', entry(9));
    const a = await listExportLineage('tA', 'cv1');
    expect(a.map((e) => e.hash)).toEqual(['h1', 'h2']);
    expect((await listExportLineage('tB', 'cv1')).map((e) => e.hash)).toEqual(['h9']);
    expect(await listExportLineage('tA', 'ghost')).toEqual([]);
  });

  it('concurrent appends keep EVERY entry — CAS, not get→put (grade pass AB-DATA-4)', async () => {
    // With a plain read-modify-write both reads see the same base row and the
    // second put erases the first entry; the CAS loop makes the loser retry.
    await Promise.all([1, 2, 3, 4].map((n) => appendExportLineage('tCAS', 'cv1', entry(n))));
    const hashes = (await listExportLineage('tCAS', 'cv1')).map((e) => e.hash).sort();
    expect(hashes).toEqual(['h1', 'h2', 'h3', 'h4']);
  });
});

describe('export lineage lifecycle (grade pass AB-DATA-1 — no orphan on canvas delete)', () => {
  it('deleting an app-builder canvas purges its lineage; other tenants/types untouched', async () => {
    __resetCanvasLifecycleHooks();
    registerExportLineageCleanup();
    await appendExportLineage('tC', 'cvX', entry(1));
    await appendExportLineage('tD', 'cvX', entry(2));
    await fireCanvasDeleted({ tenantId: 'tC', canvasId: 'cvX', canvasTypeId: 'canvas.app-builder' });
    expect(await listExportLineage('tC', 'cvX')).toEqual([]);
    expect((await listExportLineage('tD', 'cvX')).map((e) => e.hash)).toEqual(['h2']);
    // A non-app-builder canvas delete never touches app-builder lineage.
    await appendExportLineage('tC', 'cvY', entry(3));
    await fireCanvasDeleted({ tenantId: 'tC', canvasId: 'cvY', canvasTypeId: 'canvas.document' });
    expect((await listExportLineage('tC', 'cvY')).map((e) => e.hash)).toEqual(['h3']);
  });
});

describe('surface export structural gate (grade pass AB-CODE-6 — the F11 security fix, now tested)', () => {
  it('an inline app with a too-deep tree 422s instead of RangeError-ing into a 500', async () => {
    registerAppBuilderComponents();
    let node: Record<string, unknown> = { type: 'text', props: { text: 'leaf' } };
    for (let i = 0; i < 24; i++) node = { type: 'stack', props: {}, children: [node] };
    const deep = { name: 'Deep', screens: [{ id: 'home', name: 'Home', isInitial: true, components: [node] }] };
    const surface = buildAppBuilderSurface({ tenantId: 'tE' } as never);
    await expect(surface.export!({ target: 'react-tailwind', app: deep })).rejects.toThrow(/structurally invalid/);
  });
  it('an array is not an inline app model (the applyRepair guard, mirrored)', async () => {
    const surface = buildAppBuilderSurface({ tenantId: 'tE' } as never);
    await expect(surface.export!({ target: 'react-tailwind', app: [] })).rejects.toThrow();
  });
});

describe('video src safety (5b review V1/V2 — the F4 safeUrl posture)', () => {
  const vid = (src: string | undefined) => ({
    name: 'V', screens: [{ id: 'home', name: 'Home', isInitial: true, components: [{ type: 'video', props: { ...(src !== undefined ? { src } : {}), caption: 'Tour', hideOn: 'mobile' } }] }],
  });
  it('a javascript: src is dropped to the placeholder on every markup target', () => {
    for (const target of ['html-css', 'react-tailwind', 'react-styled'] as const) {
      const { files } = generateScrubbed(vid('javascript:alert(1)'), target);
      const all = files.map((f) => f.content).join('\n');
      expect(all).not.toContain('javascript:');
      expect(all).not.toContain('<video');
    }
  });
  it('the empty-src placeholder still honors hideOn (html + tailwind)', () => {
    const html = generateScrubbed(vid(undefined), 'html-css').files.map((f) => f.content).join('\n');
    expect(html).toMatch(/videobox-empty[^"]*hide-mobile/);
    const tw = generateScrubbed(vid(undefined), 'react-tailwind').files.map((f) => f.content).join('\n');
    expect(tw).toMatch(/aspect-video[^"]*max-sm:hidden|max-sm:hidden[^"]*aspect-video/);
  });
});
