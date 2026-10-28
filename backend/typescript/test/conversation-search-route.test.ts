/**
 * ADR 0112 Phase 2 — conversation-search route tests: the GET + POST wiring of
 * `/host/openwop-app/chat/search` over the REAL chat routes, the message/title hit
 * round-trip, and the role facet reaching the engine.
 *
 * The feature is ALWAYS-ON (no toggle — ADR 0820 §8.6; this header used to claim
 * "404 when off"). ADR 0043 visibility scoping is pinned once, in
 * `conversation-search-engine.test.ts`, on `searchVisibleConversations` — the ONE
 * helper this route and the agent tool share (XCH-HOLE-5) — not re-booted here.
 * Breaks if: the route stops being registered, drops the `role` param, stops
 * reading `q` from a POST body (probes w24g1-route-*), drops `truncated`, or
 * matches stored envelope fields the person never saw (ADR 0997).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

async function jsonFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function newSession(title: string): Promise<string> {
  const r = await jsonFetch<{ sessionId: string }>('/host/openwop-app/chat/sessions', {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
  return r.body.sessionId;
}

async function appendMsg(sessionId: string, role: string, content: string): Promise<void> {
  await jsonFetch(`/host/openwop-app/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ messageId: `${sessionId}-${Math.random().toString(36).slice(2)}`, role, content }),
  });
}

interface SearchResp { hits: Array<{ conversationId: string; title: string; type?: string; messageId?: string; snippet: string; role?: string }>; truncated?: boolean }

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('conversation-search route', () => {
  it('serves without a toggle (always-on)', async () => {
    const r = await jsonFetch<SearchResp>('/host/openwop-app/chat/search?q=anything');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.hits), 'the search body, not a 200 from some other handler').toBe(true);
  });

  it('searches the caller conversations + messages', async () => {
    const s1 = await newSession('Quarterly planning');
    await appendMsg(s1, 'user', 'what is the revenue forecast for Q3');
    await appendMsg(s1, 'assistant', 'the forecast looks strong');
    const s2 = await newSession('Vacation plans');
    await appendMsg(s2, 'user', 'where should we go on holiday');

    const r = await jsonFetch<SearchResp>('/host/openwop-app/chat/search?q=forecast');
    expect(r.status).toBe(200);
    expect(r.body.hits.length).toBe(1);
    expect(r.body.hits[0]!.conversationId).toBe(s1);
    expect(r.body.hits[0]!.snippet.toLowerCase()).toContain('forecast');
    expect(r.body.hits[0]!.messageId).toBeTruthy();
  });

  it('returns a title hit and supports the role facet', async () => {
    const s = await newSession('Budget review session');
    // The USER message scores higher on `narwhal`, so without the role facet the best
    // hit for this conversation would be the user one — the facet is load-bearing.
    await appendMsg(s, 'user', 'narwhal narwhal narwhal question');
    await appendMsg(s, 'assistant', 'narwhal answer');

    const title = await jsonFetch<SearchResp>('/host/openwop-app/chat/search?q=budget');
    expect(title.body.hits.some((h) => h.conversationId === s && !h.messageId)).toBe(true);

    const assistant = await jsonFetch<SearchResp>('/host/openwop-app/chat/search?q=narwhal&role=assistant');
    const hit = assistant.body.hits.find((h) => h.conversationId === s);
    expect(hit?.role).toBe('assistant');
    expect(hit?.messageId).toBeTruthy();
  });

  it('accepts POST as well as GET', async () => {
    // Seeds its OWN term — it used to search 'forecast' and pass only when the GET
    // case had run first (red alone / under shuffle).
    const s = await newSession('Post body search');
    await appendMsg(s, 'user', 'the axolotlpost memo');
    const r = await jsonFetch<SearchResp>('/host/openwop-app/chat/search', {
      method: 'POST', body: JSON.stringify({ q: 'axolotlpost' }),
    });
    expect(r.status).toBe(200);
    expect(r.body.hits).toHaveLength(1);
    expect(r.body.hits[0]!.conversationId).toBe(s);
  });

  it('ADR 0997: every word must match, the body carries truncated, and only shown text matches', async () => {
    const s = await newSession('Envelope route probe');
    // The SPA's stored shape: the whole ChatMessage envelope (encodeMessageForStore).
    await appendMsg(s, 'assistant', JSON.stringify({ role: 'assistant', content: 'the lighthouse budget is final', thoughts: 'quietly considering the lantern' }));

    const both = await jsonFetch<SearchResp>('/host/openwop-app/chat/search?q=lighthouse%20budget');
    expect(both.body.truncated).toBe(false);
    expect(both.body.hits.map((h) => h.conversationId)).toEqual([s]);
    expect(both.body.hits[0]!.snippet).toBe('the lighthouse budget is final');

    // AND: one word that appears nowhere empties the result.
    expect((await jsonFetch<SearchResp>('/host/openwop-app/chat/search?q=lighthouse%20zanzibar')).body.hits).toEqual([]);
    // A thought is stored in the row but was never shown, so it does not match.
    expect((await jsonFetch<SearchResp>('/host/openwop-app/chat/search?q=lantern')).body.hits).toEqual([]);
  });
});
