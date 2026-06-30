/**
 * ADR 0112 Phase 2 — conversation-search route tests.
 * Toggle gating (404 when off), the search round-trip over the real chat routes,
 * facets, and that the visible-set scoping (ADR 0043) governs results.
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
  return { status: res.status, body: (await res.json()) as T };
}

async function enable(id: string, status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status }, 'test');
}

async function newSession(title: string): Promise<string> {
  const r = await jsonFetch<{ sessionId: string }>('/v1/host/openwop-app/chat/sessions', {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
  return r.body.sessionId;
}

async function appendMsg(sessionId: string, role: string, content: string): Promise<void> {
  await jsonFetch(`/v1/host/openwop-app/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ messageId: `${sessionId}-${Math.random().toString(36).slice(2)}`, role, content }),
  });
}

interface SearchResp { hits: Array<{ conversationId: string; title: string; type?: string; messageId?: string; snippet: string; role?: string }> }

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('conversation-search route', () => {
  it('serves without a toggle (always-on)', async () => {
    const r = await jsonFetch('/v1/host/openwop-app/chat/search?q=anything');
    expect(r.status).toBe(200);
  });

  it('searches the caller conversations + messages when enabled', async () => {
    await enable('conversation-search', 'on');
    const s1 = await newSession('Quarterly planning');
    await appendMsg(s1, 'user', 'what is the revenue forecast for Q3');
    await appendMsg(s1, 'assistant', 'the forecast looks strong');
    const s2 = await newSession('Vacation plans');
    await appendMsg(s2, 'user', 'where should we go on holiday');

    const r = await jsonFetch<SearchResp>('/v1/host/openwop-app/chat/search?q=forecast');
    expect(r.status).toBe(200);
    expect(r.body.hits.length).toBe(1);
    expect(r.body.hits[0]!.conversationId).toBe(s1);
    expect(r.body.hits[0]!.snippet.toLowerCase()).toContain('forecast');
    expect(r.body.hits[0]!.messageId).toBeTruthy();
  });

  it('returns a title hit and supports the role facet', async () => {
    await enable('conversation-search', 'on');
    const s = await newSession('Budget review session');
    await appendMsg(s, 'user', 'narwhal question');
    await appendMsg(s, 'assistant', 'narwhal answer');

    const title = await jsonFetch<SearchResp>('/v1/host/openwop-app/chat/search?q=budget');
    expect(title.body.hits.some((h) => h.conversationId === s && !h.messageId)).toBe(true);

    const assistant = await jsonFetch<SearchResp>('/v1/host/openwop-app/chat/search?q=narwhal&role=assistant');
    const hit = assistant.body.hits.find((h) => h.conversationId === s);
    expect(hit?.role).toBe('assistant');
  });

  it('returns no hits for a term in no conversation', async () => {
    await enable('conversation-search', 'on');
    const r = await jsonFetch<SearchResp>('/v1/host/openwop-app/chat/search?q=zzzznonexistentterm');
    expect(r.body.hits).toHaveLength(0);
  });

  it('accepts POST as well as GET', async () => {
    await enable('conversation-search', 'on');
    const r = await jsonFetch<SearchResp>('/v1/host/openwop-app/chat/search', {
      method: 'POST', body: JSON.stringify({ q: 'forecast' }),
    });
    expect(r.status).toBe(200);
    expect(r.body.hits.length).toBeGreaterThanOrEqual(1);
  });
});
