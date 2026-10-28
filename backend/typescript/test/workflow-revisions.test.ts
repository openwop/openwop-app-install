/**
 * ADR 0474 P1a-1 — the revision store. Pins: append + idempotent same-content
 * upsert; lifecycle-verb re-registers mint NO noise revision (the lifecycle-
 * stripped hash); the supersedes chain orders history; keep-N prune spares the
 * published revision + head; the registry delete cascades revisions.
 *
 * Sabotage-witnessed (grade-tests wave 64): dropping `supersedes`, hashing the
 * lifecycle, pruning the published row, never pruning, unhooking the cascade,
 * and re-inserting identical content (seq bump) each red their case
 * (8fw5g5-wr-*).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import {
  recordRevision,
  listRevisions,
  getRevision,
  deleteWorkflowRevisions,
} from '../src/host/workflowRevisions.js';
import { revisionHashOf, definitionHashOf } from '../src/host/definitionHash.js';
import { registerWorkflow, deleteRegisteredWorkflow } from '../src/host/workflowsRegistry.js';
import { withLifecycle } from '../src/host/workflowLifecycle.js';
import { recordOwnership, removeOwnership } from '../src/host/workflowOwnership.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TENANT = 'org:rev-test';
let storage: Storage;
const cleanup: string[] = [];

beforeAll(async () => {
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-rev-')) });
});
afterEach(async () => {
  for (const id of cleanup.splice(0)) {
    deleteRegisteredWorkflow(id);
    await deleteWorkflowRevisions(id);
    await removeOwnership(TENANT, id);
  }
  delete process.env.OPENWOP_WORKFLOW_REVISIONS_KEEP;
});

function def(id: string, nodes: Array<{ nodeId: string; typeId: string }>, name = 'Rev Test'): WorkflowDefinition {
  return { workflowId: id, nodes, edges: [], metadata: { name } };
}

describe('workflow revisions (ADR 0474)', () => {
  it('appends on content change, upserts on identical content', async () => {
    const id = 'rev-wf-append';
    cleanup.push(id);
    const v1 = def(id, [{ nodeId: 'a', typeId: 'core.noop' }]);
    const h1 = await recordRevision(TENANT, v1);
    expect(h1).toBe(revisionHashOf(v1));
    // identical content again — no new row. The key is content-addressed, so a
    // row COUNT cannot tell an upsert from a blind re-insert; the re-insert would
    // bump `seq` to 2 (8fw5g5-wr-upsert-r2), the upsert leaves the row untouched.
    const before = (await listRevisions(id))[0]!;
    await recordRevision(TENANT, v1);
    const once = await listRevisions(id);
    expect(once.length).toBe(1);
    expect(once[0]!.seq).toBe(1);
    expect(once[0]!.createdAt).toBe(before.createdAt);
    // content change — new row, chained
    const v2 = def(id, [{ nodeId: 'a', typeId: 'core.noop' }, { nodeId: 'b', typeId: 'core.noop' }]);
    const h2 = await recordRevision(TENANT, v2);
    const rows = await listRevisions(id);
    expect(rows.length).toBe(2);
    expect(rows[0]!.revisionHash).toBe(h2);
    expect(rows[0]!.supersedes).toBe(h1);
    expect((await getRevision(id, h1!))?.definition.nodes.length).toBe(1);
  });

  it('a lifecycle-only re-register mints NO revision (stripped hash)', async () => {
    const id = 'rev-wf-lifecycle';
    cleanup.push(id);
    const v1 = def(id, [{ nodeId: 'a', typeId: 'core.noop' }]);
    await recordRevision(TENANT, v1);
    const archived = withLifecycle(v1, { archivedAt: new Date().toISOString() });
    expect(definitionHashOf(archived)).not.toBe(definitionHashOf(v1)); // full hash moves…
    expect(revisionHashOf(archived)).toBe(revisionHashOf(v1));         // …revision hash doesn't
    await recordRevision(TENANT, archived);
    expect((await listRevisions(id)).length).toBe(1);
  });

  it('keep-N prune spares the published revision and the head', async () => {
    process.env.OPENWOP_WORKFLOW_REVISIONS_KEEP = '2';
    // The pruner also spares the newest row of each calendar DAY; pin the clock so
    // the four writes can never straddle midnight and spare v2 by accident.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-07-23T12:00:00.000Z'));
    try {
    const id = 'rev-wf-prune';
    cleanup.push(id);
    const v1 = def(id, [{ nodeId: 'a', typeId: 'core.noop' }], 'v1');
    const h1 = await recordRevision(TENANT, v1);
    // publish v1 (ownership carries the pin the pruner consults)
    await recordOwnership(TENANT, id, { nodeCount: 1, publishedRevision: h1! });
    const v2 = def(id, [{ nodeId: 'b', typeId: 'core.noop' }], 'v2');
    const h2 = await recordRevision(TENANT, v2);
    const v3 = def(id, [{ nodeId: 'c', typeId: 'core.noop' }], 'v3');
    const h3 = await recordRevision(TENANT, v3);
    const v4 = def(id, [{ nodeId: 'd', typeId: 'core.noop' }], 'v4');
    const h4 = await recordRevision(TENANT, v4);
    const left = (await listRevisions(id)).map((r) => r.revisionHash).sort();
    // h1 published — never pruned; h4 head; h3 inside the keep-2 window; h2 pruned.
    expect(left).toEqual([h1!, h3!, h4!].sort());
    expect(left).not.toContain(h2!);
    } finally {
      vi.useRealTimers();
    }
  });

  it('deleting the registered workflow cascades its revisions (the hook)', async () => {
    const id = 'rev-wf-cascade';
    const v1 = def(id, [{ nodeId: 'a', typeId: 'core.noop' }]);
    registerWorkflow(v1);
    await recordRevision(TENANT, v1);
    expect((await listRevisions(id)).length).toBe(1);
    deleteRegisteredWorkflow(id);
    // The hook is fire-and-forget: wait for the real condition, and fail
    // (naming it) if the cascade never lands.
    await vi.waitFor(async () => {
      expect((await listRevisions(id)).length, `revisions of ${id} not cascaded`).toBe(0);
    }, { timeout: 2000, interval: 10 });
  });
});
