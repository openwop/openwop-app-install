/**
 * PHBC-5 — the row-driven deferred conversion, and the state migration 14 could
 * not see.
 *
 * MIGRATION 14 DID NOT FAIL BECAUSE IT WAS ONE-SHOT. It failed because its no-op
 * outcome was INDISTINGUISHABLE from the legitimate fresh-install outcome:
 * `{examined: 52, absent: 52, rewritten: 0}` is CORRECT on a fresh install and
 * catastrophic on a populated one, and nothing in the result could tell them
 * apart. Measured in production: 71 rows written 2026-07-28, migration ran
 * 2026-08-01 reporting every one absent, and all 71 are still `expansion-time`.
 *
 * `reseed-migration-not-vacuous.test.ts` is well written and pins the OTHER
 * ordering trap (empty chain registry). It cannot catch this one, because it
 * derives its population from chains too — the same blind spot as the code.
 *
 * So the fixture here is the production state itself: ROWS PRESENT, CORPUS
 * SHIFTED so the derived ids do not match. That is the state no existing test
 * can produce, and every assertion below is about telling it apart from a fresh
 * install.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { reseedSeededRowsDeferred } from '../src/host/seedWorkflows.js';
import { APP_MIGRATIONS, runAppMigrations, latestAppMigration } from '../src/host/appMigrations.js';

const row = (workflowId: string, over: Record<string, unknown> = {}) => ({
  key: `wfreg:${workflowId}`,
  value: JSON.stringify({
    workflowId,
    nodes: [{ nodeId: 'n1', typeId: 'core.noop', config: {}, inputs: {} }],
    edges: [],
    metadata: { name: workflowId, expansionMode: 'expansion-time', ...over },
  }),
});

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

describe('PHBC-5 — the population comes from the ROWS', () => {
  it('a fresh install reports total 0 — distinguishable from a broken classifier', async () => {
    // THE ASSERTION MIGRATION 14 COULD NOT MAKE. Its fresh-install result and its
    // broken-classifier result were the same numbers; here they differ in `total`.
    const r = await reseedSeededRowsDeferred(storage);
    expect(r.total, 'no seeded rows exist, so the population is genuinely empty').toBe(0);
    expect(r.converted).toBe(0);
  });

  it('SEES rows whose originating chain has left the corpus, and NAMES them', async () => {
    // The production state. Migration 14 counted these as "absent" and said
    // nothing; the whole defect is that silence.
    await storage.kvSet(...Object.values(row('wf.seed.chain-that-no-longer-exists')) as [string, string]);
    const r = await reseedSeededRowsDeferred(storage);
    expect(r.total, 'the row exists and must be counted').toBe(1);
    expect(r.chainGone, 'a vanished chain must be named, never silently skipped')
      .toEqual(['wf.seed.chain-that-no-longer-exists']);
    expect(r.converted).toBe(0);
  });

  it('every row lands in exactly one bucket', async () => {
    // Invariant 1 in the migration. A row falling through every branch is a
    // classifier bug, and the sum is what makes it loud.
    for (const id of ['wf.seed.a', 'wf.seed.b', 'wf.seed.c']) {
      await storage.kvSet(...Object.values(row(id)) as [string, string]);
    }
    await storage.kvSet(...Object.values(row('wf.seed.d', { expansionMode: 'deferred' })) as [string, string]);
    const r = await reseedSeededRowsDeferred(storage);
    const accounted = r.alreadyDeferred + r.converted + r.chainGone.length + r.inputBearing.length + r.failed;
    expect(accounted, 'unaccounted rows mean the migration cannot claim to have seen the population')
      .toBe(r.total);
  });

  it('leaves an already-deferred row alone', async () => {
    await storage.kvSet(...Object.values(row('wf.seed.already', { expansionMode: 'deferred' })) as [string, string]);
    const r = await reseedSeededRowsDeferred(storage);
    expect(r.alreadyDeferred).toBe(1);
    expect(r.converted).toBe(0);
  });

  it('does NOT sweep in tenant-authored workflows', async () => {
    // `kvList('wfreg:')` returns EVERY registered workflow. A hand-authored one
    // must not be rewritten by a migration that was asked about seeded rows.
    await storage.kvSet(...Object.values(row('wf.authored-by-a-human')) as [string, string]);
    const r = await reseedSeededRowsDeferred(storage);
    expect(r.total, 'only the wf.seed.* namespace is this migration\'s business').toBe(0);
  });

  it('counts an INPUT-BEARING head separately instead of converting it', async () => {
    // Deferred expansion MOVES params out of node `inputs` into `variables[]`, and
    // `tokenSubstitution` resolves `{{inputs.*}}` from node inputs at run time — so
    // converting one of these relocates data the other rows do not have. It needs a
    // decision, not a sweep.
    const withInputs = {
      key: 'wfreg:wf.seed.has-inputs',
      value: JSON.stringify({
        workflowId: 'wf.seed.has-inputs',
        nodes: [{ nodeId: 'n1', typeId: 'core.noop', config: {}, inputs: { q: '{{params.q}}' } }],
        edges: [],
        metadata: { name: 'x', expansionMode: 'expansion-time' },
      }),
    };
    await storage.kvSet(withInputs.key, withInputs.value);
    const r = await reseedSeededRowsDeferred(storage);
    expect(r.inputBearing).toEqual(['wf.seed.has-inputs']);
    expect(r.converted, 'an input-bearing head must not ride the same path as the others').toBe(0);
  });

  it('is idempotent — a second run converts nothing new', async () => {
    await storage.kvSet(...Object.values(row('wf.seed.gone-chain')) as [string, string]);
    const first = await reseedSeededRowsDeferred(storage);
    const second = await reseedSeededRowsDeferred(storage);
    expect(first.total, 'guard: 0 === 0 would satisfy idempotence vacuously').toBeGreaterThan(0);
    expect(second.converted).toBe(0);
    expect(second.total).toBe(first.total);
  });
});

describe('PHBC-5 — the migration must not turn a data problem into an outage', () => {
  it('does NOT throw on the production state (rows exist, no chain converts them)', async () => {
    // THE DEFECT I NEARLY SHIPPED. My first draft threw when rows existed and none
    // were convertible — which is EXACTLY the measured production state (71 rows
    // whose chains have left the corpus). `runAppMigrations` has no try/catch,
    // `recordAppVersion` is unguarded at index.ts:187, and main()'s catch does
    // `process.exit(1)` — so that throw would have crashed every instance on
    // deploy while "fixing" a silent-no-op bug.
    await storage.kvSet(...Object.values(row('wf.seed.chain-is-gone')) as [string, string]);
    const only16 = APP_MIGRATIONS.filter((m) => m.version === 16);
    expect(only16, 'fixture guard: migration 16 must exist or this proves nothing').toHaveLength(1);
    await expect(
      runAppMigrations(storage, only16),
      'a migration that cannot convert anything must be LOUD, never fatal',
    ).resolves.toBeTruthy();
  });

  it('still runs clean on a fresh install', async () => {
    const only16 = APP_MIGRATIONS.filter((m) => m.version === 16);
    await expect(runAppMigrations(storage, only16)).resolves.toBeTruthy();
  });
});

describe('PHBC-5 — migration 16 is actually WIRED', () => {
  // Mirrors the guard migration 15 has. A migration that exists in a module but
  // not in APP_MIGRATIONS never runs, and nothing else in the suite would notice —
  // which is the same invisible-by-construction failure this whole item is about.
  it('exists in the real array at a contiguous version with a run function', () => {
    const m = APP_MIGRATIONS.find((x) => x.name === 'reseed-seeded-rows-deferred');
    expect(m, 'no migration named `reseed-seeded-rows-deferred` — the helper would never run').toBeDefined();
    expect(m!.version).toBe(16);
    expect(typeof m!.run).toBe('function');
    const versions = APP_MIGRATIONS.map((x) => x.version).sort((a, b) => a - b);
    expect(versions, 'a gap or duplicate silently skips or double-runs work')
      .toEqual(versions.map((_, i) => i + 1));
    expect(latestAppMigration()).toBeGreaterThanOrEqual(16);
  });

  it('is reached by runAppMigrations on an install sitting at version 15', async () => {
    // The production case: migration 14 already recorded, so only a NEW version
    // can ever look at these rows again.
    await storage.setAppMeta('app_migration_version', '15');
    const applied = await runAppMigrations(storage);
    expect(applied.applied, 'an install at 15 must actually reach 16').toContain(16);
  });
});
