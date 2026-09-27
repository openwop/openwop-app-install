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
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { DurableCollection, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { eraseIntentLedgerSubject } from '../src/features/intent-ledger/ledgerStore.js';
import { ERASED } from '../src/host/subjectErasureRedaction.js';
import type { IntentLedger } from '../src/features/intent-ledger/types.js';

const T = 'ws:il-erase';
let store: DurableCollection<IntentLedger>;

const put = async (over: Partial<IntentLedger> & { conversationId: string }): Promise<void> => {
  await store.put({
    ledgerId: `l-${over.conversationId}`,
    tenantId: T,
    goal: 'ship the thing',
    allowed: [], forbidden: [], requireApproval: [], successCriteria: [],
    status: 'approved', proposedBy: 'user', createdAt: new Date().toISOString(),
    ...over,
  } as IntentLedger);
};
const get = async (conversationId: string, tenantId = T): Promise<IntentLedger | null> =>
  store.get(`${tenantId}:${conversationId}`);

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  store = new DurableCollection<IntentLedger>('intent-ledger:ledgers', (l) => `${l.tenantId}:${l.conversationId}`);
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
    await store.put({
      ledgerId: 'l-other', tenantId: 'ws:other', conversationId: 'c4', goal: 'g',
      allowed: [], forbidden: [], requireApproval: [], successCriteria: [],
      status: 'approved', proposedBy: 'user', approvedBy: 'alice', createdAt: new Date().toISOString(),
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

  it('the STATED residual is real: `goal` free text is NOT reached', async () => {
    // Asserted, not just written in a comment. `goal` is model-summarised text
    // from a possibly multi-party conversation, so it is not unambiguously the
    // erased subject's own data, and the cascade that would reach it cannot be
    // done safely from inside an eraser (the sibling conversation eraser redacts
    // the very fields that lookup would read, and eraser order is registration
    // order). If that ever changes, this assertion is the thing that must be
    // updated — which is the point of pinning a residual.
    await put({ conversationId: 'c6', approvedBy: 'alice', goal: 'alice wants a raise' });
    await eraseIntentLedgerSubject(T, 'alice');
    expect((await get('c6'))!.goal).toBe('alice wants a raise');
  });

  it('is idempotent and no-ops on a falsy tenant or subject (never a global redact)', async () => {
    await put({ conversationId: 'c7', approvedBy: 'alice' });
    await eraseIntentLedgerSubject('', 'alice');
    await eraseIntentLedgerSubject(T, '');
    expect((await get('c7'))!.approvedBy).toBe('alice');
    await eraseIntentLedgerSubject(T, 'alice');
    await eraseIntentLedgerSubject(T, 'alice');
    expect((await get('c7'))!.approvedBy).toBe(ERASED);
  });
});
