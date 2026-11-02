/**
 * KERNEL-5 — the shared makeKernelAdapter factory (the single source of the
 * four system-type façade adapters). Pins the generic behaviour AND the
 * KERNEL-6 re-sweep capability (updatedAt-newer-wins) that the deploy-gated
 * straggler migration will use (docs/DEPLOY-KERNEL-SEQUENCING.md, Release B
 * step 1), so it is covered before it is wired — no production caller passes
 * `overwriteIfNewer` yet.
 *
 * Every case seeds its own rows on fresh storage, so the file passes alone,
 * reordered, and under the clock-shift lane (TST-DJA-3, grade-tests wave 71).
 *
 * Red when (sabotage-witnessed): `write` drops the top-level `orgId`; the CAS
 * `matches` predicate always matches; the default migrate reconciles a fresher
 * legacy row; the re-sweep stops comparing `updatedAt` (an OLDER legacy row
 * overwrites, or a NEWER one is skipped); migrate stops copying a new row.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { mintSystemType, getSystemEntity, type EntityRecord } from '../src/features/entities/entitiesService.js';
import { makeKernelAdapter } from '../src/features/entities/kernelAdapter.js';

interface Widget { id: string; tenantId: string; orgId: string; name: string; updatedAt: string }

const TYPE = 'test.widget';
const legacyWidgets = new DurableCollection<Widget>('test:widget-legacy', (w) => w.id, undefined, (w) => w.tenantId);

function isWidget(v: unknown): v is Widget {
  if (typeof v !== 'object' || v === null) return false;
  const r: Record<string, unknown> = { ...v };
  return ['id', 'tenantId', 'orgId', 'name', 'updatedAt'].every((k) => typeof r[k] === 'string');
}
function widgetOf(rec: EntityRecord): Widget {
  const w = rec.ext?.widget;
  if (!isWidget(w)) throw new Error(`kernel row ${rec.entityId} carries no widget ext`);
  return w;
}

const widgets = makeKernelAdapter<Widget>({
  typeName: TYPE,
  ensureType: async (tenantId) => { await mintSystemType({ tenantId, name: TYPE, displayName: 'Widget', fields: [{ key: 'name', label: 'Name', type: 'string', required: true }], actor: 'system:test' }); },
  toKernel: (w) => ({ values: { name: w.name }, ext: { widget: w } }),
  fromKernel: widgetOf,
  idOf: (w) => w.id,
  tenantOf: (w) => w.tenantId,
  orgOf: (w) => w.orgId,
  actorOf: () => 'actor',
  updatedAtOf: (w) => w.updatedAt,
  legacy: legacyWidgets,
});

let caseNo = 0;
let T = '';
beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  caseNo += 1;
  T = `tenant-kadapter-${caseNo}`;
});

const widget = (id: string, name: string, updatedAt: string): Widget => ({ id, tenantId: T, orgId: 'org-a', name, updatedAt });

describe('makeKernelAdapter (KERNEL-5)', () => {
  it('put/get round-trips via ext + stamps top-level orgId', async () => {
    await widgets.put(widget('w1', 'Alpha', '2026-01-01T00:00:00.000Z'));
    expect((await widgets.get(T, 'w1'))?.name).toBe('Alpha');
    expect((await getSystemEntity(T, TYPE, 'w1'))?.orgId).toBe('org-a'); // RI-7 guard sees it
    expect((await getSystemEntity(T, TYPE, 'w1'))?.values.name).toBe('Alpha');
  });

  it('cas succeeds on a byte-identical expected, fails on a stale one', async () => {
    await widgets.put(widget('w-cas', 'Alpha', '2026-01-01T00:00:00.000Z'));
    const cur = await widgets.get(T, 'w-cas');
    if (!cur) throw new Error('seed did not land');
    expect(await widgets.cas(cur, { ...cur, name: 'Alpha2', updatedAt: '2026-01-02T00:00:00.000Z' })).toBe(true);
    // A now-stale expected (the pre-update snapshot) must miss.
    expect(await widgets.cas(cur, { ...cur, name: 'Nope', updatedAt: '2026-01-03T00:00:00.000Z' })).toBe(false);
    expect((await widgets.get(T, 'w-cas'))?.name).toBe('Alpha2');
  });

  it('migrate default is skip-if-present; a fresher legacy row is NOT reconciled', async () => {
    // Kernel has the row (updated 01-02); a legacy row with the SAME id but a
    // NEWER updatedAt = an update an old instance made post-move.
    await widgets.put(widget('w-skip', 'Kernel', '2026-01-02T00:00:00.000Z'));
    await legacyWidgets.put(widget('w-skip', 'LegacyNewer', '2026-06-01T00:00:00.000Z'));
    expect(await widgets.migrate()).toEqual({ migrated: 0, skipped: 1, updated: 0 });
    expect((await widgets.get(T, 'w-skip'))?.name).toBe('Kernel'); // NOT overwritten — the straggler bug
  });

  it('migrate({overwriteIfNewer}) reconciles the fresher legacy straggler and skips an older one (KERNEL-6)', async () => {
    await widgets.put(widget('w-newer', 'Kernel', '2026-01-02T00:00:00.000Z'));
    await legacyWidgets.put(widget('w-newer', 'LegacyNewer', '2026-06-01T00:00:00.000Z'));
    // Control: a legacy row OLDER than its kernel row must not win.
    await widgets.put(widget('w-older', 'KernelNewer', '2026-02-01T00:00:00.000Z'));
    await legacyWidgets.put(widget('w-older', 'LegacyOlder', '2026-01-01T00:00:00.000Z'));
    expect(await widgets.migrate({ overwriteIfNewer: true })).toEqual({ migrated: 0, skipped: 1, updated: 1 });
    expect((await widgets.get(T, 'w-newer'))?.name).toBe('LegacyNewer'); // newer-wins reconciled
    expect((await widgets.get(T, 'w-older'))?.name).toBe('KernelNewer'); // older legacy skipped
  });

  it('migrate copies a NEW legacy row (not yet in the kernel) under either mode', async () => {
    await legacyWidgets.put(widget('w-new-default', 'Fresh', '2026-01-01T00:00:00.000Z'));
    expect(await widgets.migrate()).toEqual({ migrated: 1, skipped: 0, updated: 0 });
    expect((await widgets.get(T, 'w-new-default'))?.name).toBe('Fresh');

    await legacyWidgets.put(widget('w-new-resweep', 'Fresh2', '2026-01-01T00:00:00.000Z'));
    // The default-mode row is now in the kernel at the same updatedAt → skipped.
    expect(await widgets.migrate({ overwriteIfNewer: true })).toEqual({ migrated: 1, skipped: 1, updated: 0 });
    expect((await widgets.get(T, 'w-new-resweep'))?.name).toBe('Fresh2');
  });
});
