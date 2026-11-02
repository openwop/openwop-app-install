/**
 * Sample-extension chat-session history routes (Phase 2C.1; pagination ADR 0043
 * Phase 3b).
 *
 * Covers the 7 endpoint shapes (list / create / get / patch / delete /
 * list-messages / append-message), cascade-delete from sessions to messages,
 * idempotent unique-violation handling, and `updated_at` bump +
 * `message_count` increment on append.
 *
 * > CORRECTED 2026-10-29 (/grade-tests w67, TST-CEC-11): this header also
 * > claimed "tenant isolation across sessions". No case here tests it — every
 * > request uses the dev-token wildcard — so the claim is removed rather than
 * > left standing on nothing. The list-order case used to read sessions OTHER
 * > cases had created (order-dependent, and trivially true on tied stamps); it
 * > now seeds its own three with distinct activity times. The cascade case used
 * > to prove only that the parent was gone; it now re-creates the same id and
 * > reads the message list back empty.
 * Red when (w67g3, witnessed): the session list sorts ascending; the append's
 * count bump stops incrementing; the page-size cap or the cursor validation is
 * dropped; `hasMore` is never set (no cursor).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

async function jsonFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      ...(init.headers ?? {}),
    },
  });
  // A 204 carries no body; callers of DELETE read only the status.
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

interface SessionRecord {
  sessionId: string;
  tenantId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

describe('sample chat sessions — CRUD + tenant isolation', () => {
  it('creates a session with a generated id when none supplied', async () => {
    const r = await jsonFetch<SessionRecord>('/host/openwop-app/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: 'First chat' }),
    });
    expect(r.status).toBe(201);
    expect(typeof r.body.sessionId).toBe('string');
    expect(r.body.title).toBe('First chat');
    expect(r.body.messageCount).toBe(0);
    expect(r.body.createdAt).toBe(r.body.updatedAt);
  });

  it('rejects a malformed client-chosen sessionId', async () => {
    const r = await jsonFetch<{ error: string }>('/host/openwop-app/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'has spaces' }),
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation_error');
  });

  it('returns 409 on a duplicate client-chosen sessionId', async () => {
    const id = 'pinned-id';
    const first = await jsonFetch('/host/openwop-app/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id }),
    });
    expect(first.status).toBe(201);
    const second = await jsonFetch<{ error: string }>('/host/openwop-app/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id }),
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('idempotency_key_conflict');
  });

  it('round-trips through GET / PATCH / DELETE', async () => {
    const created = await jsonFetch<SessionRecord>('/host/openwop-app/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Round-trip' }),
    });
    const id = created.body.sessionId;

    const got = await jsonFetch<SessionRecord>(`/host/openwop-app/chat/sessions/${id}`);
    expect(got.status).toBe(200);
    expect(got.body.title).toBe('Round-trip');

    const patched = await jsonFetch<SessionRecord>(`/host/openwop-app/chat/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Renamed' }),
    });
    expect(patched.status).toBe(200);
    expect(patched.body.title).toBe('Renamed');

    const removed = await jsonFetch(`/host/openwop-app/chat/sessions/${id}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);

    const gone = await jsonFetch<{ error: string }>(`/host/openwop-app/chat/sessions/${id}`);
    expect(gone.status).toBe(404);
    expect(gone.body.error).toBe('not_found');
  });

  it('lists sessions for the calling tenant in latest-activity order', async () => {
    // Seed three sessions whose LAST ACTIVITY order differs from their creation
    // order, at fake instants later than any other case's rows (only `Date` is
    // faked, and only inside this case).
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2031-01-01T00:00:00.000Z'));
      const ids: string[] = [];
      for (const title of ['order-a', 'order-b', 'order-c']) {
        ids.push((await jsonFetch<SessionRecord>('/host/openwop-app/chat/sessions', { method: 'POST', body: JSON.stringify({ title }) })).body.sessionId);
      }
      const [a, b, c] = ids as [string, string, string];
      // Activity: c, then a, then b — so the newest-first order is b, a, c.
      for (const [n, id] of [c, a, b].entries()) {
        vi.setSystemTime(new Date(Date.UTC(2031, 0, 1, 0, 0, n + 1)));
        const r = await jsonFetch(`/host/openwop-app/chat/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({ messageId: `order-${n}`, role: 'user', content: 'x' }) });
        expect(r.status).toBe(201);
      }
      const list = await jsonFetch<{ sessions: SessionRecord[] }>('/host/openwop-app/chat/sessions');
      expect(list.status).toBe(200);
      expect(list.body.sessions.slice(0, 3).map((s) => s.sessionId)).toEqual([b, a, c]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('sample chat sessions — messages sub-collection + cascade', () => {
  let sessionId: string;

  beforeAll(async () => {
    const r = await jsonFetch<SessionRecord>('/host/openwop-app/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: 'with messages' }),
    });
    sessionId = r.body.sessionId;
  });

  it('appends messages + bumps the session header', async () => {
    const before = await jsonFetch<SessionRecord>(`/host/openwop-app/chat/sessions/${sessionId}`);
    expect(before.body.messageCount).toBe(0);

    const append = await jsonFetch(`/host/openwop-app/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        messageId: 'msg-1',
        role: 'user',
        content: 'hello',
      }),
    });
    expect(append.status).toBe(201);

    const after = await jsonFetch<SessionRecord>(`/host/openwop-app/chat/sessions/${sessionId}`);
    expect(after.body.messageCount).toBe(1);
    expect(after.body.updatedAt >= before.body.updatedAt, 'updatedAt MUST bump on append').toBe(true);

    const list = await jsonFetch<{ messages: Array<{ messageId: string; role: string; content: string }> }>(
      `/host/openwop-app/chat/sessions/${sessionId}/messages`,
    );
    expect(list.body.messages.length).toBe(1);
    expect(list.body.messages[0]?.role).toBe('user');
    expect(list.body.messages[0]?.content).toBe('hello');
  });

  it('rejects unknown role values', async () => {
    const r = await jsonFetch<{ error: string }>(
      `/host/openwop-app/chat/sessions/${sessionId}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ messageId: 'msg-bad', role: 'pirate', content: 'arrr' }),
      },
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation_error');
  });

  it('atomic message_count under concurrent appends — no lost increments', async () => {
    const fresh = await jsonFetch<SessionRecord>('/host/openwop-app/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: 'concurrent-bump' }),
    });
    const id = fresh.body.sessionId;

    // Fire 10 concurrent appends. Under the previous read-then-write
    // pattern these would all read messageCount=0, all write 1, and
    // the final count would be 1 instead of 10. The atomic SQL
    // increment in `appendChatMessage` makes the final count exact.
    const N = 10;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        jsonFetch(`/host/openwop-app/chat/sessions/${id}/messages`, {
          method: 'POST',
          body: JSON.stringify({
            messageId: `parallel-msg-${i}`,
            role: 'user',
            content: `m${i}`,
          }),
        }),
      ),
    );

    const after = await jsonFetch<SessionRecord>(`/host/openwop-app/chat/sessions/${id}`);
    expect(after.body.messageCount, 'every concurrent append MUST be reflected in messageCount').toBe(N);

    const list = await jsonFetch<{ messages: unknown[] }>(
      `/host/openwop-app/chat/sessions/${id}/messages`,
    );
    expect(list.body.messages.length, 'every message row MUST persist').toBe(N);
  });

  it('cascade-deletes messages when the session is removed', async () => {
    const id = 'cascade-pinned';
    const fresh = await jsonFetch<SessionRecord>('/host/openwop-app/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id, title: 'will-be-deleted' }),
    });
    expect(fresh.status).toBe(201);

    await jsonFetch(`/host/openwop-app/chat/sessions/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ messageId: 'will-cascade', role: 'user', content: 'tmp' }),
    });

    const del = await jsonFetch(`/host/openwop-app/chat/sessions/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);

    // The messages list endpoint now returns 404 because the parent
    // session is gone — the cascade dropped the messages table rows
    // along with it.
    const gone = await jsonFetch<{ error: string }>(`/host/openwop-app/chat/sessions/${id}/messages`);
    expect(gone.status).toBe(404);

    // The parent's 404 alone cannot show the ROWS went: re-create the same id and
    // read its messages — an orphaned row would surface under the new parent.
    expect((await jsonFetch('/host/openwop-app/chat/sessions', { method: 'POST', body: JSON.stringify({ sessionId: id }) })).status).toBe(201);
    const reborn = await jsonFetch<{ messages: unknown[] }>(`/host/openwop-app/chat/sessions/${id}/messages`);
    expect(reborn.status).toBe(200);
    expect(reborn.body.messages).toEqual([]);
  });
});

describe('sample chat sessions — message pagination (ADR 0043 Phase 3b)', () => {
  // 10 messages with zero-padded ids so (created_at, message_id) ordering is
  // deterministic even if appends share a millisecond (the message_id tiebreak
  // is monotonic with insertion order).
  const ids = Array.from({ length: 10 }, (_, i) => `m${String(i + 1).padStart(2, '0')}`);
  let sessionId = '';

  beforeAll(async () => {
    const s = await jsonFetch<SessionRecord>('/host/openwop-app/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: 'paged' }),
    });
    sessionId = s.body.sessionId;
    for (const messageId of ids) {
      await jsonFetch(`/host/openwop-app/chat/sessions/${sessionId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ messageId, role: 'user', content: messageId }),
      });
    }
  });

  interface Page { messages: Array<{ messageId: string; createdAt: string }>; nextCursor: string | null }

  it('returns the full thread (ASC) with no limit — legacy shape, no cursor', async () => {
    const r = await jsonFetch<Page>(`/host/openwop-app/chat/sessions/${sessionId}/messages`);
    expect(r.status).toBe(200);
    expect(r.body.messages.map((m) => m.messageId)).toEqual(ids);
    expect(r.body.nextCursor).toBeUndefined(); // legacy path omits the cursor entirely
  });

  it('returns the most-recent page (ASC) + a cursor when limited', async () => {
    const r = await jsonFetch<Page>(`/host/openwop-app/chat/sessions/${sessionId}/messages?limit=3`);
    expect(r.status).toBe(200);
    expect(r.body.messages.map((m) => m.messageId)).toEqual(['m08', 'm09', 'm10']);
    expect(typeof r.body.nextCursor).toBe('string');
  });

  it('pages strictly older than the cursor until history is exhausted', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const qs = `limit=3${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`;
      const r: { status: number; body: Page } = await jsonFetch<Page>(`/host/openwop-app/chat/sessions/${sessionId}/messages?${qs}`);
      expect(r.status).toBe(200);
      // Each page is ascending and older than everything seen so far.
      seen.unshift(...r.body.messages.map((m) => m.messageId));
      cursor = r.body.nextCursor;
      if (++guard > 10) throw new Error('pagination did not terminate');
    } while (cursor);
    // Walking the cursor reconstructs the full thread in order, exactly once.
    expect(seen).toEqual(ids);
  });

  it('returns all + a null cursor when the limit exceeds the message count', async () => {
    const r = await jsonFetch<Page>(`/host/openwop-app/chat/sessions/${sessionId}/messages?limit=50`);
    expect(r.body.messages.map((m) => m.messageId)).toEqual(ids);
    expect(r.body.nextCursor).toBeNull();
  });

  it('rejects an out-of-range limit and a malformed cursor', async () => {
    expect((await jsonFetch(`/host/openwop-app/chat/sessions/${sessionId}/messages?limit=0`)).status).toBe(400);
    expect((await jsonFetch(`/host/openwop-app/chat/sessions/${sessionId}/messages?limit=999`)).status).toBe(400);
    expect((await jsonFetch(`/host/openwop-app/chat/sessions/${sessionId}/messages?limit=3&before=not-a-cursor`)).status).toBe(400);
  });
});
