/** ADR 0951 P2.5 restores the toggle write seam (removed whole by ADR 0734
 * because the old status listener fired only on a global `status` change). It
 * must fire after EVERY stored write, carry the tenant on tenant-scoped writes,
 * and a failing listener must never fail the toggle write. ADR 0951 P2 review
 * #1: the write carries what was written, and an intent runs before the store
 * write, so a listener never has to re-read live state to learn what happened. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerToggleDefault, __resetToggleDefaults } from '../src/host/featureToggles/registry.js';
import {
  deleteConfig, disableTenantOverride, enableTenantOverride, getStoredConfig, purgeTenantOverrides,
  registerToggleWriteIntent, registerToggleWriteListener, resolveWrittenToggle, retireToggleOverrides, saveConfig,
  type ToggleWrite,
} from '../src/host/featureToggles/service.js';
import type { ToggleConfig } from '../src/host/featureToggles/types.js';

let storage: Storage;
let dir: string;
let calls: Array<{ ids: string[]; tenantId?: string }>;
const DEF: ToggleConfig = { id: 'listener.witness', label: 'Witness', description: 'x', category: 'CRM', status: 'off', bucketUnit: 'tenant', salt: 'listener.witness' };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'owp-toggle-listener-'));
  storage = await openStorage(`sqlite://${join(dir, 'store.db')}`);
  initHostExtPersistence(storage);
  registerToggleDefault(DEF);
  calls = [];
  registerToggleWriteListener('witness', async (w) => { calls.push({ ids: [...w.ids], ...(w.tenantId ? { tenantId: w.tenantId } : {}) }); });
});
afterEach(async () => {
  registerToggleWriteListener('witness', async () => {});
  registerToggleWriteListener('witness-failing', async () => {});
  __resetToggleDefaults();
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('feature toggle write seam (ADR 0951 P2.5)', () => {
  it('fires after every stored write path, with the tenant on tenant-scoped writes', async () => {
    await saveConfig({ ...DEF, status: 'on' }, 'test');
    expect(await disableTenantOverride(DEF.id, 'tenant-a', 'test')).toBe('disabled');
    expect(await enableTenantOverride(DEF.id, 'tenant-a', 'test')).toBe('enabled');
    expect(await purgeTenantOverrides('tenant-a')).toEqual([DEF.id]);
    await deleteConfig(DEF.id, 'test');
    await saveConfig({ ...DEF, status: 'on' }, 'test');
    expect(await retireToggleOverrides([DEF.id])).toEqual([DEF.id]);
    expect(calls).toEqual([
      { ids: [DEF.id] },
      { ids: [DEF.id], tenantId: 'tenant-a' },
      { ids: [DEF.id], tenantId: 'tenant-a' },
      { ids: [DEF.id], tenantId: 'tenant-a' },
      { ids: [DEF.id] },
      { ids: [DEF.id] },
      { ids: [DEF.id] },
    ]);
  });

  it('a no-op write does not fire, and a failing listener does not fail the write', async () => {
    expect(await retireToggleOverrides([DEF.id])).toEqual([]);
    expect(await disableTenantOverride(DEF.id, 'tenant-a', 'test')).toBe('already-off');
    expect(calls).toEqual([]);
    registerToggleWriteListener('witness-failing', async () => { throw new Error('listener down'); });
    await saveConfig({ ...DEF, status: 'on' }, 'test');
    expect((await getStoredConfig(DEF.id))?.status).toBe('on');
    expect(calls).toEqual([{ ids: [DEF.id] }]);
  });
});

describe('feature toggle write seam budget', () => {
  it('a slow listener cannot hold the toggle write past its budget, and still completes', async () => {
    const { TOGGLE_WRITE_LISTENER_BUDGET_MS } = await import('../src/host/featureToggles/service.js');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let release!: () => void;
    let finished = false;
    registerToggleWriteListener('witness-failing', () => new Promise<void>((r) => { release = () => { finished = true; r(); }; }));
    let saved = false;
    const write = saveConfig({ ...DEF, status: 'on' }, 'test').then(() => { saved = true; });
    // Not vi.waitFor: under fake timers it advances the clock it polls with.
    for (let i = 0; i < 200 && !release; i++) await new Promise<void>((r) => { setImmediate(r); });
    expect(release).toBeTypeOf('function');
    await vi.advanceTimersByTimeAsync(TOGGLE_WRITE_LISTENER_BUDGET_MS - 1);
    expect(saved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await write;
    expect(saved).toBe(true);
    expect(finished).toBe(false);
    release();
    expect(finished).toBe(true);
    vi.useRealTimers();
  });
});

describe('feature toggle write seam carries the write (ADR 0951 P2 review #1)', () => {
  afterEach(() => { registerToggleWriteIntent('witness', { prepare: async () => {} }); });

  it('the intent runs BEFORE the row is stored, and the listener gets the same write with the stored row', async () => {
    const seen: Array<{ phase: string; writeId: string; storedStatus: string | null; written: string | null | undefined }> = [];
    registerToggleWriteIntent('witness', { prepare: async (w) => {
      seen.push({ phase: 'prepare', writeId: w.writeId, storedStatus: (await getStoredConfig(DEF.id))?.status ?? null, written: w.rows[DEF.id]?.status });
    } });
    registerToggleWriteListener('witness', async (w) => {
      seen.push({ phase: 'after', writeId: w.writeId, storedStatus: (await getStoredConfig(DEF.id))?.status ?? null, written: w.rows[DEF.id]?.status });
    });
    await saveConfig({ ...DEF, status: 'on' }, 'test');
    expect(seen).toEqual([
      { phase: 'prepare', writeId: seen[0]!.writeId, storedStatus: null, written: 'on' },
      { phase: 'after', writeId: seen[0]!.writeId, storedStatus: 'on', written: 'on' },
    ]);
    seen.length = 0;
    await deleteConfig(DEF.id, 'test');
    expect(seen.map((s) => [s.phase, s.written])).toEqual([['prepare', undefined], ['after', undefined]]);
  });

  it('a write that did not land is abandoned, and a failing intent fails the write', async () => {
    const abandoned: string[] = [];
    registerToggleWriteIntent('witness', { prepare: async () => {}, abandon: async (w) => { abandoned.push(w.writeId); } });
    await expect(saveConfig({ ...DEF, status: 'on' }, 'test', { expectedRevision: 'stale' })).rejects.toMatchObject({ httpStatus: 409 });
    expect(abandoned, 'a stale revision is refused before any intent').toEqual([]);
    registerToggleWriteIntent('witness', { prepare: async () => { throw new Error('marker store down'); } });
    await expect(saveConfig({ ...DEF, status: 'on' }, 'test')).rejects.toThrow('marker store down');
    expect(await getStoredConfig(DEF.id)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('resolveWrittenToggle resolves the WRITTEN row, not the live one', async () => {
    let written: ToggleWrite | undefined;
    registerToggleWriteListener('witness', async (w) => { written = w; });
    expect(await disableTenantOverride(DEF.id, 'tenant-a', 'test')).toBe('already-off');
    await saveConfig({ ...DEF, status: 'on' }, 'test');
    expect(await disableTenantOverride(DEF.id, 'tenant-a', 'test')).toBe('disabled');
    const off = written!;
    await saveConfig({ ...DEF, status: 'on', tenantOverrides: {} }, 'test');
    expect(off.tenantId).toBe('tenant-a');
    expect(resolveWrittenToggle(off, DEF.id, { tenantId: 'tenant-a' })?.enabled).toBe(false);
    expect(resolveWrittenToggle(off, DEF.id, { tenantId: 'tenant-b' })?.enabled).toBe(true);
    expect(resolveWrittenToggle(off, 'not.written', { tenantId: 'tenant-a' })).toBeNull();
  });
});

// ADR 0951 P2 follow-up (release review of #5398): a store step that THROWS has
// an unknown outcome. Before this, the intent's marker was left behind, so a
// replay OFF marker could fence a tenant whose toggle stayed ON. Now the rows
// are read back: nothing landed → abandon; everything landed → notify; part
// landed → re-prepare that part, then abandon the original.
describe('feature toggle write seam — a throwing store step', () => {
  let prepared: string[][];
  let abandoned: string[][];
  beforeEach(() => {
    prepared = [];
    abandoned = [];
    registerToggleWriteIntent('witness', {
      prepare: async (w) => { prepared.push([...w.ids]); },
      abandon: async (w) => { abandoned.push([...w.ids]); },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    registerToggleWriteIntent('witness', { prepare: async () => {} });
    registerToggleWriteIntent('witness-second', { prepare: async () => {} });
  });

  it('a put that fails before writing abandons the intent and notifies nobody', async () => {
    vi.spyOn(storage, 'kvSet').mockRejectedValueOnce(new Error('store down'));
    await expect(saveConfig({ ...DEF, status: 'off' }, 'test')).rejects.toThrow('store down');
    expect(await getStoredConfig(DEF.id)).toBeNull();
    expect(abandoned).toEqual([[DEF.id]]);
    expect(calls).toEqual([]);
  });

  it('a put that wrote and then threw keeps the intent and notifies the listeners', async () => {
    const real = storage.kvSet.bind(storage);
    vi.spyOn(storage, 'kvSet').mockImplementationOnce(async (k, v) => { await real(k, v); throw new Error('ack lost'); });
    await expect(saveConfig({ ...DEF, status: 'on' }, 'test')).rejects.toThrow('ack lost');
    expect((await getStoredConfig(DEF.id))?.status).toBe('on');
    expect(abandoned).toEqual([]);
    expect(calls).toEqual([{ ids: [DEF.id] }]);
  });

  it('when the read-back fails too, the intent stays (conservative)', async () => {
    vi.spyOn(storage, 'kvSet').mockRejectedValueOnce(new Error('store down'));
    vi.spyOn(storage, 'kvGet').mockRejectedValue(new Error('store still down'));
    await expect(saveConfig({ ...DEF, status: 'off' }, 'test')).rejects.toThrow('store down');
    expect(abandoned).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('a compare-and-swap and a delete that throw without landing are abandoned', async () => {
    await saveConfig({ ...DEF, status: 'on' }, 'test');
    calls = [];
    prepared = [];
    vi.spyOn(storage, 'kvCompareAndSwap').mockRejectedValueOnce(new Error('cas down'));
    await expect(disableTenantOverride(DEF.id, 'tenant-a', 'test')).rejects.toThrow('cas down');
    expect(abandoned).toEqual([[DEF.id]]);
    vi.spyOn(storage, 'kvDelete').mockRejectedValueOnce(new Error('delete down'));
    vi.spyOn(storage, 'kvCompareAndDelete').mockRejectedValueOnce(new Error('delete down'));
    await expect(deleteConfig(DEF.id, 'test')).rejects.toThrow('delete down');
    expect((await getStoredConfig(DEF.id))?.status).toBe('on');
    expect(abandoned).toEqual([[DEF.id], [DEF.id]]);
    expect(calls).toEqual([]);
  });

  it('a multi-row write that lands part-way re-prepares the landed part, then abandons the original', async () => {
    const OTHER: ToggleConfig = { ...DEF, id: 'listener.witness-2', salt: 'listener.witness-2' };
    registerToggleDefault(OTHER);
    await saveConfig({ ...DEF, status: 'on', tenantOverrides: { 'tenant-a': { status: 'off' } } }, 'test');
    await saveConfig({ ...OTHER, status: 'on', tenantOverrides: { 'tenant-a': { status: 'off' } } }, 'test');
    calls = [];
    prepared = [];
    const real = storage.kvSet.bind(storage);
    let puts = 0;
    vi.spyOn(storage, 'kvSet').mockImplementation(async (k, v) => {
      puts += 1;
      if (puts === 2) throw new Error('second put down');
      return real(k, v);
    });
    await expect(purgeTenantOverrides('tenant-a')).rejects.toThrow('second put down');
    // The first put landed, the second did not; which toggle came first is the store's list order.
    const landed = (await getStoredConfig(DEF.id))?.tenantOverrides?.['tenant-a'] === undefined ? DEF.id : OTHER.id;
    const missed = landed === DEF.id ? OTHER.id : DEF.id;
    expect((await getStoredConfig(missed))?.tenantOverrides?.['tenant-a']).toEqual({ status: 'off' });
    expect(prepared).toHaveLength(2);
    expect([...prepared[0]!].sort()).toEqual([DEF.id, OTHER.id].sort());
    expect(prepared[1]).toEqual([landed]);
    expect(abandoned).toEqual([prepared[0]]);
    expect(calls).toEqual([{ ids: [landed], tenantId: 'tenant-a' }]);
  });

  it('an intent whose prepare throws abandons the intents already prepared', async () => {
    registerToggleWriteIntent('witness-second', { prepare: async () => { throw new Error('marker store down'); } });
    await expect(saveConfig({ ...DEF, status: 'off' }, 'test')).rejects.toThrow('marker store down');
    expect(prepared).toEqual([[DEF.id]]);
    expect(abandoned).toEqual([[DEF.id]]);
    expect(await getStoredConfig(DEF.id)).toBeNull();
  });
});
