/**
 * Seeder dependsOn auto-include (grade-data; the #1348/#1356 review finding).
 *
 * `runExampleDataSeed({steps})` must pull in each selected step's transitive
 * `dependsOn` ancestors in registry order (idempotent seeders make that safe),
 * mark them `autoIncluded`, and reflect the expansion in dry-run. `runDemoClear`
 * must NOT expand — a destructive operation never grows beyond the explicit
 * selection (architect ruling). Fixtures are the LIVE registry edges at HEAD:
 * workforces → agents, strategy-showcase → advisors.
 *
 * TST-DAD-8. Every case uses its own tenant. Red when (sabotage-witnessed,
 * wave 70): seed selection stops following `dependsOn`; `autoIncluded` marks
 * explicitly named steps; clear expands to dependencies.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { runExampleDataSeed, runDemoClear, EXAMPLE_DATA_SEEDERS } from '../src/host/exampleDataSeeders.js';

let storage: Storage;
const priorSeedFlag = process.env.OPENWOP_DEMO_SEED_ENABLED;

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

afterAll(() => {
  if (priorSeedFlag === undefined) delete process.env.OPENWOP_DEMO_SEED_ENABLED;
  else process.env.OPENWOP_DEMO_SEED_ENABLED = priorSeedFlag;
});

const agentsSeeder = () => {
  const s = EXAMPLE_DATA_SEEDERS.find((x) => x.id === 'agents');
  if (!s) throw new Error('agents seeder missing from the registry');
  return s;
};

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
    // Own tenant: seeding workforces pulls in agents (the ancestor).
    expect((await runExampleDataSeed('dep-t4', storage, { steps: ['workforces'] })).success).toBe(true);
    const agentsBefore = await agentsSeeder().count('dep-t4', storage);
    expect(agentsBefore, 'premise: the ancestor really seeded rows').toBeGreaterThan(0);

    const r = await runDemoClear('dep-t4', storage, { steps: ['workforces'] });
    expect(r.results.map((x) => x.step)).toEqual(['workforces']);
    // ...and the ancestor's rows are untouched.
    expect(await agentsSeeder().count('dep-t4', storage)).toBe(agentsBefore);
  });

  it('selecting every step explicitly marks nothing autoIncluded; unknown ids stay ignored', async () => {
    const r = await runExampleDataSeed('dep-t3', storage, { steps: ['agents', 'workforces', 'not-a-step'], dryRun: true });
    expect(r.results.map((x) => x.step)).toEqual(['agents', 'workforces']);
    expect(r.results.every((x) => x.autoIncluded === undefined)).toBe(true);
  });
});
