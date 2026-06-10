/**
 * A7 — atomic approval claim. The pending→resolved transition is a real
 * compare-and-swap (DurableCollection.compareAndSwap → storage kvCompareAndSwap),
 * so two concurrent claims on the same approval resolve EXACTLY ONCE: one wins
 * (changed:true), the rest observe the resolved row (changed:false). Closes the
 * get→put double-dispatch window the deep-dive flagged.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createApproval, resolveApproval, __resetApprovalStore } from '../src/host/approvalService.js';
import type { Storage } from '../src/storage/storage.js';

let dir: string;
let storage: Storage;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'owop-appr-'));
  storage = openSqliteStorage(join(dir, 'a.db'));
  initHostExtPersistence(storage);
  await __resetApprovalStore();
});

afterEach(async () => {
  await storage.close();
  __resetHostExtPersistence();
  rmSync(dir, { recursive: true, force: true });
});

describe('approval claim CAS (A7)', () => {
  it('resolves exactly once under concurrent claims', async () => {
    const appr = await createApproval({
      tenantId: 't', rosterId: 'r', persona: 'P', workflowId: 'wf', proposal: 'do it',
    });

    // Fire several concurrent claims for the SAME approval.
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        resolveApproval(appr.approvalId, { status: 'approved', runId: `run-${i}` }),
      ),
    );

    const changed = results.filter((r) => r?.changed === true);
    expect(changed).toHaveLength(1); // exactly one winner
    // Everyone observes the same resolved approval id, status approved.
    for (const r of results) {
      expect(r?.approval.approvalId).toBe(appr.approvalId);
      expect(r?.approval.status).toBe('approved');
    }
  });

  it('a second claim after resolution reports changed:false', async () => {
    const appr = await createApproval({ tenantId: 't', rosterId: 'r', persona: 'P', workflowId: 'wf', proposal: 'x' });
    const first = await resolveApproval(appr.approvalId, { status: 'approved' });
    const second = await resolveApproval(appr.approvalId, { status: 'rejected' });
    expect(first?.changed).toBe(true);
    expect(second?.changed).toBe(false);
    expect(second?.approval.status).toBe('approved'); // first write wins; not overwritten
  });
});
