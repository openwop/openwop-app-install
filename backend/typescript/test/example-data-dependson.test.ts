/**
 * Seeder dependsOn auto-include (grade-data; the #1348/#1356 review finding).
 *
 * `runExampleDataSeed({steps})` must pull in each selected step's transitive
 * `dependsOn` ancestors in registry order (idempotent seeders make that safe),
 * mark them `autoIncluded`, and reflect the expansion in dry-run. `runDemoClear`
 * must NOT expand — a destructive operation never grows beyond the explicit
 * selection (architect ruling). Fixtures are the LIVE registry edges at HEAD:
 * workforces → agents, strategy-showcase → advisors.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { runExampleDataSeed, runDemoClear, EXAMPLE_DATA_SEEDERS } from '../src/host/exampleDataSeeders.js';

let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_DEMO_SEED_ENABLED = 'true';
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  // The real agents seeder now exercises host surfaces (ADR 0292 resilient
  // seeding); the app inits them at boot (src/index.ts), so the bare-storage
  // harness must too — otherwise the 'agents' ancestor errors and masks what
  // this file actually tests (dependsOn expansion).
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'owp-seed-dep-')) });
});

describe('runExampleDataSeed dependsOn auto-include', () => {
  it('registry sanity: the fixture edges exist', () => {
    expect(EXAMPLE_DATA_SEEDERS.find((s) => s.id === 'workforces')?.dependsOn).toContain('agents');
    expect(EXAMPLE_DATA_SEEDERS.find((s) => s.id === 'strategy-showcase')?.dependsOn).toContain('advisors');
  });

  it('dry-run of a dependent step includes its ancestor, marked autoIncluded, in registry order', async () => {
    const r = await runExampleDataSeed('dep-t1', storage, { steps: ['strategy-showcase'], dryRun: true });
    const ids = r.results.map((x) => x.step);
    expect(ids).toEqual(['advisors', 'strategy-showcase']); // ancestor first (registry order)
    expect(r.results.find((x) => x.step === 'advisors')?.autoIncluded).toBe(true);
    expect(r.results.find((x) => x.step === 'strategy-showcase')?.autoIncluded).toBeUndefined();
  });

  it('a real run seeds the ancestor first; re-run is idempotent with the same expansion', async () => {
    const r = await runExampleDataSeed('dep-t2', storage, { steps: ['workforces'] });
    expect(r.success).toBe(true);
    expect(r.results.map((x) => x.step)).toEqual(['agents', 'workforces']);
    const agents = r.results.find((x) => x.step === 'agents');
    expect(agents?.action).toBe('created');
    expect(agents?.autoIncluded).toBe(true);

    const again = await runExampleDataSeed('dep-t2', storage, { steps: ['workforces'] });
    expect(again.success).toBe(true);
    expect(again.results.map((x) => x.step)).toEqual(['agents', 'workforces']);
    expect(again.results.find((x) => x.step === 'agents')?.action).toBe('skipped');
  });

  it('clear does NOT expand to dependencies', async () => {
    const r = await runDemoClear('dep-t2', storage, { steps: ['workforces'] });
    expect(r.results.map((x) => x.step)).toEqual(['workforces']); // agents untouched
  });

  it('selecting every step explicitly marks nothing autoIncluded; unknown ids stay ignored', async () => {
    const r = await runExampleDataSeed('dep-t3', storage, { steps: ['agents', 'workforces', 'not-a-step'], dryRun: true });
    expect(r.results.map((x) => x.step)).toEqual(['agents', 'workforces']);
    expect(r.results.every((x) => x.autoIncluded === undefined)).toBe(true);
  });
});
