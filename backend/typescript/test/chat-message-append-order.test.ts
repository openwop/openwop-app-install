/**
 * Chat/channel message order == APPEND order, even when appends share a
 * millisecond.
 *
 * Messages are listed + paged `ORDER BY created_at, message_id`, and message
 * ids are random UUIDs. Before this fix, two messages appended in the same
 * millisecond came back in id order — i.e. random — and the before-cursor
 * `(created_at, message_id) < (?, ?)` could skip or repeat one across that
 * boundary. `channel-message-pagination.test.ts` red about half the time on
 * exactly this (msg-10 missing from the msg-08..12 page).
 *
 * This witness is DETERMINISTIC: every append carries the SAME `createdAt` and
 * the ids DESCEND, so id order is the exact reverse of append order. Without
 * the adapter's per-session monotonic stamp (`chatMessageOrder.ts`) every
 * assertion below fails on every run, not ~50% of them.
 *
 * The real-Postgres arm lives in `storage-adapter-parity-testcontainers.test.ts`
 * (it needs Docker); this file covers SQLite, which is also the `memory://`
 * backend the route tests run on.
 */
import { describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { nextChatMessageCreatedAt } from '../src/storage/chatMessageOrder.js';
import type { Storage } from '../src/storage/storage.js';

const T = '2026-10-06T12:00:00.000Z';
const N = 12;

async function appendSameMs(s: Storage, sessionId: string): Promise<string[]> {
  await s.createChatSession({ sessionId, tenantId: 't-order', title: 'order', createdAt: T, updatedAt: T, messageCount: 0 });
  const contents: string[] = [];
  for (let i = 1; i <= N; i++) {
    const content = `msg-${String(i).padStart(2, '0')}`;
    // `z…` > `y…` > … : id order is the REVERSE of append order.
    const messageId = `${String.fromCharCode(0x7a - i)}-${sessionId}`;
    await s.appendChatMessage({ messageId, sessionId, role: 'user', content, meta: null, authorSubject: null, createdAt: T });
    contents.push(content);
  }
  return contents;
}

describe('chat message order is append order (same-millisecond appends)', () => {
  it('the full thread lists in append order', async () => {
    const s = openSqliteStorage(':memory:');
    const appended = await appendSameMs(s, 'sess-full');
    const listed = await s.listChatSessionMessages('sess-full');
    expect(listed.map((m) => m.content)).toEqual(appended);
    // Strictly increasing timestamps — the order no longer depends on the id.
    const ts = listed.map((m) => Date.parse(m.createdAt));
    for (let i = 1; i < ts.length; i++) expect(ts[i]!).toBeGreaterThan(ts[i - 1]!);
    await s.close();
  });

  it('a before-cursor page chain neither skips nor repeats across the same-ms boundary', async () => {
    const s = openSqliteStorage(':memory:');
    const appended = await appendSameMs(s, 'sess-page');
    const seen: string[] = [];
    let before: { createdAt: string; messageId: string } | undefined;
    for (;;) {
      const page = await s.listChatSessionMessages('sess-page', { limit: 5, ...(before ? { before } : {}) });
      if (page.length === 0) break;
      seen.unshift(...page.map((m) => m.content));
      before = { createdAt: page[0]!.createdAt, messageId: page[0]!.messageId };
    }
    expect(seen).toEqual(appended);
    await s.close();
  });

  it('an append with an EARLIER timestamp than the thread head still lands last', async () => {
    const s = openSqliteStorage(':memory:');
    const appended = await appendSameMs(s, 'sess-skew');
    await s.appendChatMessage({ messageId: 'a-late', sessionId: 'sess-skew', role: 'user', content: 'late', meta: null, authorSubject: null, createdAt: '2026-10-06T11:59:59.000Z' });
    const listed = await s.listChatSessionMessages('sess-skew');
    expect(listed.map((m) => m.content)).toEqual([...appended, 'late']);
    await s.close();
  });
});

describe('nextChatMessageCreatedAt', () => {
  it('keeps a timestamp that is already after the thread head, verbatim', () => {
    expect(nextChatMessageCreatedAt('2026-10-06T12:00:00.005Z', '2026-10-06T12:00:00.004Z')).toBe('2026-10-06T12:00:00.005Z');
    expect(nextChatMessageCreatedAt(T, null)).toBe(T);
  });
  it('bumps a tied or earlier timestamp to head + 1 ms', () => {
    expect(nextChatMessageCreatedAt(T, T)).toBe('2026-10-06T12:00:00.001Z');
    expect(nextChatMessageCreatedAt('2026-10-06T11:00:00.000Z', T)).toBe('2026-10-06T12:00:00.001Z');
  });
  it('leaves an unparseable stamp alone rather than inventing one', () => {
    expect(nextChatMessageCreatedAt('not-a-date', T)).toBe('not-a-date');
    expect(nextChatMessageCreatedAt(T, 'not-a-date')).toBe(T);
  });
});
