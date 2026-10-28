/**
 * ADR 0488 P1 — the tutorials narrative service.
 *
 * The load-bearing behaviour here is D3, the DEGRADED-MODE FLOOR: `/tutorials`
 * is always-on but the `entities` kernel it reads defaults OFF, so a kernel that
 * is unreachable MUST degrade to the shipped seed rather than empty the surface.
 * "Failed read rendered as an empty state" is the single most common defect class
 * in this repo's UX audits, so it gets a dedicated, sabotage-proven test.
 *
 * The kernel is MOCKED here, so this file owns only what the mock can show:
 * the degraded floor, kernel-wins precedence, the customization guard, `force`,
 * write attribution and the /example-data lane. Row CREATION and same-version
 * IDEMPOTENCY are asserted against the real kernel in
 * `tutorials-kernel-mint.test.ts` ("seeds REAL ROWS", "is idempotent"), which
 * is why the two mock-count twins of those cases were cut (grade-tests w63:
 * the same sabotage turned both files red — 8fw4g3-tkm-created / -tkm-idem).
 *
 * Mocks and fixtures are typed against the real kernel signatures
 * (`EntityRecord`, `EntityTypeRecord`), so a fixture the kernel could not
 * return no longer compiles.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as Entities from '../src/features/entities/entitiesService.js';
import type { EntityRecord, EntityTypeRecord } from '../src/features/entities/entitiesService.js';

const kernel = vi.hoisted(() => ({
  listSystemEntities: vi.fn<typeof Entities.listSystemEntities>(),
  getSystemEntity: vi.fn<typeof Entities.getSystemEntity>(),
  putSystemEntity: vi.fn<typeof Entities.putSystemEntity>(),
  mintSystemType: vi.fn<typeof Entities.mintSystemType>(),
  deleteSystemEntity: vi.fn<typeof Entities.deleteSystemEntity>(),
}));

vi.mock('../src/features/entities/entitiesService.js', () => kernel);

const { listTutorials, getTutorial, seedTutorials, countTutorialRows, clearTutorialRows } =
  await import('../src/features/tutorials/tutorialsService.js');
const { SEED_TUTORIALS } = await import('../src/features/tutorials/seedTutorials.js');

const TENANT = 'tenant-a';
const AT = '2026-07-25T00:00:00.000Z';

/** A kernel row exactly as `listSystemEntities` / `getSystemEntity` return it. */
function kernelRow(values: EntityRecord['values'], ext?: Record<string, unknown>): EntityRecord {
  const entityId = typeof values.slug === 'string' ? values.slug : 'no-slug';
  return {
    recordKey: `ty-tutorials|${entityId}`, entityId, tenantId: TENANT, projectId: 'default', typeId: 'ty-tutorials',
    values, ...(ext ? { ext } : {}), createdBy: 'system:tutorials', createdAt: AT, updatedBy: 'system:tutorials', updatedAt: AT,
  };
}
const MINTED: EntityTypeRecord = {
  typeId: 'ty-tutorials', tenantId: TENANT, projectId: 'default', name: 'tutorials.lesson', displayName: 'Tutorial',
  fields: [], status: 'published', system: true, createdBy: 'system:tutorials', createdAt: AT, updatedAt: AT,
};
/** `putSystemEntity` resolves with the stored record; echo the input as one. */
const echoPut: typeof Entities.putSystemEntity = async (input) =>
  kernelRow({ slug: input.entityId }, input.ext);

beforeEach(() => {
  // mockReset, not clearAllMocks: a case's mockImplementation must not leak.
  for (const fn of Object.values(kernel)) fn.mockReset();
  kernel.listSystemEntities.mockResolvedValue([]);
  kernel.getSystemEntity.mockResolvedValue(null);
  kernel.putSystemEntity.mockImplementation(echoPut);
  kernel.mintSystemType.mockResolvedValue(MINTED);
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
    const seed = SEED_TUTORIALS[0]!;
    const t = await getTutorial(TENANT, seed.id);
    expect(t?.source).toBe('seed');
    expect(t?.id).toBe(seed.id);
    expect(t?.phases.length).toBe(seed.phases.length);
  });

  it('a MALFORMED kernel row degrades to the seed rather than rendering broken', async () => {
    // The kernel is tenant-writable, so a row can lose its phases.
    kernel.getSystemEntity.mockResolvedValue(kernelRow({ slug: SEED_TUTORIALS[0]!.id }, { phases: 'not-an-array' }));
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
    kernel.listSystemEntities.mockResolvedValue([kernelRow(
      { slug, title: 'Tenant-edited title', description: 'edited', category: 'build' },
      { phases: [{ number: 1, title: 'P', steps: [] }], customizedAt: AT },
    )]);
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
  it('NEVER overwrites a tenant-customized row, even when the seedVersion moved', async () => {
    kernel.getSystemEntity.mockImplementation(async (_t, _ty, id) => kernelRow({ slug: id, seed_version: '0.0.1-old' }, { customizedAt: AT }));
    const r = await seedTutorials(TENANT);
    expect(r.skipped).toBe(SEED_TUTORIALS.length);
    expect(kernel.putSystemEntity).not.toHaveBeenCalled();
  });

  it('REFRESHES an un-customized row whose seedVersion is behind', async () => {
    kernel.getSystemEntity.mockImplementation(async (_t, _ty, id) => kernelRow({ slug: id, seed_version: '0.0.1-old' }));
    const r = await seedTutorials(TENANT);
    expect(r.updated).toBe(SEED_TUTORIALS.length);
    expect(kernel.putSystemEntity).toHaveBeenCalledTimes(SEED_TUTORIALS.length);
  });

  it('force overrides the customization guard (the operator path only)', async () => {
    kernel.getSystemEntity.mockImplementation(async (_t, _ty, id) => kernelRow({ slug: id, seed_version: '0.0.1-old' }, { customizedAt: AT }));
    const r = await seedTutorials(TENANT, { force: true });
    expect(r.updated).toBe(SEED_TUTORIALS.length);
  });

  it('every write carries an actor (audit attribution) and lands live', async () => {
    await seedTutorials(TENANT);
    // Fresh tenant: every seed is written, so the loop below is never over [].
    expect(kernel.putSystemEntity).toHaveBeenCalledTimes(SEED_TUTORIALS.length);
    for (const call of kernel.putSystemEntity.mock.calls) {
      expect(call[0].actor).toBe('system:tutorials');
      expect(call[0].status).toBe('live');
      expect(call[0].tenantId).toBe(TENANT);
    }
  });
});

describe('ADR 0488 — the /example-data lane (DATA-T1)', () => {
  it('counts only THIS workspace\'s editable rows', async () => {
    kernel.listSystemEntities.mockResolvedValue([kernelRow({ slug: 'a' }), kernelRow({ slug: 'b' })]);
    expect(await countTutorialRows(TENANT)).toBe(2);
  });

  it('counts ZERO (not an error) when the kernel is off — zero is the healthy default', async () => {
    kernel.listSystemEntities.mockRejectedValue(new Error('host_capability_disabled'));
    expect(await countTutorialRows(TENANT)).toBe(0);
  });

  it('CLEAR means revert-to-shipped: it deletes the rows and the tutorials still read', async () => {
    kernel.listSystemEntities.mockResolvedValue([kernelRow({ slug: 'connect-your-ai' }), kernelRow({ slug: 'x' })]);
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
    kernel.listSystemEntities.mockResolvedValue([kernelRow({}), kernelRow({ slug: 'ok' })]);
    expect((await clearTutorialRows(TENANT)).cleared).toBe(1);
  });

  it('clear degrades to 0 when the kernel is unreachable (never throws at the seeder)', async () => {
    kernel.listSystemEntities.mockRejectedValue(new Error('down'));
    expect((await clearTutorialRows(TENANT)).cleared).toBe(0);
  });
});
