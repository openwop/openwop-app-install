/**
 * CSC-1 — the conversation-search freshness watermark was keyed on `messageCount`
 * alone (`searchEngine.ts` ensureConversationIndexed), so the two content
 * mutations that DON'T move the count were invisible to it:
 *   - an in-place EDIT (PUT …/messages/:id) — old text kept matching with the
 *     stale snippet; the new text was never indexed.
 *   - a tombstone DELETE (DELETE …/messages/:id — content→`{"deleted":true}`,
 *     row kept) — the deleted content stayed searchable (a privacy leak).
 * The engine docblock + the ADR 0112 note claimed "edited/deleted self-heals on
 * the next query" — false for exactly those ops.
 *
 * Driven over the REAL chat routes (not a hand-replicated mutation) so it proves
 * the whole path: the edit/delete routes bump `session.updatedAt` and the engine
 * folds `updatedAt` into the freshness key, so a re-query re-indexes. Born-red on
 * the pre-fix `messageCount`-only watermark.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

async function jsonFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

async function newSession(title: string): Promise<string> {
  const r = await jsonFetch<{ sessionId: string }>('/v1/host/openwop-app/chat/sessions', { method: 'POST', body: JSON.stringify({ title }) });
  return r.body.sessionId;
}

/** Append a message with a KNOWN id (so the edit/delete can target it). */
async function appendMsg(sessionId: string, role: string, content: string): Promise<string> {
  const messageId = `${sessionId}-${Math.random().toString(36).slice(2)}`;
  await jsonFetch(`/v1/host/openwop-app/chat/sessions/${sessionId}/messages`, {
    method: 'POST', body: JSON.stringify({ messageId, role, content }),
  });
  return messageId;
}

interface SearchResp { hits: Array<{ conversationId: string; messageId?: string; snippet: string }> }
async function search(q: string): Promise<SearchResp> {
  return (await jsonFetch<SearchResp>(`/v1/host/openwop-app/chat/search?q=${encodeURIComponent(q)}`)).body;
}
/** Message-level hits for a conversation (title hits carry no messageId). */
const msgHits = (r: SearchResp, sessionId: string): number =>
  r.hits.filter((h) => h.conversationId === sessionId && h.messageId).length;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const d = getToggleDefault('conversation-search');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('CSC-1 — search freshness tracks in-place edit + tombstone-delete', () => {
  it('an EDIT drops the old text from the index and picks up the new text', async () => {
    const s = await newSession('Edit freshness');
    const mid = await appendMsg(s, 'user', 'aardvarkoriginal supersecret revenue');
    // Baseline (non-vacuous): the original text is indexed + matches.
    expect(msgHits(await search('aardvarkoriginal'), s), 'baseline: original text indexed').toBe(1);

    const put = await jsonFetch(`/v1/host/openwop-app/chat/sessions/${s}/messages/${mid}`, {
      method: 'PUT', body: JSON.stringify({ content: 'bluejayupdated forecast text' }),
    });
    expect(put.status, 'edit succeeds').toBe(200);

    // The OLD text must NO LONGER match (born-red: messageCount unchanged ⇒ stale).
    expect(msgHits(await search('aardvarkoriginal'), s), 'stale old text must be gone after edit').toBe(0);
    // The NEW text must now match (born-red: never re-indexed).
    expect(msgHits(await search('bluejayupdated'), s), 'new text must be searchable after edit').toBe(1);
  });

  it('a tombstone DELETE removes the deleted content from the index (privacy)', async () => {
    const s = await newSession('Delete freshness');
    const mid = await appendMsg(s, 'user', 'crocodileconfidential quarterly numbers');
    await appendMsg(s, 'assistant', 'acknowledged'); // a sibling so the conv isn't empty post-tombstone
    expect(msgHits(await search('crocodileconfidential'), s), 'baseline: content indexed').toBe(1);

    const del = await jsonFetch(`/v1/host/openwop-app/chat/sessions/${s}/messages/${mid}`, { method: 'DELETE' });
    expect([200, 204]).toContain(del.status);

    // The deleted content must NO LONGER match (born-red: tombstone keeps count ⇒ stale).
    expect(msgHits(await search('crocodileconfidential'), s), 'deleted content must not remain searchable').toBe(0);
    // …and the tombstone must not be indexed as its literal `{"deleted":true}` sentinel
    // (a "deleted" query must not surface the tombstoned row).
    expect(msgHits(await search('deleted'), s), 'the tombstone sentinel must not be searchable').toBe(0);
  });
});
