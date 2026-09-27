/** ADR 0346 4d — the governed repair loop: nodes (repair/capture/apply-repair),
 *  the surface ops (getDesign / CAS applyRepair), and the registered
 *  app-builder.repair builtin's shape. */
import { describe, it, expect, beforeAll } from 'vitest';
import { buildAppBuilderSurface } from '../surface.js';
import { registerAppBuilderComponents } from '../componentCatalog.js';
import { registerAppBuilderArtifactType } from '../artifactTypes.js';
import { loadArtifactTypePacks } from '../../../host/artifactTypePackLoader.js';
import { validateArtifact } from '../../../host/artifactTypes.js';
import { __putCanvasForTest, getCanvasForTenant } from '../../../host/canvasSurface.js';
import { buildRepairWorkflowDefinition } from '../designWorkflow.js';
import { locateRepoDir } from '../../../host/_repoPath.js';
import { initHostExtPersistence } from '../../../host/hostExtPersistence.js';
import { openStorage } from '../../../storage/index.js';
import { OpenwopError } from '../../../types.js';

type Pack = typeof import('../../../../../../packs/feature.app-builder.nodes/index.mjs');
const pack = (): Promise<Pack> => import('../../../../../../packs/feature.app-builder.nodes/index.mjs');

const T = 't-repair';
const app = (name = 'App'): Record<string, unknown> => ({
  name,
  screens: [{ id: 'home', name: 'Home', isInitial: true, components: [{ type: 'text', props: { text: 'hello' } }] }],
});

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerAppBuilderComponents();
  registerAppBuilderArtifactType();
  loadArtifactTypePacks({ roots: [locateRepoDir(new URL('.', import.meta.url).pathname, 'packs', 'feature.app-builder.artifact-types/pack.json')] });
  await __putCanvasForTest({ canvasId: 'cv1', tenantId: T, canvasTypeId: 'canvas.app-builder', state: app() as never, version: 3 });
});

describe('surface ops', () => {
  const surface = buildAppBuilderSurface({ tenantId: T } as never);
  it('getDesign returns the app + the CAS basis version, tenant-scoped', async () => {
    const res = await surface.getDesign!({ canvasId: 'cv1' }) as { app: { name: string }; version: number };
    expect(res.app.name).toBe('App');
    expect(res.version).toBe(3);
    await expect(buildAppBuilderSurface({ tenantId: 'other' } as never).getDesign!({ canvasId: 'cv1' })).rejects.toThrow();
  });
  it('applyRepair CAS-writes a valid doc; stale version 409s; invalid doc 422s', async () => {
    const repaired = app('App v2');
    const out = await surface.applyRepair!({ canvasId: 'cv1', expectedVersion: 3, app: repaired }) as { newVersion: number };
    expect(out.newVersion).toBe(4);
    expect(((await getCanvasForTenant(T, 'cv1'))!.state as { name: string }).name).toBe('App v2');
    await expect(surface.applyRepair!({ canvasId: 'cv1', expectedVersion: 3, app: repaired }))
      .rejects.toMatchObject({ code: 'canvas_version_conflict' } satisfies Partial<OpenwopError>);
    await expect(surface.applyRepair!({ canvasId: 'cv1', expectedVersion: 4, app: { name: 'X', screens: [{ id: 'a', name: 'A', components: [{ type: 'holo-deck' }] }] } }))
      .rejects.toMatchObject({ code: 'validation_error' });
  });
});

describe('pack nodes', () => {
  it('capture wraps a value into a typed envelope (empty input → no envelope)', async () => {
    const { capture } = await pack();
    const report = { score: 90, findings: [{ code: 'empty_screen', message: 'x' }], summary: 's' };
    const res = capture({ config: { artifactTypeId: 'app.audit', title: 'Quality audit' }, inputs: { value: report } });
    expect(res.outputs.artifact).toMatchObject({ artifactTypeId: 'app.audit', title: 'Quality audit' });
    expect(validateArtifact('app.audit', res.outputs.artifact!.payload).valid).toBe(true);
    expect(capture({ config: { artifactTypeId: 'app.audit' }, inputs: {} }).outputs.artifact).toBeUndefined();
  });
  it('repair reads via the surface, re-normalizes through the render gate, and carries the CAS basis', async () => {
    const { repair } = await pack();
    const fixed = { ...app('Fixed'), screens: [{ id: 'Home Screen!', name: 'Home', isInitial: true, components: [{ type: 'text', props: { text: 'fixed' } }] }] };
    const features = { 'app-builder': { getDesign: async () => ({ app: app(), version: 7 }) } };
    const res = await repair({
      inputs: { canvasId: 'cv1', instructions: 'fix empty_screen' },
      config: {}, features,
      callAI: async () => ({ content: JSON.stringify(fixed) }),
    });
    expect(res.outputs.baseVersion).toBe(7);
    expect(res.outputs.canvasId).toBe('cv1');
    const payload = res.outputs.artifact.payload as { screens: { id: string }[] };
    expect(payload.screens[0]!.id).toBe('home-screen'); // the render gate slug-normalized
    // AI failure = HARD fail (the user asked for a repair; no silent no-op).
    // XCH-APPB-4: the schema/repair machinery must not soften this — an
    // unparseable reply fails after exactly ONE model call (the contract
    // repair never fires on parse failure; the host reliability loop owns it).
    let unparseableCalls = 0;
    await expect(repair({ inputs: { canvasId: 'cv1', instructions: 'x' }, config: {}, features, callAI: async () => { unparseableCalls += 1; return { content: 'not json' }; } }))
      .rejects.toThrow(/repair failed/);
    expect(unparseableCalls).toBe(1);
  });
  it('apply-repair writes through the surface only with the full basis', async () => {
    const { applyDesignRepair } = await pack();
    const calls: unknown[] = [];
    const features = { 'app-builder': { applyRepair: async (a: unknown) => { calls.push(a); return { canvasId: 'cv1', newVersion: 9 }; } } };
    const res = await applyDesignRepair({ inputs: { artifact: { artifactTypeId: 'canvas.app-builder', payload: app() }, canvasId: 'cv1', baseVersion: 8 }, features });
    expect(res.outputs.applied).toEqual({ canvasId: 'cv1', newVersion: 9 });
    expect(calls[0]).toMatchObject({ canvasId: 'cv1', expectedVersion: 8 });
    await expect(applyDesignRepair({ inputs: { canvasId: 'cv1', baseVersion: 8 }, features })).rejects.toThrow(/artifact/);
  });
});

describe('app-builder.repair — registered from the chain pack', () => {
  it('expands with the launch-contract variables and the governed shape', () => {
    const d = buildRepairWorkflowDefinition();
    expect(d.workflowId).toBe('app-builder.repair');
    expect(d.variables?.map((v) => v.name).sort()).toEqual(['canvasId', 'instructions']);
    expect(d.variables?.every((v) => v.required)).toBe(true);
    const types = d.nodes.map((n) => n.typeId);
    expect(types).toEqual([
      'feature.app-builder.nodes.repair',
      'feature.app-builder.nodes.audit',
      'core.approvalGate',
      'feature.app-builder.nodes.apply-repair',
    ]);
    // The apply step fires only AFTER the review gate approves.
    expect((d.edges ?? []).some((e) => e.sourceNodeId.endsWith('_review') && e.targetNodeId.endsWith('_apply'))).toBe(true);
    // Model policy resolved on the repair node; audit stays the primary record.
    const repairNode = d.nodes.find((n) => n.typeId === 'feature.app-builder.nodes.repair');
    expect((repairNode?.config as { provider?: string }).provider).toBeTruthy();
    expect((repairNode?.config as { modelClass?: string }).modelClass).toBeUndefined();
    expect(d.nodes.filter((n) => n.outputRole === 'primary').map((n) => n.typeId)).toEqual(['feature.app-builder.nodes.audit']);
  });
});
