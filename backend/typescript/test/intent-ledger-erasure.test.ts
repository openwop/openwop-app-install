/**
 * CONS-16 — the intent-ledger exemption was resting on a claim that had stopped
 * being true.
 *
 * `ledgerStore.ts` carried a written exemption: "DELIBERATELY NOT a
 * `registerSubjectEraser` consumer: rows key `${tenantId}:${conversationId}` and
 * carry no subject key, so a principal-keyed DSAR cannot address them." The
 * first half is true of the KEY and FALSE of the ROW — `IntentLedger.approvedBy`
 * is set to `actingUserOf(req)` when a human approves a mission, i.e. a
 * `User.userId`, which is exactly the key shape a principal-keyed DSAR arrives
 * with. Nobody re-checked the exemption after `approvedBy` was added.
 *
 * This pins the fix in both directions, plus the two things it deliberately does
 * NOT do — because an eraser's un-erased residual is only honest while it is
 * asserted somewhere, not merely written in a comment.
 *
 * What turns it red (sabotage-probed, /grade-tests w29): dropping the per-row
 * tenant filter or the subject-form match (NON-REACH), matching only the bare key
 * (the `user:` form case), deleting instead of redacting (every REACH case).
 * Registration into the DSAR fan-out is NOT asserted here: the boot layer of
 * `subject-eraser-manifest.test.ts` ('nothing in the manifest is missing after
 * createApp()') pins `eraseIntentLedgerSubject` as registered by a real boot.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { eraseIntentLedgerSubject, getLedger, saveLedger } from '../src/features/intent-ledger/ledgerStore.js';
import { ERASED } from '../src/host/subjectErasureRedaction.js';
import type { IntentLedger } from '../src/features/intent-ledger/types.js';

const T = 'ws:il-erase';
const CREATED = '2026-06-24T00:00:00.000Z';

const put = async (over: Partial<IntentLedger> & { conversationId: string }): Promise<void> => {
  const base: IntentLedger = {
    ledgerId: `l-${over.conversationId}`,
    tenantId: T,
    conversationId: over.conversationId,
    goal: 'ship the thing',
    allowed: [], forbidden: [], requireApproval: [], successCriteria: [],
    status: 'approved', proposedBy: 'user', createdAt: CREATED,
  };
  await saveLedger({ ...base, ...over });
};
const get = async (conversationId: string, tenantId = T): Promise<IntentLedger | null> =>
  getLedger(tenantId, conversationId);

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

describe('CONS-16 — a DSAR reaches the intent ledger\'s approver attribution', () => {
  it('REACH: `approvedBy` is redacted for the erased subject', async () => {
    await put({ conversationId: 'c1', approvedBy: 'alice' });
    await eraseIntentLedgerSubject(T, 'alice');
    expect((await get('c1'))!.approvedBy).toBe(ERASED);
  });

  it('matches the ADR 0041 `user:` subjectRef form as well as the bare id', async () => {
    await put({ conversationId: 'c-scoped', approvedBy: 'user:alice' });
    await eraseIntentLedgerSubject(T, 'alice');
    expect((await get('c-scoped'))!.approvedBy).toBe(ERASED);
  });

  it('NON-REACH: another approver, another tenant, and an unapproved ledger are untouched', async () => {
    await put({ conversationId: 'c2', approvedBy: 'bob' });
    await put({ conversationId: 'c3' }); // draft — no approvedBy at all
    await saveLedger({
      ledgerId: 'l-other', tenantId: 'ws:other', conversationId: 'c4', goal: 'g',
      allowed: [], forbidden: [], requireApproval: [], successCriteria: [],
      status: 'approved', proposedBy: 'user', approvedBy: 'alice', createdAt: CREATED,
    });

    await eraseIntentLedgerSubject(T, 'alice');

    expect((await get('c2'))!.approvedBy).toBe('bob');
    expect((await get('c3'))!.approvedBy).toBeUndefined();
    expect((await get('c4', 'ws:other'))!.approvedBy, 'tenant isolation').toBe('alice');
  });

  it('REDACTS rather than deletes — the mission contract survives', async () => {
    // The ledger is the ORG's governance record of what a conversation was
    // permitted to do, and a run's `IntentLedgerStamp` reads it verbatim on
    // `:fork`. Deleting it because one participant left would destroy the record
    // of a decision that governed other people's work.
    await put({ conversationId: 'c5', approvedBy: 'alice', allowed: ['openwop:kb.search'], goal: 'ship the thing' });
    await eraseIntentLedgerSubject(T, 'alice');
    const row = await get('c5');
    expect(row, 'the row must still exist').toBeTruthy();
    expect(row!.allowed).toEqual(['openwop:kb.search']);
    expect(row!.status).toBe('approved');
  });

  // PINNED DEFECT (IL-DSAR-1, proposed grade-code row; ruled a privacy defect in
  // /grade-tests w29): a DSAR for alice leaves `goal` free text that names her in
  // place. The product documents this as a stated gap (`ledgerStore.ts`
  // `eraseIntentLedgerSubject` docblock: `goal` is multi-party model summary and
  // the subject→conversation cascade cannot run safely inside an eraser — it needs
  // an upfront closure in the `SubjectKeyResolver` phase). This `it.fails` asserts
  // the CORRECT outcome; it goes red the moment the eraser reaches `goal`, which is
  // the signal to flip it to a plain `it`.
  it.fails('IL-DSAR-1: goal free text naming the erased subject no longer carries their name', async () => {
    await put({ conversationId: 'c6', approvedBy: 'alice', goal: 'alice wants a raise' });
    await eraseIntentLedgerSubject(T, 'alice');
    const row = await get('c6');
    expect(row, 'the row must still exist').toBeTruthy();
    expect(row!.goal).not.toContain('alice');
  });

  it('is idempotent: a repeated erase leaves the redaction in place', async () => {
    await put({ conversationId: 'c7', approvedBy: 'alice' });
    await eraseIntentLedgerSubject(T, 'alice');
    await eraseIntentLedgerSubject(T, 'alice');
    expect((await get('c7'))!.approvedBy).toBe(ERASED);
  });

  // CEILING (double guard): the `!tenantId || !subjectKey` early return cannot be
  // made to fail with production-shaped rows — `erase('', …)` already no-ops via the
  // per-row tenant filter, and `erase(T, '')` via the subject-form match (forms of ''
  // are {'', 'user:'}, never a real approver). Kept as a no-op check, not a witness.
  it('a falsy tenant or subject is a no-op (ceiling: double guard, see comment)', async () => {
    await put({ conversationId: 'c8', approvedBy: 'alice' });
    await eraseIntentLedgerSubject('', 'alice');
    await eraseIntentLedgerSubject(T, '');
    expect((await get('c8'))!.approvedBy).toBe('alice');
  });
});
