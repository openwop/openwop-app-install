/**
 * Anon-tenant seeded schedules are DISABLED (2026-07-14 incident: every anon
 * demo visitor got enabled standing crons; each anon tenant is its own
 * autonomous-run budget so nothing capped the fleet — 1,054 enabled anon jobs
 * ≈ 2.9k runs/day accumulated). Seeds stay VISIBLE (registered) but inert for
 * `anon:*` tenants; signed-in tenants keep enabled seeds. Non-vacuous: both
 * tenants must actually receive schedule rows.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';
import { seedExampleAgents } from '../src/host/exampleDataSeed.js';
import { listJobs } from '../src/host/schedulingService.js';

let storage: Awaited<ReturnType<typeof openStorage>>;
beforeAll(async () => {
  process.env.OPENWOP_DEMO_SEED_ENABLED = 'true';
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'owp-anon-sched-')) });
});

describe('seeded schedules — anon tenants get them disabled', () => {
  it('anon:* seeds register schedules with enabled:false; signed-in seeds stay enabled', async () => {
    const anonTenant = 'anon:sched-seed-test';
    const userTenant = 'user:sched-seed-test';
    await seedExampleAgents(anonTenant, storage, { heal: true, skipWorkforces: true });
    await seedExampleAgents(userTenant, storage, { heal: true, skipWorkforces: true });

    const anonJobs = await listJobs(anonTenant);
    const userJobs = await listJobs(userTenant);
    expect(anonJobs.length).toBeGreaterThan(0); // non-vacuous: schedules ARE seeded
    expect(userJobs.length).toBeGreaterThan(0);
    expect(anonJobs.every((j) => j.enabled === false)).toBe(true);
    expect(userJobs.every((j) => j.enabled === true)).toBe(true);
  });
});
