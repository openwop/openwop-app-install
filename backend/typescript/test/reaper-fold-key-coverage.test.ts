/**
 * Phase 1 of the generator backlog — reaper/fold KEY-coverage completeness
 * (GEN-1c, GEN-1d, GEN-6). The account-delete reaper and the anon→user fold
 * historically could not reach state that embeds the tenant in a KEY (or omits a
 * tenant content field):
 *  - GEN-1d: `purgeTenantRows` was a content-matched scan of the PRIMARY keyspace,
 *    so a `hostextidx:` marker whose primary row was already gone leaked on delete.
 *  - GEN-1c: `run_budget` (SQL, `bucket` PK, no `tenant_id` column) was skipped by
 *    introspection in BOTH the fold and teardown → strands.
 *  - GEN-6: `codeexec:budget`/`imagegen:budget` carried the tenant only in the KEY
 *    (no content `tenantId`), so the content-matched purge never found them.
 *
 * All exercise the REAL paths (`purgeTenantHostExt`, `storage.reassignTenant`,
 * `storage.deleteAllTenantData`, and the real budget writers/readers) so a
 * bucket-shape or field drift breaks the test.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import {
  initHostExtPersistence,
  DurableCollection,
  purgeTenantHostExt,
} from '../src/host/hostExtPersistence.js';
import { checkCodeExecBudget, recordCodeExec } from '../src/host/codeExecBudget.js';
import { checkMediaBudget, recordMediaUsage } from '../src/aiProviders/mediaBudget.js';
import {
  checkAutonomousRunBudget,
  checkDeepInvestigationBudget,
  runBudgetConfigWithLimit,
} from '../src/host/runBudgetService.js';
import type { Storage } from '../src/storage/storage.js';

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

// ─── GEN-1d — purgeTenantRows sweeps the tenant's index markers by KEY ───

interface Row { id: string; tenantId: string; v: number }
const indexed = () => new DurableCollection<Row>('gen1d:indexed', (r) => r.id, undefined, (r) => r.tenantId);
const IDX = (t: string, id: string) => `hostextidx:gen1d:indexed:${t}:${id}`;

describe('GEN-1d — tenant teardown leaves no hostextidx marker residue', () => {
  it('sweeps a STALE marker (primary row already gone) that the content scan cannot reach', async () => {
    const c = indexed();
    await c.put({ id: 'a', tenantId: 'tA', v: 1 });
    // Delete the primary row out-of-band → the content-matched scan never visits it,
    // so pre-GEN-1d the marker leaked.
    await storage.kvDelete('hostext:gen1d:indexed:a');
    expect(await storage.kvGet(IDX('tA', 'a'))).not.toBeNull(); // marker still there

    await purgeTenantHostExt('tA');
    expect(await storage.kvGet(IDX('tA', 'a'))).toBeNull(); // swept by key
  });

  it('still cleans a live-primary marker and leaves a DIFFERENT tenant`s marker intact', async () => {
    const c = indexed();
    await c.put({ id: 'b', tenantId: 'tA', v: 2 }); // live row (content scan cleans it)
    await c.put({ id: 'z', tenantId: 'tB', v: 9 }); // different tenant — must survive

    await purgeTenantHostExt('tA');

    expect(await storage.kvGet('hostext:gen1d:indexed:b')).toBeNull();
    expect(await storage.kvGet(IDX('tA', 'b'))).toBeNull();
    // tB is untouched (the trailing ':' in the idx prefix delimits the slice).
    expect(await storage.kvGet('hostext:gen1d:indexed:z')).not.toBeNull();
    expect(await storage.kvGet(IDX('tB', 'z'))).not.toBeNull();
  });
});

// ─── GEN-6 — key-only budget counters are reaped on teardown ───

describe('GEN-6 — codeexec/imagegen budgets are reaped on tenant teardown', () => {
  const day = '2026-07-16';
  it('deletes the folded/deleted tenant`s daily counters; a different tenant survives', async () => {
    await recordCodeExec('user:aaa', day);
    await recordCodeExec('user:aaa', day);
    await recordMediaUsage('user:aaa', 'images', 3); // today-keyed (mediaBudget owns the day)
    await recordCodeExec('user:bbb', day); // different tenant
    expect((await checkCodeExecBudget('user:aaa', day)).used).toBe(2);
    expect((await checkMediaBudget('user:aaa', 'images', 1)).used).toBe(3);

    await purgeTenantHostExt('user:aaa');

    // Reaped — the counters reset (the row is gone, not just the tenant field).
    expect((await checkCodeExecBudget('user:aaa', day)).used).toBe(0);
    expect((await checkMediaBudget('user:aaa', 'images', 1)).used).toBe(0);
    // The other tenant is untouched.
    expect((await checkCodeExecBudget('user:bbb', day)).used).toBe(1);
  });
});

// ─── GEN-1c — run_budget follows the fold and is reaped on teardown ───

const NOW = 1_000_000_000_000; // fixed → a stable window across calls
const cfg = runBudgetConfigWithLimit(100); // high limit so the counter keeps climbing

describe('GEN-1c — run_budget (no tenant_id column) is fold- and teardown-covered', () => {
  it('MOVES the tenant`s autonomous + deep buckets on fold; source is cleared', async () => {
    const from = 'anon:sid1';
    const to = 'user:0123456789abcdef0123456789abcdef';
    // Seed: autonomous count 3, deep count 2 (in one room) under the anon tenant.
    for (let i = 0; i < 3; i++) await checkAutonomousRunBudget(storage, from, NOW, cfg);
    for (let i = 0; i < 2; i++) await checkDeepInvestigationBudget(storage, from, 'room-1', NOW, cfg);

    await storage.reassignTenant(from, to);

    // Autonomous count carried: the destination's next consume sees 3 → returns 4.
    expect((await checkAutonomousRunBudget(storage, to, NOW, cfg)).current).toBe(4);
    // Deep count carried for the same room.
    expect((await checkDeepInvestigationBudget(storage, to, 'room-1', NOW, cfg)).current).toBe(3);
    // Source is empty — a fresh consume under the anon tenant starts at 1.
    expect((await checkAutonomousRunBudget(storage, from, NOW, cfg)).current).toBe(1);
  });

  it('keeps the TARGET`s own bucket on a same-window collision (target budget wins)', async () => {
    const from = 'anon:sid2';
    const to = 'user:ffffffffffffffffffffffffffffffff';
    for (let i = 0; i < 2; i++) await checkAutonomousRunBudget(storage, to, NOW, cfg); // target has 2
    for (let i = 0; i < 3; i++) await checkAutonomousRunBudget(storage, from, NOW, cfg); // source has 3

    await storage.reassignTenant(from, to);

    // Target's 2 wins (source's 3 dropped) → next consume returns 3, not 4/6.
    expect((await checkAutonomousRunBudget(storage, to, NOW, cfg)).current).toBe(3);
  });

  it('deletes the tenant`s buckets on teardown; a different tenant is untouched', async () => {
    const gone = 'user:11111111111111111111111111111111';
    const keep = 'user:22222222222222222222222222222222';
    for (let i = 0; i < 4; i++) await checkAutonomousRunBudget(storage, gone, NOW, cfg);
    await checkDeepInvestigationBudget(storage, gone, 'room-x', NOW, cfg);
    for (let i = 0; i < 5; i++) await checkAutonomousRunBudget(storage, keep, NOW, cfg);

    await storage.deleteAllTenantData(gone);

    // Deleted tenant's buckets are gone → fresh consume starts at 1 (autonomous + deep).
    expect((await checkAutonomousRunBudget(storage, gone, NOW, cfg)).current).toBe(1);
    expect((await checkDeepInvestigationBudget(storage, gone, 'room-x', NOW, cfg)).current).toBe(1);
    // The other tenant's counter is intact → next consume returns 6.
    expect((await checkAutonomousRunBudget(storage, keep, NOW, cfg)).current).toBe(6);
  });

  it('a fold with no source buckets is a no-op (does not disturb the target)', async () => {
    const to = 'user:33333333333333333333333333333333';
    await checkAutonomousRunBudget(storage, to, NOW, cfg); // target has 1
    await storage.reassignTenant('anon:empty', to);
    expect((await checkAutonomousRunBudget(storage, to, NOW, cfg)).current).toBe(2); // untouched
  });
});
