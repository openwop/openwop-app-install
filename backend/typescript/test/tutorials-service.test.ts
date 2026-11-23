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
 * Since 2026-11-10 it also owns the reader's STALE-COPY yield (grade-data
 * `TUT-STALE-1`, ADR 0488 D3): an un-customized seed copy at an older
 * `seedVersion` reads as the shipped seed, counted per reader on
 * `openwop.tutorials.stale_seed_served` (`TUT-OBS-1`), while a current,
 * customized or tenant-authored row keeps winning; and the daily integrity
 * gauge's counts (ADR 1104, PROBE-1038-4). The gauge fixture is asymmetric on
 * purpose (grade-tests w122): three stale rows across TWO tenants, so a
 * per-row count cannot pass for the per-tenant one, and a customized row AT
 * the shipped version, so the "behind" check is what keeps it out.
 * Red if: the list drops `degraded`, a kernel failure empties a read, a
 * malformed row renders, a stale copy wins (or a kept one yields), a yield is
 * uncounted or mislabelled, the gauge miscounts, or the seeder overwrites a
 * customized row, skips a refresh, or writes without the actor.
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
  listAllSystemRowsBounded: vi.fn<typeof Entities.listAllSystemRowsBounded>(),
  getSystemEntity: vi.fn<typeof Entities.getSystemEntity>(),
  putSystemEntity: vi.fn<typeof Entities.putSystemEntity>(),
  mintSystemType: vi.fn<typeof Entities.mintSystemType>(),
  deleteSystemEntity: vi.fn<typeof Entities.deleteSystemEntity>(),
}));

vi.mock('../src/features/entities/entitiesService.js', () => kernel);

const { listTutorials, getTutorial, seedTutorials, countTutorialRows, clearTutorialRows, tutorialIntegrityGauge } =
  await import('../src/features/tutorials/tutorialsService.js');
const { SEED_TUTORIALS } = await import('../src/features/tutorials/seedTutorials.js');
const { emissionsOf, _resetMetricsForTest } = await import('../src/observability/metrics.js');
const STALE_METRIC = 'openwop.tutorials.stale_seed_served';

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

describe('a stale, un-customized seed copy yields to the shipped seed (TUT-STALE-1)', () => {
  // Only /example-data runs the seeder, so a bumped seedVersion never reached a
  // workspace that had copied the tutorials once: its copy kept winning.
  const seed = SEED_TUTORIALS[0]!;
  beforeEach(() => { _resetMetricsForTest(); });
  const copy = (seedVersion: string, ext: Record<string, unknown> = {}) => kernelRow(
    { slug: seed.id, title: 'Old shipped title', description: 'old', category: seed.category, seed_version: seedVersion },
    { phases: [{ number: 1, title: 'Old', steps: [] }], ...ext },
  );

  it('list and get serve the shipped seed when the copy is at an older seedVersion', async () => {
    kernel.listSystemEntities.mockResolvedValue([copy('0.0.1-old')]);
    kernel.getSystemEntity.mockResolvedValue(copy('0.0.1-old'));
    const listed = (await listTutorials(TENANT)).tutorials.find((t) => t.id === seed.id);
    expect(listed).toMatchObject({ title: seed.title, source: 'seed', seedVersion: seed.seedVersion });
    expect(await getTutorial(TENANT, seed.id)).toMatchObject({ title: seed.title, source: 'seed' });
    expect(kernel.putSystemEntity).not.toHaveBeenCalled(); // a read never writes
    // TUT-OBS-1 — each yield is counted, by reader, with no tenant label.
    expect(emissionsOf(STALE_METRIC).map((e) => e.attributes)).toEqual([{ reader: 'list' }, { reader: 'get' }]);
  });

  it('keeps the copy when it is at the shipped seedVersion, customized, or tenant-authored', async () => {
    for (const row of [copy(seed.seedVersion), copy('0.0.1-old', { customizedAt: AT }), copy('')]) {
      kernel.listSystemEntities.mockResolvedValue([row]);
      kernel.getSystemEntity.mockResolvedValue(row);
      expect((await listTutorials(TENANT)).tutorials.find((t) => t.id === seed.id)).toMatchObject({ title: 'Old shipped title', source: 'kernel' });
      expect(await getTutorial(TENANT, seed.id)).toMatchObject({ title: 'Old shipped title', source: 'kernel' });
    }
    expect(emissionsOf(STALE_METRIC)).toEqual([]); // a kept copy is not a yield
  });
});

describe('the tutorials integrity gauge (ADR 1104, PROBE-1038-4)', () => {
  it('counts stale copies, customized rows behind the seed, and tenant-authored rows', async () => {
    const [a, b, c, d, e] = [SEED_TUTORIALS[0]!, SEED_TUTORIALS[1]!, SEED_TUTORIALS[2]!, SEED_TUTORIALS[3]!, SEED_TUTORIALS[4]!];
    const row = (slug: string, seedVersion: string, ext?: Record<string, unknown>) =>
      kernelRow({ slug, title: 'T', description: 'd', category: a.category, seed_version: seedVersion }, { phases: [], ...ext });
    kernel.listAllSystemRowsBounded.mockResolvedValue({ truncatedTenants: 1, rows: [
      row(a.id, '0.0.1-old'),                         // stale, un-customized: the reader yields to the seed
      row(c.id, '0.0.1-old'),                         // a second stale copy in the SAME tenant
      { ...row(d.id, '0.0.1-old'), tenantId: 'tenant-b' }, // and one in another tenant: 3 stale rows, 2 tenants
      row(b.id, b.seedVersion),                       // current copy
      row(b.id, '0.0.1-old', { customizedAt: AT }),   // a tenant edit on an older seed: keeps winning
      row(e.id, e.seedVersion, { customizedAt: AT }), // a tenant edit AT the shipped version: not "behind"
      row('my-own-tutorial', ''),                     // tenant-authored
    ] });
    expect(await tutorialIntegrityGauge(25)).toEqual({ rows: 7, seedCopies: 6, staleSeedCopies: 3, tenantsWithStale: 2, customizedBehind: 1, tenantAuthored: 1, truncatedTenants: 1 });
    expect(kernel.listAllSystemRowsBounded).toHaveBeenCalledWith('tutorials.lesson', 25); // the cap reaches the read
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
    // "THIS workspace": the mock answers any tenant, so the scope is the argument.
    expect(kernel.listSystemEntities).toHaveBeenCalledWith(TENANT, 'tutorials.lesson');
    expect(kernel.listSystemEntities).toHaveBeenCalledTimes(1);
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
