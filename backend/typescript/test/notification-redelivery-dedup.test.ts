/**
 * ADR 0591 P4 — RFC 0158 §C.7 Layer-2 dedup on the notification seam.
 *
 * THE DEFECT THIS CLOSES WAS REAL AND USER-VISIBLE. The ADR 0531 replay guard
 * only refuses when `sourceOutcomes` is present, i.e. during a replay/fork. A
 * dispatch-RECOVERY re-dispatch is not a replay: `runDispatchSweeper.ts:201`
 * calls `executeRun` with no `resumeSnapshot`/`resumeFromNodeIndex`, and
 * `sourceOutcomes` is populated only for `replayInvocationsFromRunId`
 * (`executor.ts:1496-1505`). So an orphaned run — `status IN ('pending',
 * 'running')` with an expired dispatch lease, no filter on whether its nodes
 * already completed — RESTARTS FROM THE TOP with `replaying: false`, the guard
 * allows, and a real person is notified a second time.
 *
 * §C.7 is a MUST-dedupe: "Duplicate delivery … MUST NOT produce duplicate
 * external effects. Hosts MUST dedupe on an identity that survives
 * redelivery." So PASS is `count === 1`, and before this fix this host
 * produced 2.
 *
 * The fix reuses the ONE dedup mechanism (`executor/invocationLog.ts`, keyed by
 * the RFC 0150 §B identity) rather than standing up a second beside it. It
 * works because the recovery lane re-executes the node from the start, so the
 * ordinal — and therefore the identity — reproduces.
 *
 * `resetLogicalInvocationOrdinals()` models the re-dispatch: a re-executing
 * node begins its ordinal sequence again from 0.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { runWithEffectContext } from '../src/host/runEffectContext.js';
import { setEffectEscapeBackend } from '../src/host/effectEscapeLedger.js';
import { setInvocationBackend } from '../src/executor/invocationLog.js';
import { resetLogicalInvocationOrdinals } from '../src/host/effectIdentity.js';
import { getNotificationEmitter, setNotificationBackend } from '../src/notifications/emitter.js';
import type { Storage } from '../src/storage/storage.js';

const CTX = { runId: 'run-dd', replaying: false, nodeId: 'notify', tenantId: 't1', attempt: 1 };

const INPUT = {
  tenantId: 't1',
  recipientUserId: 'u1',
  type: 'approval.needed',
  priority: 'normal' as const,
  title: 'Approve the thing',
  message: 'Please approve.',
};

async function freshHost(): Promise<Storage> {
  const dir = mkdtempSync(join(tmpdir(), 'adr0591-dd-'));
  const storage = await openStorage(`sqlite://${join(dir, 'dd.db')}`);
  setNotificationBackend(storage);
  setEffectEscapeBackend(storage);
  setInvocationBackend(storage);
  return storage;
}

/** One node execution: the ordinal sequence restarts, as it does on a real
 *  re-dispatch (`beginNodeActivity` resets the counter per node execution). */
async function executeNodeOnce(): Promise<string> {
  resetLogicalInvocationOrdinals();
  return await runWithEffectContext(CTX, async () => {
    const rec = await getNotificationEmitter().emit({ ...INPUT });
    return rec.notificationId;
  });
}

beforeEach(() => {
  resetLogicalInvocationOrdinals();
});

describe('ADR 0591 P4 — notification redelivery dedup (RFC 0158 §C.7)', () => {
  it('a re-dispatch does NOT notify a second time — one row, one ledger escape, same record', async () => {
    const storage = await freshHost();

    const firstId = await executeNodeOnce();   // original dispatch
    const secondId = await executeNodeOnce();  // orphan lane re-dispatches the run

    // THE USER-VISIBLE ASSERTION: one notification row, not two. Before the fix
    // this was 2 and a real person saw the message twice.
    const rows = await storage.listNotifications({ tenantId: 't1', limit: 50 });
    expect(rows).toHaveLength(1);

    // The suppressed emit returns what the first delivery produced, so callers
    // that use the returned record keep working across a redelivery.
    expect(secondId).toBe(firstId);

    // And the §C.7 witness reads exactly 1 — the suppressed emit appended NO
    // ledger row. If the append sat before the dedup decision this would be 2
    // and the conformance row would fail against a now-correct host.
    const escapes = await storage.listEffectEscapes('run-dd');
    expect(escapes).toHaveLength(1);
    expect(escapes[0]!.count).toBe(1);
  });

  it('two DISTINCT logical effects in one execution both fire — dedup is per identity, not a mute', async () => {
    // The counterweight. A fix that suppressed everything after the first emit
    // would pass the test above and be catastrophically wrong.
    const storage = await freshHost();
    resetLogicalInvocationOrdinals();
    await runWithEffectContext(CTX, async () => {
      await getNotificationEmitter().emit({ ...INPUT, title: 'first' });
      await getNotificationEmitter().emit({ ...INPUT, title: 'second' });
    });

    expect(await storage.listNotifications({ tenantId: 't1', limit: 50 })).toHaveLength(2);
    const escapes = await storage.listEffectEscapes('run-dd');
    expect(escapes).toHaveLength(2);
    expect(escapes.map((e) => e.count)).toEqual([1, 1]);
  });

  it('still emits outside a run — an effect with no logical identity must not be silently muted', async () => {
    // No ambient context ⇒ no identity ⇒ no dedup possible. The correct
    // behaviour is to DELIVER, not to swallow: a host route or daemon emitting
    // a notification must never be silenced by a dedup path that cannot even
    // name the effect.
    const storage = await freshHost();
    await getNotificationEmitter().emit({ ...INPUT });
    await getNotificationEmitter().emit({ ...INPUT });
    expect(await storage.listNotifications({ tenantId: 't1', limit: 50 })).toHaveLength(2);
  });
});
