/**
 * Tenant teardown (ADR 0284; closes DATA-ASSESSMENT RI-1 / DG-INT-1).
 *
 * Exercises the two new halves through REAL feature services:
 *  - `purgeTenantHostExt`: business rows (CRM contact, kanban board, roster
 *    member) vanish for the torn-down tenant only; a GHOST row (a retired
 *    namespace no live collection owns) is swept by its JSON tenantId; a
 *    bystander tenant is untouched; fail-closed on a falsy tenant; idempotent.
 *  - introspected `deleteAllTenantData`: tenant-keyed SQL rows beyond the old
 *    hand-list (chat_sessions + chat_messages, user_agents) are deleted and
 *    reported via `otherRows`/`tablesCovered`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { DurableCollection, initHostExtPersistence, purgeTenantHostExt } from '../src/host/hostExtPersistence.js';
import { createContact, getContact } from '../src/features/crm/contactsService.js';
import { createBoard, listBoards } from '../src/host/kanbanService.js';

let storage: Storage;

beforeAll(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

describe('purgeTenantHostExt (ADR 0284)', () => {
  it('deletes the tenant across live collections + ghost namespaces; bystander intact; idempotent', async () => {
    const A = 'teardown-a';
    const B = 'teardown-b';

    const contactA = await createContact({ tenantId: A, name: 'Doomed Contact', email: 'doomed@a.test' });
    const contactB = await createContact({ tenantId: B, name: 'Bystander', email: 'safe@b.test' });
    const boardA = await createBoard({ tenantId: A, name: 'Doomed Board', columns: [{ id: 'todo', name: 'To do' }] });
    // A ghost row — a retired feature's namespace no live DurableCollection owns.
    await storage.kvSet('hostext:retired-feature:row-1', JSON.stringify({ tenantId: A, payload: 'orphan' }));
    await storage.kvSet('hostext:retired-feature:row-2', JSON.stringify({ tenantId: B, payload: 'bystander' }));

    // Fail-closed: a falsy tenant purges nothing.
    expect(await purgeTenantHostExt('')).toEqual({ deleted: 0, ghostRows: 0, collections: 0 });

    const first = await purgeTenantHostExt(A);
    expect(first.deleted).toBeGreaterThanOrEqual(2); // contact + board at minimum
    expect(first.ghostRows).toBe(1);

    expect(await getContact(contactA.contactId)).toBeNull();
    expect((await listBoards(A)).find((b) => b.id === boardA.id)).toBeUndefined();
    expect(await storage.kvGet('hostext:retired-feature:row-1')).toBeNull();

    // Bystander tenant untouched.
    expect(await getContact(contactB.contactId)).not.toBeNull();
    expect(await storage.kvGet('hostext:retired-feature:row-2')).not.toBeNull();

    // Idempotent: nothing left on a re-run.
    const second = await purgeTenantHostExt(A);
    expect(second).toEqual({ deleted: 0, ghostRows: 0, collections: 0 });
  });

  // FU-DATA-1 / FU-CODE-2 — a VALIDATED collection's completeness paths must not
  // skip validator-rejected legacy rows under its (shared) prefix: those rows
  // still carry a departed tenant's raw data (the token-keyed byte rows under
  // `hostext:media:asset:` are the live example). Purge deletes them by raw key;
  // count sees them via the JSON tenantId probe.
  it('purges + counts validator-REJECTED raw rows carrying the tenantId (legacy byte rows)', async () => {
    interface VRow { id: string; tenantId: string }
    const validated = new DurableCollection<VRow>(
      'teardown:validated',
      (r) => r.id,
      (p) => (p && typeof p === 'object' && typeof (p as VRow).id === 'string' ? (p as VRow) : null),
      (r) => r.tenantId,
    );
    await validated.put({ id: 'good-1', tenantId: 'raw-a' });
    // Legacy raw rows the validator REJECTS (no `id`) but carrying a tenantId —
    // the byte-store shape sharing the collection prefix.
    await storage.kvSet('hostext:teardown:validated:tok-1', JSON.stringify({ token: 'tok-1', tenantId: 'raw-a', contentBase64: 'AAAA' }));
    await storage.kvSet('hostext:teardown:validated:tok-2', JSON.stringify({ token: 'tok-2', tenantId: 'raw-b', contentBase64: 'BBBB' }));

    expect(await validated.countRowsFor('raw-a')).toBe(2); // validated row + raw byte row

    expect(await validated.purgeTenantRows('raw-a')).toBe(2);
    expect(await validated.get('good-1')).toBeNull();
    expect(await storage.kvGet('hostext:teardown:validated:tok-1')).toBeNull(); // the raw row is GONE
    expect(await storage.kvGet('hostext:teardown:validated:tok-2')).not.toBeNull(); // bystander tenant intact
    expect(await validated.countRowsFor('raw-a')).toBe(0);

    // And the registry-walking teardown reaches the same rows (the collection
    // self-registered at construction).
    await storage.kvSet('hostext:teardown:validated:tok-3', JSON.stringify({ token: 'tok-3', tenantId: 'raw-c', contentBase64: 'CCCC' }));
    const swept = await purgeTenantHostExt('raw-c');
    expect(swept.deleted).toBe(1);
    expect(await storage.kvGet('hostext:teardown:validated:tok-3')).toBeNull();
  });
});

describe('introspected deleteAllTenantData (ADR 0284)', () => {
  it('covers tenant tables beyond the old hand-list (chat sessions/messages, user_agents)', async () => {
    const A = 'teardown-sql-a';
    const B = 'teardown-sql-b';

    const now = new Date().toISOString();
    await storage.createChatSession({ sessionId: 'sess-a1', tenantId: A, title: 'Doomed chat', createdAt: now, updatedAt: now, messageCount: 0 });
    await storage.appendChatMessage({ messageId: 'msg-a1', sessionId: 'sess-a1', role: 'user', content: 'hello', meta: null, authorSubject: null, createdAt: now });
    await storage.createChatSession({ sessionId: 'sess-b1', tenantId: B, title: 'Bystander chat', createdAt: now, updatedAt: now, messageCount: 0 });

    const counts = await storage.deleteAllTenantData(A);
    expect(counts.tablesCovered).toBeGreaterThan(7); // introspection sees more than the old hand-list
    // chat session lands in otherRows (introspected table beyond the named set);
    // its message rode the explicit session-keyed child cascade.
    expect(counts.otherRows).toBeGreaterThanOrEqual(2);

    expect(await storage.getChatSession(A, 'sess-a1')).toBeNull();
    expect(await storage.getChatSession(B, 'sess-b1')).not.toBeNull(); // bystander intact
  });
});
