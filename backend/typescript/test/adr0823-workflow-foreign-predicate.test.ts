/**
 * ADR 0823 D1/D5 — the cross-tenant predicate itself, below the HTTP witness.
 *
 * The route test proves the launchers ask it; this proves what it answers,
 * including the two branches no route can reach: a store that THROWS (must
 * propagate, never answer "foreign" — a resume would read that as a permanent
 * "workflow gone") and a process with no host-ext store bound at all.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { isWorkflowForeignTo, recordOwnership } from '../src/host/workflowOwnership.js';

describe('ADR 0823 — isWorkflowForeignTo', () => {
  beforeEach(async () => {
    __resetHostExtPersistence();
    initHostExtPersistence(await openStorage('memory://'));
  });
  afterAll(() => { __resetHostExtPersistence(); });

  it('owned → not foreign; owned by another tenant → foreign; unowned (host) → not foreign', async () => {
    await recordOwnership('org:a', 'wf-pred-a', { name: 'a', nodeCount: 1 });
    expect(await isWorkflowForeignTo('org:a', 'wf-pred-a')).toBe(false);
    expect(await isWorkflowForeignTo('org:b', 'wf-pred-a')).toBe(true);
    expect(await isWorkflowForeignTo('org:b', 'wf-pred-unowned-host-def')).toBe(false);
  });

  it('a dual-owned id is not foreign to either owner', async () => {
    await recordOwnership('org:a', 'wf-pred-dual', { name: 'd', nodeCount: 1 });
    await recordOwnership('org:b', 'wf-pred-dual', { name: 'd', nodeCount: 1 });
    expect(await isWorkflowForeignTo('org:a', 'wf-pred-dual')).toBe(false);
    expect(await isWorkflowForeignTo('org:b', 'wf-pred-dual')).toBe(false);
    expect(await isWorkflowForeignTo('org:c', 'wf-pred-dual')).toBe(true);
  });

  it('a SHARED id is never foreign, even when only another tenant holds a row', async () => {
    await recordOwnership('org:a', 'wf.seed.pred-shared', { name: 's', nodeCount: 1 });
    expect(await isWorkflowForeignTo('org:b', 'wf.seed.pred-shared')).toBe(false);
    expect(await isWorkflowForeignTo('org:b', 'walkthrough.chat.first-message')).toBe(false);
  });

  it('D5 — a store error PROPAGATES; it is never answered as "foreign" or "not foreign"', async () => {
    __resetHostExtPersistence();
    const broken = new Proxy({} as Storage, {
      get: () => () => { throw new Error('db down'); },
    });
    initHostExtPersistence(broken);
    await expect(isWorkflowForeignTo('org:b', 'wf-pred-a')).rejects.toThrow('db down');
    // The shared short-circuit needs no store, so it still answers.
    expect(await isWorkflowForeignTo('org:b', 'wf.seed.x')).toBe(false);
  });

  it('D5 — a test process with no store bound has no rows, so nothing is foreign', async () => {
    __resetHostExtPersistence();
    expect(await isWorkflowForeignTo('org:b', 'wf-pred-a')).toBe(false);
  });
});
