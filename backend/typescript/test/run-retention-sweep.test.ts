/**
 * ADR 0371 Phase 2 — the run sweeper: past-deadline terminal runs are swept
 * (full cascade), pins/holds/non-terminal survive (each counted), definition
 * TTL overrides RE-STAMP instead of delete, the quiet window gates the pass,
 * and a purged run reads back as null (the uniform-404 substrate).
 *
 * Every counter is asserted EXACTLY: each case cleans up its own rows, and the
 * `beforeEach` refuses to start while any stamped row is left over, so a count
 * met by another case's leftover row shows as a setup failure, not a pass.
 *
 * Sabotage witnessed red (8f grade-tests wave 2): the delete dropped
 * (`8fw2g3-ret-delete`), the pinned check (`-ret-pinned`), the hold check
 * (`-ret-hold`), a hold read for the WRONG tenant (`-ret-hold-scope-r2`), the
 * override re-stamp (`-ret-restamp`), the non-terminal stamp clear
 * (`-ret-clearstamp`), the export gate (`-ret-export`), the window gate and the
 * overnight span (`-ret-window-gate`, `-ret-window-overnight`), and the GC's
 * archived-only / referenced / ownership-row guards (`-gc-archived-only`,
 * `-gc-referenced`, `-gc-ownership`).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { __runRetentionSweepOnce, __runTransientDefGcOnce, setRetentionHold, clearRetentionHold, inSweepWindow } from '../src/host/runRetentionSweeper.js';
import { recordOwnership, getOwned } from '../src/host/workflowOwnership.js';
import { getRegisteredWorkflow } from '../src/host/workflowsRegistry.js';
import { initInMemorySurfaces, buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerWorkflow, deleteRegisteredWorkflow } from '../src/host/workflowsRegistry.js';

let storage: Storage;
beforeAll(async () => {
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-retention-')) });
});
// Far past any stamp a case writes (the override case re-stamps into 2035).
const FAR_FUTURE = '2099-01-01T00:00:00.000Z';
beforeEach(async () => {
  expect(await storage.listRunsPastRemoval(FAR_FUTURE, 1000)).toEqual([]);
});
afterEach(() => {
  delete process.env.OPENWOP_RUN_RETENTION_WINDOW;
  delete process.env.OPENWOP_RUN_RETENTION_DAYS;
});

const PAST = '2026-01-01T00:00:00.000Z';
const DAY_MS = 86_400_000;

/** The in-memory blob surface's `get` result (`inMemorySurfaces.ts` createBlob). */
interface FoundBlob { found: true; contentBase64: string; contentType?: string }
function isFoundBlob(x: unknown): x is FoundBlob {
  return typeof x === 'object' && x !== null && (x as { found?: unknown }).found === true
    && typeof (x as { contentBase64?: unknown }).contentBase64 === 'string';
}

async function seedRun(over: Partial<RunRecord> = {}): Promise<string> {
  const runId = randomUUID();
  const now = new Date().toISOString();
  await storage.insertRun({
    runId, workflowId: over.workflowId ?? 'wf-ret', tenantId: over.tenantId ?? 'org:ret',
    status: 'running', inputs: null, metadata: over.metadata ?? {}, configurable: {},
    createdAt: now, updatedAt: now,
  });
  // Terminal + a deadline already in the past (explicit stamps never overridden).
  await storage.updateRun(runId, {
    status: over.status ?? 'completed',
    completedAt: over.completedAt ?? PAST,
    removalAt: over.removalAt ?? PAST,
    ...(over.metadata ? { metadata: over.metadata } : {}),
  });
  return runId;
}

describe('run retention sweeper (ADR 0371 P2)', () => {
  it('sweeps past-deadline terminal runs; the purged run reads back null', async () => {
    const runId = await seedRun();
    const c = await __runRetentionSweepOnce(storage);
    expect(c).toMatchObject({ scanned: 1, swept: 1, skippedPinned: 0, skippedHold: 0, restampedOverride: 0, clearedNonTerminal: 0 });
    expect(await storage.getRun(runId)).toBeNull();
  });

  it('pinned survives forever; a legal hold survives while held (both counted)', async () => {
    const pinned = await seedRun({ metadata: { pinned: true } });
    const held = await seedRun({ tenantId: 'org:held' });
    // The hold is the HELD tenant's: a run of another tenant sweeps under it.
    const bystander = await seedRun({ tenantId: 'org:not-held' });
    await setRetentionHold('org:held', 'litigation');
    try {
      const c = await __runRetentionSweepOnce(storage);
      expect(c).toMatchObject({ scanned: 3, skippedPinned: 1, skippedHold: 1, swept: 1 });
      expect(await storage.getRun(pinned)).toBeTruthy();
      expect(await storage.getRun(held)).toBeTruthy();
      expect(await storage.getRun(bystander)).toBeNull();

      // "While held": once the hold clears, the next pass sweeps the held run;
      // the pinned one still survives.
      await clearRetentionHold('org:held');
      const after = await __runRetentionSweepOnce(storage);
      expect(after).toMatchObject({ scanned: 2, skippedPinned: 1, skippedHold: 0, swept: 1 });
      expect(await storage.getRun(held)).toBeNull();
      expect(await storage.getRun(pinned)).toBeTruthy();
    } finally {
      await clearRetentionHold('org:held');
      await storage.deleteRun(pinned);
      await storage.deleteRun(held);
    }
  });

  it('a definition TTL override extending past now RE-STAMPS instead of deleting', async () => {
    const wfId = `wf-override-${Date.now()}`;
    registerWorkflow({ workflowId: wfId, nodes: [{ nodeId: 'a', typeId: 'core.noop' }], metadata: { retention: { ttlDays: 3650 } } });
    try {
      const runId = await seedRun({ workflowId: wfId, completedAt: PAST });
      const c = await __runRetentionSweepOnce(storage);
      expect(c).toMatchObject({ scanned: 1, restampedOverride: 1, swept: 0 });
      const run = await storage.getRun(runId);
      expect(run).toBeTruthy();
      // completedAt (2026-01-01) + 3650 days, computed by hand.
      expect(run!.removalAt).toBe('2035-12-30T00:00:00.000Z');
      expect(Date.parse(run!.removalAt!)).toBe(Date.parse(PAST) + 3650 * DAY_MS);
      await storage.deleteRun(runId);
    } finally {
      deleteRegisteredWorkflow(wfId);
    }
  });

  it('a stamped NON-terminal run is never deleted — the stale stamp clears', async () => {
    // Simulate the oddity: stamp, then the run "resumes" (status back to running).
    const runId = await seedRun();
    await storage.updateRun(runId, { status: 'running' });
    const c = await __runRetentionSweepOnce(storage);
    expect(c).toMatchObject({ scanned: 1, clearedNonTerminal: 1, swept: 0 });
    const run = await storage.getRun(runId);
    expect(run).toBeTruthy();
    expect(run!.removalAt).toBeUndefined();
    await storage.deleteRun(runId);
  });

  it('export-before-delete (opt-in): the NDJSON blob lands, THEN the row dies (ADR 0371 P3)', async () => {
    process.env.OPENWOP_RUN_RETENTION_EXPORT = 'true';
    try {
      const runId = await seedRun({ tenantId: 'org:export' });
      const c = await __runRetentionSweepOnce(storage);
      expect(c).toMatchObject({ scanned: 1, exported: 1, exportFailed: 0, swept: 1 });
      expect(await storage.getRun(runId)).toBeNull();
      const blob = buildHostSurfaceBundle({ tenantId: 'org:export' }).storage.blob;
      const got: unknown = await blob.get({ key: `retention-export/${runId}.ndjson` });
      if (!isFoundBlob(got)) throw new Error(`export blob missing: ${JSON.stringify(got)}`);
      const content = Buffer.from(got.contentBase64, 'base64').toString('utf8');
      expect(content.split('\n')[0]).toContain('"kind":"run"');
      expect(content).toContain(runId);
    } finally {
      delete process.env.OPENWOP_RUN_RETENTION_EXPORT;
    }
  });

  it('the 0369 GC: an ARCHIVED transient def with zero remaining runs hard-deletes (+ ownership row); referenced/live defs survive (ADR 0371 P4)', async () => {
    const gone = `gc-gone-${Date.now()}`;
    const kept = `gc-kept-${Date.now()}`;
    const live = `gc-live-${Date.now()}`;
    const lc = { transient: true, generatedBy: 'workflow-builder', archivedAt: PAST };
    registerWorkflow({ workflowId: gone, nodes: [{ nodeId: 'a', typeId: 'core.noop' }], metadata: { lifecycle: lc } });
    registerWorkflow({ workflowId: kept, nodes: [{ nodeId: 'a', typeId: 'core.noop' }], metadata: { lifecycle: lc } });
    registerWorkflow({ workflowId: live, nodes: [{ nodeId: 'a', typeId: 'core.noop' }], metadata: { lifecycle: { transient: true } } }); // NOT archived
    await recordOwnership('org:gc', gone, { nodeCount: 1, transient: true });
    const keptRun = await seedRun({ workflowId: kept, metadata: { pinned: true } }); // a surviving run pins the DEF too
    try {
      const g = await __runTransientDefGcOnce(storage);
      // `gone` and `kept` are the only archived transient defs in this file.
      expect(g).toEqual({ gcScanned: 2, gcDeleted: 1 });
      expect(getRegisteredWorkflow(gone)).toBeUndefined();
      expect(await getOwned('org:gc', gone)).toBeNull();
      expect(getRegisteredWorkflow(kept)).toBeTruthy(); // still referenced by a run
      expect(getRegisteredWorkflow(live)).toBeTruthy(); // unarchived drafts never gc
    } finally {
      await storage.deleteRun(keptRun);
      deleteRegisteredWorkflow(kept);
      deleteRegisteredWorkflow(live);
    }
  });

  it('the quiet window gates the whole pass; overnight spans work', async () => {
    process.env.OPENWOP_RUN_RETENTION_WINDOW = '01:00-05:00';
    expect(inSweepWindow(new Date('2026-07-15T03:00:00Z'))).toBe(true);
    expect(inSweepWindow(new Date('2026-07-15T12:00:00Z'))).toBe(false);
    process.env.OPENWOP_RUN_RETENTION_WINDOW = '22:00-04:00';
    expect(inSweepWindow(new Date('2026-07-15T23:30:00Z'))).toBe(true);
    expect(inSweepWindow(new Date('2026-07-15T12:00:00Z'))).toBe(false);

    const runId = await seedRun();
    const c = await __runRetentionSweepOnce(storage, new Date('2026-07-15T12:00:00Z'));
    expect(c.scanned).toBe(0);
    expect(await storage.getRun(runId)).toBeTruthy();
    await storage.deleteRun(runId);
  });
});
