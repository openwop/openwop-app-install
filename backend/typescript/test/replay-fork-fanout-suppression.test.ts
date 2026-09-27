/**
 * H72 / ADR 0533 correction — a `mode:'replay'` fork MUST NOT fan its
 * re-emitted events out to webhook subscribers.
 *
 * `spec/v1/replay.md` §"Host-initiated fan-out is an external effect" makes
 * this normative and UNCONDITIONAL — it is not gated on
 * `sideEffectSuppression`, and replay-ness MUST be read from the RUN, not
 * from the event type (a type list would rot the moment a new type is added).
 *
 * WHY THIS HOST HAD THE DEFECT, and why the ADR is worth reading rather than
 * deleting: ADR 0533 `:178` exempted `deliverToSubscribers` deliberately, on
 * three stated grounds. The middle one — "a replay is a distinct run whose
 * events are genuinely new" — is precisely the proposition the corpus rule
 * negates. The other two SURVIVE, and they are why the fix lives here rather
 * than in `runEffectContext`'s guard: a throw inside the best-effort
 * subscriber is swallowed by `eventLog.ts` (`:42`), so a guard would suppress
 * SILENTLY — the fail-open shape that module exists to remove. Suppression
 * belongs at the BOUNDARY (Fowler's Gateway pattern: check replay mode before
 * passing the call to the outside world).
 *
 * Dedup cannot substitute for this: re-emission correctly mints a fresh
 * envelope `eventId`, and the delivery key is `(subscriptionId, eventId)`, so
 * a MORE correct host is MORE exposed. That is why the rule is separate from
 * caveat 1 rather than folded into it.
 *
 * The legs are chosen so the guard cannot be satisfied by suppressing
 * everything — leg 2 is the positive control, leg 3 keeps `branch` delivering,
 * and leg 4 pins that the decision reads the RUN and not a type allowlist.
 */

import { describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { __deliverToSubscribersForTests } from '../src/routes/webhooks.js';
import type { EventRecord, RunRecord, WebhookSubscriptionRecord } from '../src/types.js';

const NOW = '2026-08-18T14:00:00.000Z';

function mkRun(runId: string, forkMode?: 'replay' | 'branch'): RunRecord {
  return {
    runId,
    workflowId: 'wf-any',
    tenantId: 'tenant-a',
    status: 'completed',
    inputs: {},
    metadata: {},
    configurable: {},
    ...(forkMode ? { forkMode, parentRunId: 'run-source', parentSeq: 0 } : {}),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function mkSub(subscriptionId: string, events: string[]): WebhookSubscriptionRecord {
  return {
    subscriptionId,
    tenantId: 'tenant-a',
    url: `https://example.com/${subscriptionId}`,
    events,
    secret: 's',
    createdAt: NOW,
  };
}

function mkEvent(runId: string, type: string, eventId: string): EventRecord {
  return { eventId, runId, sequence: 1, type, payload: {}, timestamp: NOW };
}

/** Drive the production fan-out and report which subscriptions got enqueued. */
async function deliveredFor(
  run: RunRecord,
  event: EventRecord,
  events: string[],
): Promise<string[]> {
  const storage: Storage = await openStorage('memory://');
  try {
    await storage.insertRun(run);
    await storage.insertWebhook(mkSub('sub-1', events));
    await __deliverToSubscribersForTests(storage, event);
    const queued = await storage.claimDueWebhookDeliveries('inspector', Date.now() + 1, 1, 10);
    return queued.map((d) => d.subscriptionId);
  } finally {
    await storage.close();
  }
}

describe('H72 — replay-fork fan-out suppression (replay.md §"Host-initiated fan-out is an external effect")', () => {
  it('a replay fork does NOT deliver its re-emitted event', async () => {
    const run = mkRun('run-replay', 'replay');
    const delivered = await deliveredFor(
      run,
      mkEvent(run.runId, 'memory.written', 'ev-replay'),
      ['memory.written'],
    );
    expect(delivered).toEqual([]);
  });

  it('POSITIVE CONTROL: an original run DOES deliver the same event', async () => {
    // Without this the suppression could be satisfied by delivering nothing
    // at all, and the leg above would pass on a host with webhooks broken.
    const run = mkRun('run-original');
    const delivered = await deliveredFor(
      run,
      mkEvent(run.runId, 'memory.written', 'ev-original'),
      ['memory.written'],
    );
    expect(delivered).toEqual(['sub-1']);
  });

  it('a BRANCH fork still delivers — branch is explicitly out of scope', async () => {
    // A branch fork is new execution, not a re-run of recorded history, so its
    // effects are genuinely first-time. Suppressing it would be over-reach.
    const run = mkRun('run-branch', 'branch');
    const delivered = await deliveredFor(
      run,
      mkEvent(run.runId, 'memory.written', 'ev-branch'),
      ['memory.written'],
    );
    expect(delivered).toEqual(['sub-1']);
  });

  it('replay-ness is read from the RUN, so an unrelated event type is suppressed too', async () => {
    // Pins the rule against the tempting shortcut of a suppressed-type list,
    // which would silently stop covering every event type added later.
    const run = mkRun('run-replay-lifecycle', 'replay');
    const delivered = await deliveredFor(
      run,
      mkEvent(run.runId, 'run.completed', 'ev-lifecycle'),
      ['run.completed'],
    );
    expect(delivered).toEqual([]);
  });
});
