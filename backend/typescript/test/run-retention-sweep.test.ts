/**
 * ADR 0371 Phase 2 — the run sweeper: past-deadline terminal runs are swept
 * (full cascade), pins/holds/non-terminal survive (each counted), definition
 * TTL overrides RE-STAMP instead of delete, the quiet window gates the pass,
 * and a purged run reads back as null (the uniform-404 substrate).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
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
afterEach(() => {
  delete process.env.OPENWOP_RUN_RETENTION_WINDOW;
  delete process.env.OPENWOP_RUN_RETENTION_DAYS;
});

const PAST = '2026-01-01T00:00:00.000Z';

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
    expect(c.swept).toBeGreaterThanOrEqual(1);
    expect(await storage.getRun(runId)).toBeNull();
  });

  it('pinned survives forever; a legal hold survives while held (both counted)', async () => {
    const pinned = await seedRun({ metadata: { pinned: true } });
    const held = await seedRun({ tenantId: 'org:held' });
    await setRetentionHold('org:held', 'litigation');
    try {
      const c = await __runRetentionSweepOnce(storage);
      expect(c.skippedPinned).toBeGreaterThanOrEqual(1);
      expect(c.skippedHold).toBeGreaterThanOrEqual(1);
      expect(await storage.getRun(pinned)).toBeTruthy();
      expect(await storage.getRun(held)).toBeTruthy();
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
      expect(c.restampedOverride).toBeGreaterThanOrEqual(1);
      const run = await storage.getRun(runId);
      expect(run).toBeTruthy();
      expect(Date.parse(run!.removalAt!)).toBeGreaterThan(Date.now());
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
    expect(c.clearedNonTerminal).toBeGreaterThanOrEqual(1);
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
      expect(c.exported).toBeGreaterThanOrEqual(1);
      expect(await storage.getRun(runId)).toBeNull();
      const blob = buildHostSurfaceBundle({ tenantId: 'org:export' }).storage.blob;
      const got = await blob.get({ key: `retention-export/${runId}.ndjson` });
      const content = Buffer.from(String((got as { contentBase64?: string }).contentBase64 ?? ''), 'base64').toString('utf8');
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
      expect(g.gcDeleted).toBeGreaterThanOrEqual(1);
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
