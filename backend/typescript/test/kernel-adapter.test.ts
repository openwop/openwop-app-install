/**
 * KERNEL-5 — the shared makeKernelAdapter factory (the single source of the
 * four system-type façade adapters). Pins the generic behaviour AND the
 * KERNEL-6 re-sweep capability (updatedAt-newer-wins) that the deploy-gated
 * straggler migration will use, so it is covered before it is wired.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { mintSystemType, getSystemEntity } from '../src/features/entities/entitiesService.js';
import { makeKernelAdapter } from '../src/features/entities/kernelAdapter.js';

interface Widget { id: string; tenantId: string; orgId: string; name: string; updatedAt: string }

const T = 'tenant-kadapter';
const TYPE = 'test.widget';
const legacyWidgets = new DurableCollection<Widget>('test:widget-legacy', (w) => w.id, undefined, (w) => w.tenantId);

const widgets = makeKernelAdapter<Widget>({
  typeName: TYPE,
  ensureType: async (tenantId) => { await mintSystemType({ tenantId, name: TYPE, displayName: 'Widget', fields: [{ key: 'name', label: 'Name', type: 'string', required: true }], actor: 'system:test' }); },
  toKernel: (w) => ({ values: { name: w.name }, ext: { widget: w } }),
  fromKernel: (rec) => rec.ext?.widget as Widget,
  idOf: (w) => w.id,
  tenantOf: (w) => w.tenantId,
  orgOf: (w) => w.orgId,
  actorOf: () => 'actor',
  updatedAtOf: (w) => w.updatedAt,
  legacy: legacyWidgets,
});

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('makeKernelAdapter (KERNEL-5)', () => {
  it('put/get round-trips via ext + stamps top-level orgId', async () => {
    await widgets.put({ id: 'w1', tenantId: T, orgId: 'org-a', name: 'Alpha', updatedAt: '2026-01-01T00:00:00.000Z' });
    expect((await widgets.get(T, 'w1'))?.name).toBe('Alpha');
    expect((await getSystemEntity(T, TYPE, 'w1'))?.orgId).toBe('org-a'); // RI-7 guard sees it
    expect((await getSystemEntity(T, TYPE, 'w1'))?.values.name).toBe('Alpha');
  });

  it('cas succeeds on a byte-identical expected, fails on a stale one', async () => {
    const cur = (await widgets.get(T, 'w1'))!;
    expect(await widgets.cas(cur, { ...cur, name: 'Alpha2', updatedAt: '2026-01-02T00:00:00.000Z' })).toBe(true);
    // A now-stale expected (the pre-update snapshot) must miss.
    expect(await widgets.cas(cur, { ...cur, name: 'Nope', updatedAt: '2026-01-03T00:00:00.000Z' })).toBe(false);
    expect((await widgets.get(T, 'w1'))?.name).toBe('Alpha2');
  });

  it('migrate default is skip-if-present; a fresher legacy row is NOT reconciled', async () => {
    // Kernel already has w1 (name Alpha2, updated 2026-01-02). A legacy row with
    // the SAME id but a NEWER updatedAt = an update an old instance made post-move.
    await legacyWidgets.put({ id: 'w1', tenantId: T, orgId: 'org-a', name: 'LegacyNewer', updatedAt: '2026-06-01T00:00:00.000Z' });
    const r = await widgets.migrate(); // default: skip-if-present
    expect(r.skipped).toBe(1);
    expect(r.updated).toBe(0);
    expect((await widgets.get(T, 'w1'))?.name).toBe('Alpha2'); // NOT overwritten — the straggler bug
  });

  it('migrate({overwriteIfNewer}) reconciles the fresher legacy straggler (KERNEL-6)', async () => {
    const r = await widgets.migrate({ overwriteIfNewer: true });
    expect(r.updated).toBe(1);
    expect((await widgets.get(T, 'w1'))?.name).toBe('LegacyNewer'); // newer-wins reconciled
  });

  it('migrate copies a NEW legacy row (not yet in the kernel) under either mode', async () => {
    await legacyWidgets.put({ id: 'w2', tenantId: T, orgId: 'org-a', name: 'Fresh', updatedAt: '2026-01-01T00:00:00.000Z' });
    const r = await widgets.migrate();
    expect(r.migrated).toBe(1);
    expect((await widgets.get(T, 'w2'))?.name).toBe('Fresh');
  });
});
