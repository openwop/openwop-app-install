/**
 * ENG-3 (CODEBASE-ASSESSMENT.md): builder-registered workflows are now durable,
 * so a run re-dispatched by the sweeper on ANOTHER instance can still resolve a
 * workflow that was registered on the instance that crashed. Previously the
 * registry was a process-local Map and cross-instance resolution returned null.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

describe('workflowsRegistry durability (ENG-3)', () => {
  it('resolves a registered workflow from storage after the cache is gone (≈ another instance)', async () => {
    registerWorkflow(def('wf-cross'));
    // Let the fire-and-forget write-through settle.
    await new Promise((r) => setTimeout(r, 20));

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
    await new Promise((r) => setTimeout(r, 20));
    deleteRegisteredWorkflow('wf-del');
    await new Promise((r) => setTimeout(r, 20));
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
