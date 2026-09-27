/**
 * ADR 0488 P1 — the tutorials narrative service.
 *
 * The load-bearing behaviour here is D3, the DEGRADED-MODE FLOOR: `/tutorials`
 * is always-on but the `entities` kernel it reads defaults OFF, so a kernel that
 * is unreachable MUST degrade to the shipped seed rather than empty the surface.
 * "Failed read rendered as an empty state" is the single most common defect class
 * in this repo's UX audits, so it gets a dedicated, sabotage-proven test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const kernel = vi.hoisted(() => ({
  listSystemEntities: vi.fn(),
  getSystemEntity: vi.fn(),
  putSystemEntity: vi.fn(),
  mintSystemType: vi.fn(),
  deleteSystemEntity: vi.fn(),
}));

vi.mock('../src/features/entities/entitiesService.js', () => kernel);

const { listTutorials, getTutorial, seedTutorials, countTutorialRows, clearTutorialRows } =
  await import('../src/features/tutorials/tutorialsService.js');
const { SEED_TUTORIALS } = await import('../src/features/tutorials/seedTutorials.js');

const TENANT = 'tenant-a';

beforeEach(() => {
  vi.clearAllMocks();
  kernel.listSystemEntities.mockResolvedValue([]);
  kernel.getSystemEntity.mockResolvedValue(null);
  kernel.putSystemEntity.mockResolvedValue(undefined);
  kernel.mintSystemType.mockResolvedValue({});
  kernel.deleteSystemEntity.mockResolvedValue(true);
});

describe('ADR 0488 D3 — the degraded-mode floor', () => {
  it('serves the SHIPPED SEEDS when the entities kernel throws (never an empty list)', async () => {
    kernel.listSystemEntities.mockRejectedValue(new Error('host_capability_disabled'));
    const { tutorials, degraded } = await listTutorials(TENANT);
    expect(tutorials.length).toBe(SEED_TUTORIALS.length);
    expect(tutorials.length).toBeGreaterThan(0); // non-vacuous
    expect(tutorials.every((t) => t.source === 'seed')).toBe(true);
    // The client MUST be told, so it can say "shipped copy" instead of implying
    // these are the tenant's own editable rows.
    expect(degraded).toBe(true);
  });

  it('falls back to the seed for a single tutorial when the kernel throws', async () => {
    kernel.getSystemEntity.mockRejectedValue(new Error('host_capability_disabled'));
    const t = await getTutorial(TENANT, SEED_TUTORIALS[0]!.id);
    expect(t?.source).toBe('seed');
    expect(t?.phases.length).toBeGreaterThan(0);
  });

  it('a MALFORMED kernel row degrades to the seed rather than rendering broken', async () => {
    // The kernel is tenant-writable, so a row can lose its phases.
    kernel.getSystemEntity.mockResolvedValue({ values: { slug: SEED_TUTORIALS[0]!.id, phases: 'not-an-array' } });
    const t = await getTutorial(TENANT, SEED_TUTORIALS[0]!.id);
    expect(t?.source).toBe('seed');
  });

  it('returns null only when NEITHER a kernel row NOR a seed matches', async () => {
    expect(await getTutorial(TENANT, 'no-such-tutorial')).toBeNull();
  });
});

describe('ADR 0488 D1 — kernel rows are authoritative', () => {
  it('a kernel row WINS over the seed of the same slug, and reports its source', async () => {
    const slug = SEED_TUTORIALS[0]!.id;
    // TWO BAGS: built-in scalars in `values`, extension-kind fields (`phases`)
    // in `ext` — the kernel's actual split. This fixture previously put
    // `phases` in `values`, a shape the real kernel rejects; the mock accepted
    // it, which is part of why the dead mint went unnoticed.
    kernel.listSystemEntities.mockResolvedValue([{
      values: { slug, title: 'Tenant-edited title', description: 'edited', category: 'build' },
      ext: { phases: [{ number: 1, title: 'P', steps: [] }], customizedAt: '2026-07-25T00:00:00.000Z' },
    }]);
    const { tutorials, degraded } = await listTutorials(TENANT);
    const row = tutorials.find((t) => t.id === slug);
    expect(row?.title).toBe('Tenant-edited title');
    expect(row?.source).toBe('kernel');
    expect(row?.customized).toBe(true);
    expect(degraded).toBe(false);
    // Seeds still fill the gaps — the tenant sees the whole library.
    expect(tutorials.length).toBe(SEED_TUTORIALS.length);
  });
});

describe('ADR 0488 D3 — the seed lifecycle', () => {
  it('creates every tutorial on a fresh tenant', async () => {
    const r = await seedTutorials(TENANT);
    expect(r.created).toBe(SEED_TUTORIALS.length);
    expect(kernel.mintSystemType).toHaveBeenCalledOnce();
    expect(kernel.putSystemEntity).toHaveBeenCalledTimes(SEED_TUTORIALS.length);
  });

  it('is IDEMPOTENT — a re-run at the same seedVersion writes nothing', async () => {
    kernel.getSystemEntity.mockImplementation((_t: string, _ty: string, id: string) =>
      Promise.resolve({ values: { slug: id, seed_version: SEED_TUTORIALS.find((s) => s.id === id)?.seedVersion } }));
    const r = await seedTutorials(TENANT);
    expect(r.skipped).toBe(SEED_TUTORIALS.length);
    expect(kernel.putSystemEntity).not.toHaveBeenCalled();
  });

  it('NEVER overwrites a tenant-customized row, even when the seedVersion moved', async () => {
    kernel.getSystemEntity.mockImplementation((_t: string, _ty: string, id: string) =>
      Promise.resolve({ values: { slug: id, seed_version: '0.0.1-old' }, ext: { customizedAt: '2026-07-25T00:00:00.000Z' } }));
    const r = await seedTutorials(TENANT);
    expect(r.skipped).toBe(SEED_TUTORIALS.length);
    expect(kernel.putSystemEntity).not.toHaveBeenCalled();
  });

  it('REFRESHES an un-customized row whose seedVersion is behind', async () => {
    kernel.getSystemEntity.mockImplementation((_t: string, _ty: string, id: string) =>
      Promise.resolve({ values: { slug: id, seed_version: '0.0.1-old' } }));
    const r = await seedTutorials(TENANT);
    expect(r.updated).toBe(SEED_TUTORIALS.length);
    expect(kernel.putSystemEntity).toHaveBeenCalledTimes(SEED_TUTORIALS.length);
  });

  it('force overrides the customization guard (the operator path only)', async () => {
    kernel.getSystemEntity.mockImplementation((_t: string, _ty: string, id: string) =>
      Promise.resolve({ values: { slug: id, seed_version: '0.0.1-old' }, ext: { customizedAt: 'x' } }));
    const r = await seedTutorials(TENANT, { force: true });
    expect(r.updated).toBe(SEED_TUTORIALS.length);
  });

  it('every write carries an actor (audit attribution) and lands live', async () => {
    await seedTutorials(TENANT);
    for (const call of kernel.putSystemEntity.mock.calls) {
      expect(call[0].actor).toBe('system:tutorials');
      expect(call[0].status).toBe('live');
      expect(call[0].tenantId).toBe(TENANT);
    }
  });
});

describe('ADR 0488 — the /example-data lane (DATA-T1)', () => {
  it('counts only THIS workspace\'s editable rows', async () => {
    kernel.listSystemEntities.mockResolvedValue([{ values: { slug: 'a' } }, { values: { slug: 'b' } }]);
    expect(await countTutorialRows(TENANT)).toBe(2);
  });

  it('counts ZERO (not an error) when the kernel is off — zero is the healthy default', async () => {
    kernel.listSystemEntities.mockRejectedValue(new Error('host_capability_disabled'));
    expect(await countTutorialRows(TENANT)).toBe(0);
  });

  it('CLEAR means revert-to-shipped: it deletes the rows and the tutorials still read', async () => {
    kernel.listSystemEntities.mockResolvedValue([{ values: { slug: 'connect-your-ai' } }, { values: { slug: 'x' } }]);
    const r = await clearTutorialRows(TENANT);
    expect(r.cleared).toBe(2);
    expect(kernel.deleteSystemEntity).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, entityId: 'connect-your-ai' }));

    // The load-bearing half: after clearing, the reader still serves the whole
    // shipped library. "Clear" must never mean "the tutorials are gone".
    kernel.listSystemEntities.mockResolvedValue([]);
    const { tutorials } = await listTutorials(TENANT);
    expect(tutorials.length).toBe(SEED_TUTORIALS.length);
    expect(tutorials.every((t) => t.source === 'seed')).toBe(true);
  });

  it('clear is resilient — a malformed row without a slug is skipped, not fatal', async () => {
    kernel.listSystemEntities.mockResolvedValue([{ values: {} }, { values: { slug: 'ok' } }]);
    expect((await clearTutorialRows(TENANT)).cleared).toBe(1);
  });

  it('clear degrades to 0 when the kernel is unreachable (never throws at the seeder)', async () => {
    kernel.listSystemEntities.mockRejectedValue(new Error('down'));
    expect((await clearTutorialRows(TENANT)).cleared).toBe(0);
  });
});
