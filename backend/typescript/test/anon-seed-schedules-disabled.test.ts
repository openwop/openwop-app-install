/**
 * Seeded schedules never fire mock work on their own.
 *
 * - Anon tenants (2026-07-14 incident): every anon demo visitor got enabled
 *   standing crons; each anon tenant is its own autonomous-run budget so nothing
 *   capped the fleet — 1,054 enabled anon jobs ≈ 2.9k runs/day accumulated.
 * - Signed-in tenants (ADR 0939, prod pause 2026-10-19 + correction 2026-10-25):
 *   a schedule bound to a Work-Twin mock archive (`tmpl.*`) writes fabricated
 *   "Mock response to: …" output. The Oct 19 pause disabled the 65 that existed,
 *   but this seed kept minting ENABLED ones for every new signed-in tenant — 13
 *   were found firing on a tenant seeded 2026-10-23 (`it.incident-triage` every
 *   30 min). A seed is not a person; turning one on is the authorization.
 *
 * Seeds stay VISIBLE (registered) but inert. Non-vacuous: both tenants must
 * actually receive schedule rows, and the signed-in rows must be archive-bound.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';
import { seedExampleAgents } from '../src/host/exampleDataSeed.js';
import { deleteJob, listJobs } from '../src/host/schedulingService.js';
import { isWorkTwinMockArchive } from '../src/host/workflowTemplates.js';

let storage: Awaited<ReturnType<typeof openStorage>>;
beforeAll(async () => {
  process.env.OPENWOP_DEMO_SEED_ENABLED = 'true';
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'owp-anon-sched-')) });
});

describe('seeded schedules — never enabled on a mock archive', () => {
  it('anon:* seeds register every schedule with enabled:false', async () => {
    const anonTenant = 'anon:sched-seed-test';
    await seedExampleAgents(anonTenant, storage, { heal: true, skipWorkforces: true });
    const anonJobs = await listJobs(anonTenant);
    expect(anonJobs.length).toBeGreaterThan(0); // non-vacuous: schedules ARE seeded
    expect(anonJobs.every((j) => j.enabled === false)).toBe(true);
  });

  it('signed-in seeds bound to a tmpl.* mock archive are registered disabled (ADR 0939)', async () => {
    const userTenant = 'user:sched-seed-test';
    await seedExampleAgents(userTenant, storage, { heal: true, skipWorkforces: true });
    const archiveJobs = (await listJobs(userTenant)).filter((j) => isWorkTwinMockArchive(j.workflowId));
    expect(archiveJobs.length).toBeGreaterThan(0);
    expect(archiveJobs.filter((j) => j.enabled).map((j) => j.jobId)).toEqual([]);
  });

  it('the heal path restores a missing archive-bound schedule disabled, too', async () => {
    const userTenant = 'user:sched-heal-test';
    await seedExampleAgents(userTenant, storage, { heal: true, skipWorkforces: true });
    const victim = (await listJobs(userTenant)).find((j) => isWorkTwinMockArchive(j.workflowId));
    if (!victim) throw new Error('seed registered no archive-bound schedule');
    expect(await deleteJob(victim.jobId)).toBe(true);

    await seedExampleAgents(userTenant, storage, { heal: true, skipWorkforces: true });
    const healed = (await listJobs(userTenant)).find((j) => j.jobId === victim.jobId);
    if (!healed) throw new Error('heal did not restore the deleted schedule'); // non-vacuous
    expect(healed.enabled).toBe(false);
  });
});
