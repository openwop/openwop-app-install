/**
 * Strategy workflow surface (ADR 0079 Phase 6 / ADR 0014) — `ctx.features.strategy`.
 * A run is TENANT-TRUSTED (no caller subject), so the surface exposes SHARED
 * strategies only — `user`-scoped private drafts MUST NOT leak to a subjectless
 * run (the /architect pre-Phase-6 finding). Read-only: there are no write methods.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createStrategy, archiveStrategy, __clearStrategies } from '../src/features/strategy/strategyService.js';
import { buildStrategySurface } from '../src/features/strategy/surface.js';

const TENANT = 'tenant-surf';

// The surface contract returns `Record<string, unknown>`; the JSON round-trip
// narrows it to the test's expected shape without a type assertion.
function as<T>(v: unknown): T { return JSON.parse(JSON.stringify(v)); }
interface ListOut { strategies: Array<{ id: string; title: string }> }
interface GetOut { strategy: { title: string } | null }

describe('strategy surface (ctx.features.strategy)', () => {
  beforeEach(async () => {
    initHostExtPersistence(openSqliteStorage(':memory:'));
    await __clearStrategies();
  });

  it('lists SHARED strategies only — excludes user-scoped drafts and archived', async () => {
    const org = await createStrategy(TENANT, 'org-1', 'u1', { title: 'Org plan', scope: 'org' });
    const ws = await createStrategy(TENANT, 'org-1', 'u1', { title: 'Workspace plan', scope: 'workspace' });
    const draft = await createStrategy(TENANT, 'org-1', 'u1', { title: 'Private draft', scope: 'user' });
    const archived = await createStrategy(TENANT, 'org-1', 'u1', { title: 'Old', scope: 'org' });
    await archiveStrategy(TENANT, archived.id);

    const surface = buildStrategySurface({ tenantId: TENANT });
    const ids = as<ListOut>(await surface.listStrategies({})).strategies.map((s) => s.id);
    expect(ids).toContain(org.id);
    expect(ids).toContain(ws.id);
    expect(ids).not.toContain(draft.id);     // user-scoped draft excluded
    expect(ids).not.toContain(archived.id);  // archived excluded
  });

  it('getStrategy returns a shared strategy but NULL for a user-scoped draft or missing id', async () => {
    const org = await createStrategy(TENANT, 'org-1', 'u1', { title: 'Shared', scope: 'org', summary: 'visible' });
    const draft = await createStrategy(TENANT, 'org-1', 'u1', { title: 'Secret', scope: 'user' });
    const surface = buildStrategySurface({ tenantId: TENANT });

    expect(as<GetOut>(await surface.getStrategy({ id: org.id })).strategy?.title).toBe('Shared');
    expect(as<GetOut>(await surface.getStrategy({ id: draft.id })).strategy).toBeNull();
    expect(as<GetOut>(await surface.getStrategy({ id: 'nope' })).strategy).toBeNull();
  });

  it('is tenant-isolated — another tenant sees nothing', async () => {
    await createStrategy(TENANT, 'org-1', 'u1', { title: 'A', scope: 'org' });
    const other = buildStrategySurface({ tenantId: 'tenant-other' });
    expect(as<ListOut>(await other.listStrategies({})).strategies).toHaveLength(0);
  });
});
