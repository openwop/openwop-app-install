/**
 * ADR 0865 P1 — the run lane's ONE canvas gate (B17–B20) and
 * `ctx.dataIntegration.applyBinding` (B9–B15), witnessed on the booted app, so
 * the canvas types, their validators and the privileged flag are registered by
 * the editor routes exactly as in production. Every assertion below names the
 * decision it witnesses; each mechanism is sabotage-checked (a removed check
 * turns its test red).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../src/index.js';
import { buildHostSurfaceBundle, type BundleScope } from '../src/host/inMemorySurfaces.js';
import {
  createCanvasForTenant,
  getCanvasForTenant,
  listCanvasVersions,
  restoreCanvasVersion,
  updateCanvasForTenant,
} from '../src/host/canvasSurface.js';
import { isPrivilegedCanvasType, registerCanvasTypeOwner } from '../src/host/canvasTypeOwnership.js';
import { onCanvasStateWrite, __resetCanvasLifecycleHooks } from '../src/host/canvasLifecycle.js';
import { createMember, createWorkspace } from '../src/host/accessControlService.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { makeDataIntegrationAdapter } from '../src/host/dataIntegrationAdapter.js';
import { OpenwopError } from '../src/types.js';
import { createProject, setProjectVisibility } from '../src/features/projects/projectsService.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));

type CanvasApi = {
  read(id: string): Promise<{ state: Record<string, unknown>; version: number }>;
  write(id: string, m: Record<string, unknown>, o?: Record<string, unknown>): Promise<{ newVersion: number }>;
  create(a: Record<string, unknown>): Promise<{ canvasId: string }>;
};

let WS: string;
const MEMBER = 'oidc:adr0865-member';
const VIEWER = 'oidc:adr0865-viewer';
const OTHER = 'oidc:adr0865-other';

const canvasOf = (scope: BundleScope): CanvasApi => (buildHostSurfaceBundle(scope) as unknown as { canvas: CanvasApi }).canvas;
const bindingOf = (scope: BundleScope) => makeDataIntegrationAdapter({ runId: scope.runId ?? 'r', tenantId: scope.tenantId, canvasScope: scope });
const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try { await p; return undefined; } catch (err) { return (err as { code?: string }).code; }
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  const ws = await createWorkspace({ name: 'ADR 0865', ownerSubject: 'oidc:adr0865-founder' });
  WS = ws.tenantId;
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Member', subject: MEMBER, roles: ['editor'] });
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Viewer', subject: VIEWER, roles: ['viewer'] });
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Other', subject: OTHER, roles: ['editor'] });
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { __resetCanvasLifecycleHooks(); });

/** A canvas owned by a PRIVATE project OTHER created: the membership-scoped
 *  owner kind (a `user` owner has no access resolver here; the org gate decides). */
async function privateCanvas(state: Record<string, unknown>): Promise<{ canvasId: string }> {
  const project = await createProject(WS, WS, { name: `private-${Math.random()}` }, OTHER);
  await setProjectVisibility(WS, project.id, 'private');
  return createCanvasForTenant(WS, { canvasTypeId: 'doc', initialState: state, ownerSubject: { kind: 'project', id: project.id } });
}

const member = (): BundleScope => ({ tenantId: WS, runId: 'run-member', actingUserId: MEMBER });

describe('ADR 0865 B17 — the run-lane canvas gate (ctx.canvas)', () => {
  it('24: a Viewer\'s run cannot write; an editor\'s can (the role floor)', async () => {
    const c = await createCanvasForTenant(WS, { canvasTypeId: 'doc', initialState: { a: 1 } });
    expect(await codeOf(canvasOf({ tenantId: WS, actingUserId: VIEWER }).write(c.canvasId, { a: 2 }))).toBe('forbidden_scope');
    expect((await canvasOf({ tenantId: WS, actingUserId: VIEWER }).read(c.canvasId)).state).toEqual({ a: 1 }); // read is still allowed
    expect((await canvasOf(member()).write(c.canvasId, { a: 2 })).newVersion).toBe(2);
  });

  it('25: a private project\'s canvas answers a non-member reader the SAME canvas_not_found as a missing id', async () => {
    // ADR 0054 D5: write authority is `workspace:write` and project visibility
    // never removes it, so the reader a private project hides from is a Viewer
    // who is not a project member, and a run with no person at all.
    const priv = await privateCanvas({ secret: 1 });
    const org = await createCanvasForTenant(WS, { canvasTypeId: 'doc', initialState: { open: 1 } });
    const asViewer = canvasOf({ tenantId: WS, actingUserId: VIEWER });
    expect((await asViewer.read(org.canvasId)).state).toEqual({ open: 1 });
    expect(await codeOf(asViewer.read(priv.canvasId))).toBe('canvas_not_found');
    expect(await codeOf(asViewer.read('canvas-does-not-exist'))).toBe('canvas_not_found');
    expect(await codeOf(canvasOf({ tenantId: WS, runId: 'run-system' }).read(priv.canvasId))).toBe('canvas_not_found');
    // ...while the project's own writers read it.
    expect((await canvasOf({ tenantId: WS, actingUserId: OTHER }).read(priv.canvasId)).state).toEqual({ secret: 1 });
  });

  it('26: a privileged type is refused on the run lane, and the editor registration marks KickTodo\'s outline privileged', async () => {
    expect(isPrivilegedCanvasType('canvas.challenge-outline')).toBe(true);
    registerCanvasTypeOwner('test.adr0865-privileged', 'drawings', { privileged: true });
    const c = await createCanvasForTenant(WS, { canvasTypeId: 'test.adr0865-privileged', initialState: {} });
    const err = await canvasOf(member()).write(c.canvasId, { x: 1 }).catch((e: unknown) => e as { code?: string; blockedBy?: string });
    expect(err).toMatchObject({ code: 'host_capability_disabled', blockedBy: 'privileged' });
    expect((await getCanvasForTenant(WS, c.canvasId))?.version).toBe(1);
  });

  it('27: a catalog-invalid write and create are validation_error, and nothing changes', async () => {
    const valid = { title: 't', width: 100, height: 100, shapes: [{ kind: 'rect', x: 1, y: 2, width: 3, height: 4 }] };
    const c = await createCanvasForTenant(WS, { canvasTypeId: 'canvas.drawing', initialState: valid });
    const surf = canvasOf(member());
    expect(await codeOf(surf.write(c.canvasId, { rogueTopLevel: true }))).toBe('validation_error');
    expect((await getCanvasForTenant(WS, c.canvasId))?.state).toEqual(valid);
    expect(await codeOf(surf.create({ canvasTypeId: 'canvas.drawing', initialState: { ...valid, shapes: [{ kind: 'hyperbolic-manifold' }] } }))).toBe('validation_error');
    expect((await surf.write(c.canvasId, { title: 'renamed' })).newVersion).toBe(2); // a valid one still lands
  });

  it('28: the live-room veto refuses a ctx.canvas.write', async () => {
    const c = await createCanvasForTenant(WS, { canvasTypeId: 'doc', initialState: { a: 1 } });
    onCanvasStateWrite('adr0865-veto', { before: async (e) => { if (e.canvasId === c.canvasId) throw new OpenwopError('canvas_room_live', 'live', 409, { canvasId: c.canvasId }); } });
    expect(await codeOf(canvasOf(member()).write(c.canvasId, { a: 2 }))).toBe('canvas_room_live');
    expect((await getCanvasForTenant(WS, c.canvasId))?.version).toBe(1);
  });

  it('29: a run with no person still writes an org-owned canvas (ADR 0837 floor), but never a private one', async () => {
    const org = await createCanvasForTenant(WS, { canvasTypeId: 'doc', initialState: { a: 1 } });
    const priv = await privateCanvas({ a: 1 });
    const system = canvasOf({ tenantId: WS, runId: 'run-system' });
    expect((await system.write(org.canvasId, { a: 2 })).newVersion).toBe(2);
    expect(await codeOf(system.write(priv.canvasId, { a: 2 }))).toBe('canvas_not_found');
  });
});

describe('ADR 0865 B9–B15 — applyBinding', () => {
  const bind = (scope: BundleScope, args: Record<string, unknown>) => bindingOf(scope).applyBinding({ targetType: 'canvas.state', ...args });

  it('10: writes at a JSON Pointer with previous and resolved values; an identical apply is applied:false with no version bump', async () => {
    const c = await createCanvasForTenant(WS, { canvasTypeId: 'doc', initialState: { sections: [{ title: 'old' }] } });
    const r = await bind(member(), { canvasId: c.canvasId, targetPath: '/sections/0/title', value: 'new' });
    expect(r).toEqual({ applied: true, previousValue: 'old', resolvedValue: 'new' });
    expect((await getCanvasForTenant(WS, c.canvasId))?.state).toEqual({ sections: [{ title: 'new' }] });
    const again = await bind(member(), { canvasId: c.canvasId, targetPath: '/sections/0/title', value: 'new' });
    expect(again).toEqual({ applied: false, previousValue: 'new', resolvedValue: 'new' });
    expect((await getCanvasForTenant(WS, c.canvasId))?.version).toBe(2);
    // a missing intermediate object is created; an array index past the end is refused
    await bind(member(), { canvasId: c.canvasId, targetPath: '/meta/owner', value: 'x', preserveUndo: false });
    expect((await getCanvasForTenant(WS, c.canvasId))?.state.meta).toEqual({ owner: 'x' });
    expect(await codeOf(bind(member(), { canvasId: c.canvasId, targetPath: '/sections/5/title', value: 'x' }))).toBe('validation_error');
    expect(await codeOf(bind(member(), { canvasId: c.canvasId, targetPath: '/__proto__/polluted', value: 'x' }))).toBe('validation_error');
  });

  it('11: a canvas the run may not see, another tenant\'s, and a missing one all answer binding_target_not_found', async () => {
    const priv = await privateCanvas({});
    const foreign = await createCanvasForTenant('t-adr0865-foreign', { canvasTypeId: 'doc', initialState: {} });
    const system: BundleScope = { tenantId: WS, runId: 'run-system' };
    expect(await codeOf(bind(system, { canvasId: priv.canvasId, targetPath: '/a', value: 1 }))).toBe('binding_target_not_found');
    for (const canvasId of [foreign.canvasId, 'canvas-missing']) {
      expect(await codeOf(bind(member(), { canvasId, targetPath: '/a', value: 1 }))).toBe('binding_target_not_found');
    }
    expect((await getCanvasForTenant(WS, priv.canvasId))?.version).toBe(1);
  });

  it('25: decoded pointer keys round-trip; root, malformed escapes and noncanonical array indices leave state intact', async () => {
    const c = await createCanvasForTenant(WS, { canvasTypeId: 'doc', initialState: { 'a/b': { '~key': 'old' }, items: ['one'] } });
    await bind(member(), { canvasId: c.canvasId, targetPath: '/a~1b/~0key', value: 'new' });
    expect((await getCanvasForTenant(WS, c.canvasId))?.state['a/b']).toEqual({ '~key': 'new' });
    const before = await getCanvasForTenant(WS, c.canvasId);
    for (const targetPath of ['', '/bad~2escape', '/items/01', '/items/-', '/items/-1', '/constructor/prototype/value']) {
      expect(await codeOf(bind(member(), { canvasId: c.canvasId, targetPath, value: 'bad' }))).toBe('validation_error');
    }
    expect(await getCanvasForTenant(WS, c.canvasId)).toEqual(before);
  });

  it('28+29: a real competing canvas write is reapplied, and undo captures that new prior version inside the throttle window', async () => {
    const c = await createCanvasForTenant(WS, { canvasTypeId: 'doc', initialState: { a: 'original' } });
    let competed = false;
    onCanvasStateWrite('adr0865-cas-race', { before: async (e) => {
      if (e.canvasId !== c.canvasId || competed) return;
      competed = true;
      await updateCanvasForTenant(WS, c.canvasId, { a: 'concurrent', unrelated: 'preserved' }, { merge: 'replace' });
    } });
    expect(await bind(member(), { canvasId: c.canvasId, targetPath: '/a', value: 'bound' })).toEqual({ applied: true, previousValue: 'concurrent', resolvedValue: 'bound' });
    expect((await getCanvasForTenant(WS, c.canvasId))?.state).toEqual({ a: 'bound', unrelated: 'preserved' });
    const versions = await listCanvasVersions(WS, c.canvasId);
    const prior = versions.find((v) => v.version === 2);
    expect(prior).toBeDefined();
    expect(versions.some((v) => v.version === 1)).toBe(true);
    await restoreCanvasVersion(WS, c.canvasId, prior!.versionId, 'review');
    expect((await getCanvasForTenant(WS, c.canvasId))?.state).toEqual({ a: 'concurrent', unrelated: 'preserved' });
  });

  it('12: a Viewer\'s run is refused with the role floor\'s own code', async () => {
    const c = await createCanvasForTenant(WS, { canvasTypeId: 'doc', initialState: {} });
    expect(await codeOf(bind({ tenantId: WS, actingUserId: VIEWER }, { canvasId: c.canvasId, targetPath: '/a', value: 1 }))).toBe('forbidden_scope');
  });

  it('13: the live-room veto refuses a binding and is never retried as a race', async () => {
    const c = await createCanvasForTenant(WS, { canvasTypeId: 'doc', initialState: { a: 1 } });
    let calls = 0;
    onCanvasStateWrite('adr0865-veto-bind', { before: async (e) => { if (e.canvasId === c.canvasId) { calls++; throw new OpenwopError('canvas_room_live', 'live', 409, { canvasId: c.canvasId }); } } });
    expect(await codeOf(bind(member(), { canvasId: c.canvasId, targetPath: '/a', value: 2, preserveUndo: false }))).toBe('canvas_room_live');
    expect(calls).toBe(1);
  });

  it('14: preserveUndo captures the PRIOR state, and restoring it is the undo; a failed capture leaves the canvas unwritten', async () => {
    const c = await createCanvasForTenant(WS, { canvasTypeId: 'doc', initialState: { a: 'before' } });
    await bind(member(), { canvasId: c.canvasId, targetPath: '/a', value: 'after' });
    const versions = await listCanvasVersions(WS, c.canvasId);
    const prior = versions.find((v) => v.version === 1);
    expect(prior?.capturedBy).toBe('binding:run-member');
    await restoreCanvasVersion(WS, c.canvasId, prior!.versionId, 'test');
    expect((await getCanvasForTenant(WS, c.canvasId))?.state).toEqual({ a: 'before' });

    const d = await createCanvasForTenant(WS, { canvasTypeId: 'doc', initialState: { a: 'kept' } });
    const realPut = DurableCollection.prototype.put;
    vi.spyOn(DurableCollection.prototype, 'put').mockImplementation(function (this: { name: string }, ...args: unknown[]) {
      if (this.name === 'canvas:version') return Promise.reject(new Error('version store down'));
      return (realPut as (...a: unknown[]) => Promise<void>).apply(this, args);
    });
    expect(await codeOf(bind(member(), { canvasId: d.canvasId, targetPath: '/a', value: 'lost' }))).toBe('binding_undo_unavailable');
    vi.restoreAllMocks();
    expect((await getCanvasForTenant(WS, d.canvasId))?.state).toEqual({ a: 'kept' });
  });

  it('21 (review B9): escapes decode, prototype segments are refused after decoding, and no write changes a container\'s shape', async () => {
    const c = await createCanvasForTenant(WS, { canvasTypeId: 'doc', initialState: { list: [{ x: 1 }, 2], obj: {} } });
    const at = (targetPath: string, value: unknown = 'v') => bind(member(), { canvasId: c.canvasId, targetPath, value, preserveUndo: false });
    await at('/obj/a~1b', 'slash');
    await at('/obj/a~0b', 'tilde');
    expect((await getCanvasForTenant(WS, c.canvasId))?.state.obj).toEqual({ 'a/b': 'slash', 'a~b': 'tilde' });
    for (const bad of ['', '/__proto__/polluted', '/obj/constructor/prototype/polluted', '/obj/prototype', '/list/-', '/list/x', '/list/01', '/list/1/x', '/obj/~2', '/obj/~']) {
      expect(await codeOf(at(bad)), bad).toBe('validation_error');
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    await at('/list/1', 'replaced');
    const state = (await getCanvasForTenant(WS, c.canvasId))!.state;
    expect(Array.isArray(state.list)).toBe(true);
    expect(state.list).toEqual([{ x: 1 }, 'replaced']);
  });

  it('22 (review B11): an intervening write wins the first CAS; the retry recomputes from the new state and keeps THAT state as undo', async () => {
    const c = await createCanvasForTenant(WS, { canvasTypeId: 'doc', initialState: { a: 'before', b: 'b0' } });
    let intervened = false;
    onCanvasStateWrite('adr0865-intervene', { before: async (e) => {
      if (e.canvasId !== c.canvasId || intervened) return;
      intervened = true;
      await updateCanvasForTenant(WS, c.canvasId, { a: 'theirs', b: 'b1' }, { merge: 'replace' });
    } });
    const r = await bind(member(), { canvasId: c.canvasId, targetPath: '/a', value: 'mine' });
    expect(r).toEqual({ applied: true, previousValue: 'theirs', resolvedValue: 'mine' });
    const after = (await getCanvasForTenant(WS, c.canvasId))!;
    expect(after.state).toEqual({ a: 'mine', b: 'b1' });
    const undo = (await listCanvasVersions(WS, c.canvasId)).find((v) => v.version === after.version - 1);
    expect(undo?.capturedBy).toBe('binding:run-member');
    await restoreCanvasVersion(WS, c.canvasId, undo!.versionId, 'test');
    expect((await getCanvasForTenant(WS, c.canvasId))?.state).toEqual({ a: 'theirs', b: 'b1' });

    // A writer that always wins: the binding gives up with the race's code after
    // a bounded number of attempts, and never reports applied.
    const d = await createCanvasForTenant(WS, { canvasTypeId: 'doc', initialState: { n: 0 } });
    let wins = 0;
    let busy = false;
    onCanvasStateWrite('adr0865-always', { before: async (e) => {
      if (e.canvasId !== d.canvasId || busy) return;
      busy = true;
      try { await updateCanvasForTenant(WS, d.canvasId, { n: ++wins }, { merge: 'replace' }); } finally { busy = false; }
    } });
    expect(await codeOf(bind(member(), { canvasId: d.canvasId, targetPath: '/m', value: 'x', preserveUndo: false }))).toBe('canvas_version_conflict');
    expect(wins).toBe(8);
    expect((await getCanvasForTenant(WS, d.canvasId))?.state).toEqual({ n: 8 });
  });

  it('23 (review B12): two bindings inside the snapshot throttle window both keep their prior state; a capture that silently did not persist stops the write', async () => {
    const c = await createCanvasForTenant(WS, { canvasTypeId: 'doc', initialState: { a: 'zero' } });
    await bind(member(), { canvasId: c.canvasId, targetPath: '/a', value: 'one' });
    await bind(member(), { canvasId: c.canvasId, targetPath: '/a', value: 'two' });
    const v2 = (await listCanvasVersions(WS, c.canvasId)).find((v) => v.version === 2);
    expect(v2?.capturedBy).toBe('binding:run-member');
    await restoreCanvasVersion(WS, c.canvasId, v2!.versionId, 'test');
    expect((await getCanvasForTenant(WS, c.canvasId))?.state).toEqual({ a: 'one' });

    const d = await createCanvasForTenant(WS, { canvasTypeId: 'doc', initialState: { a: 'kept' } });
    const realPut = DurableCollection.prototype.put;
    vi.spyOn(DurableCollection.prototype, 'put').mockImplementation(function (this: { name: string }, ...args: unknown[]) {
      if (this.name === 'canvas:version') return Promise.resolve(); // "succeeds", stores nothing
      return (realPut as (...a: unknown[]) => Promise<void>).apply(this, args);
    });
    expect(await codeOf(bind(member(), { canvasId: d.canvasId, targetPath: '/a', value: 'lost' }))).toBe('binding_undo_unavailable');
    vi.restoreAllMocks();
    expect((await getCanvasForTenant(WS, d.canvasId))?.state).toEqual({ a: 'kept' });
  });

  it('15: a throwing transform fails with its own code and never falls back; a null result does', async () => {
    const c = await createCanvasForTenant(WS, { canvasTypeId: 'doc', initialState: {} });
    expect(await codeOf(bind(member(), { canvasId: c.canvasId, targetPath: '/a', value: 1, transform: '$error("boom")', fallback: 'fb' }))).toBe('expression_failed');
    expect((await getCanvasForTenant(WS, c.canvasId))?.version).toBe(1);
    const r = await bind(member(), { canvasId: c.canvasId, targetPath: '/a', value: { n: 2 }, transform: 'n * 10', preserveUndo: false });
    expect(r.resolvedValue).toBe(20);
    const fb = await bind(member(), { canvasId: c.canvasId, targetPath: '/b', value: null, fallback: 'fb', preserveUndo: false });
    expect(fb.resolvedValue).toBe('fb');
  });

  it('16: batched is unsupported_operation; an unknown targetType is validation_error', async () => {
    const c = await createCanvasForTenant(WS, { canvasTypeId: 'doc', initialState: {} });
    expect(await codeOf(bind(member(), { canvasId: c.canvasId, targetPath: '/a', value: 1, updateMode: 'batched' }))).toBe('unsupported_operation');
    expect(await codeOf(bindingOf(member()).applyBinding({ targetType: 'element', canvasId: c.canvasId, targetPath: '/a', value: 1 }))).toBe('validation_error');
  });

  it('17: the binding runs the SAME registered validator as the editor (a catalog-invalid value is refused)', async () => {
    const valid = { title: 't', width: 100, height: 100, shapes: [{ kind: 'rect', x: 1, y: 2, width: 3, height: 4 }] };
    const c = await createCanvasForTenant(WS, { canvasTypeId: 'canvas.drawing', initialState: valid });
    expect(await codeOf(bind(member(), { canvasId: c.canvasId, targetPath: '/shapes', value: [{ kind: 'hyperbolic-manifold' }] }))).toBe('validation_error');
    expect((await getCanvasForTenant(WS, c.canvasId))?.state).toEqual(valid);
  });

  it('the pack\'s own node: applied is the host\'s answer, never the pack\'s default', async () => {
    const pack = (await import(pathToFileURL(join(HERE, '..', '..', '..', 'packs', 'vendor.myndhyve.data-integration', 'index.mjs')).href)) as {
      bindingApply: (ctx: Record<string, unknown>) => Promise<{ status: string; outputs: Record<string, unknown> }>;
    };
    const c = await createCanvasForTenant(WS, { canvasTypeId: 'doc', initialState: { a: 1 } });
    const ctx = (value: unknown) => ({ runId: 'run-member', nodeId: 'n', config: {}, inputs: { targetType: 'canvas.state', targetPath: '/a', value, canvasId: c.canvasId }, dataIntegration: bindingOf(member()) });
    expect((await pack.bindingApply(ctx(2))).outputs).toEqual({ applied: true, previousValue: 1, resolvedValue: 2 });
    expect((await pack.bindingApply(ctx(2))).outputs).toMatchObject({ applied: false });
  });
});
