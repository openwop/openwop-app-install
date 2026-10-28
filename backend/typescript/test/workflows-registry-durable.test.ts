/**
 * ENG-3 (docs/steward/CODEBASE-ASSESSMENT.md): builder-registered workflows are now durable,
 * so a run re-dispatched by the sweeper on ANOTHER instance can still resolve a
 * workflow that was registered on the instance that crashed. Previously the
 * registry was a process-local Map and cross-instance resolution returned null.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { setDurableStorage } from '../src/host/durable/durableStore.js';
import {
  registerWorkflow,
  getRegisteredWorkflowAsync,
  getRegisteredWorkflow,
  deleteRegisteredWorkflow,
  readRegisteredWorkflowFresh,
  __clearRegistryCacheForTests,
} from '../src/host/workflowsRegistry.js';
import type { Storage } from '../src/storage/storage.js';

let dir: string;
let storage: Storage;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'owop-wfreg-'));
  storage = openSqliteStorage(join(dir, 'w.db'));
  setDurableStorage(storage);
  __clearRegistryCacheForTests();
});

afterEach(async () => {
  __clearRegistryCacheForTests();
  setDurableStorage(null);
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
});

const def = (id: string) => ({ workflowId: id, nodes: [{ nodeId: 'n1', typeId: 'core.identity' }] });

/** `registerWorkflow` / `deleteRegisteredWorkflow` write through fire-and-forget.
 *  Wait for the STORED row itself (a fresh storage read), never a fixed sleep: a
 *  20 ms sleep flaked under gate load, and read as "settled" even when the write
 *  was dropped. `vi.waitFor` throws on timeout. The fresh read refreshes this
 *  instance's cache, so callers clear the cache AFTER it. */
async function waitForStored(id: string, present: boolean): Promise<void> {
  await vi.waitFor(async () => {
    const { raw } = await readRegisteredWorkflowFresh(id);
    expect(raw === null ? 'absent' : 'present', `stored row for ${id}`).toBe(present ? 'present' : 'absent');
  }, { timeout: 2_000, interval: 10 });
}

describe('workflowsRegistry durability (ENG-3)', () => {
  it('resolves a registered workflow from storage after the cache is gone (≈ another instance)', async () => {
    registerWorkflow(def('wf-cross'));
    await waitForStored('wf-cross', true);

    // Simulate a fresh instance: drop the in-memory cache, keep storage.
    __clearRegistryCacheForTests();
    expect(getRegisteredWorkflow('wf-cross')).toBeUndefined(); // sync cache miss

    const resolved = await getRegisteredWorkflowAsync('wf-cross');
    expect(resolved).not.toBeNull();
    expect(resolved!.workflowId).toBe('wf-cross');
    // And it re-populated this instance's cache.
    expect(getRegisteredWorkflow('wf-cross')).toBeDefined();
  });

  it('returns null for an unknown workflow', async () => {
    expect(await getRegisteredWorkflowAsync('nope')).toBeNull();
  });

  it('a durable delete is visible cross-instance', async () => {
    registerWorkflow(def('wf-del'));
    await waitForStored('wf-del', true);
    deleteRegisteredWorkflow('wf-del');
    await waitForStored('wf-del', false);
    __clearRegistryCacheForTests();
    expect(await getRegisteredWorkflowAsync('wf-del')).toBeNull();
  });

  it('degrades to in-memory only when no storage is wired', async () => {
    setDurableStorage(null);
    registerWorkflow(def('wf-mem'));
    expect(getRegisteredWorkflow('wf-mem')).toBeDefined();
    __clearRegistryCacheForTests();
    expect(await getRegisteredWorkflowAsync('wf-mem')).toBeNull(); // nothing persisted
  });
});
