/**
 * ADR 0117 Phase 1 — conversation branch route.
 * Branching forks the message lineage at a settled turn: the child carries the
 * parent's prefix + records `branchedFrom`; fromSeq is bounds-checked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

async function j<T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
  return { status: res.status, body: (res.status === 204 ? undefined : await res.json()) as T };
}
async function newSession(title: string): Promise<string> {
  return (await j<{ sessionId: string }>('/v1/host/openwop-app/chat/sessions', { method: 'POST', body: JSON.stringify({ title }) })).body.sessionId;
}
async function addMsg(id: string, role: string, content: string): Promise<void> {
  await j(`/v1/host/openwop-app/chat/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({ messageId: `${id}-${Math.random().toString(36).slice(2)}`, role, content }) });
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('conversation branch route', () => {
  it('branches at a settled turn — child carries the prefix + branchedFrom lineage', async () => {
    const parent = await newSession('Planning');
    await addMsg(parent, 'user', 'first question');
    await addMsg(parent, 'assistant', 'first answer');
    await addMsg(parent, 'user', 'second question');
    await addMsg(parent, 'assistant', 'second answer');

    // Branch after the first exchange (carry 2 messages).
    const r = await j<{ sessionId: string; branchedFrom?: { conversationId: string; fromSeq: number }; title: string }>(
      `/v1/host/openwop-app/chat/sessions/${parent}/branch`, { method: 'POST', body: JSON.stringify({ fromSeq: 2 }) });
    expect(r.status).toBe(201);
    const child = r.body.sessionId;
    expect(child).toBeTruthy();
    expect(child).not.toBe(parent);
    expect(r.body.title).toContain('(branch)');

    const childMsgs = await j<{ messages: unknown[] }>(`/v1/host/openwop-app/chat/sessions/${child}/messages`);
    expect(childMsgs.body.messages).toHaveLength(2);

    const parentMsgs = await j<{ messages: unknown[] }>(`/v1/host/openwop-app/chat/sessions/${parent}/messages`);
    expect(parentMsgs.body.messages).toHaveLength(4); // parent unchanged
  });

  it('defaults fromSeq to the full length when omitted', async () => {
    const parent = await newSession('Full');
    await addMsg(parent, 'user', 'a');
    await addMsg(parent, 'assistant', 'b');
    const r = await j<{ sessionId: string }>(`/v1/host/openwop-app/chat/sessions/${parent}/branch`, { method: 'POST', body: JSON.stringify({}) });
    expect(r.status).toBe(201);
    const child = r.body.sessionId;
    expect((await j<{ messages: unknown[] }>(`/v1/host/openwop-app/chat/sessions/${child}/messages`)).body.messages).toHaveLength(2);
  });

  it('rejects fromSeq past the end (422) and a negative fromSeq (400)', async () => {
    const parent = await newSession('Bounds');
    await addMsg(parent, 'user', 'only');
    expect((await j(`/v1/host/openwop-app/chat/sessions/${parent}/branch`, { method: 'POST', body: JSON.stringify({ fromSeq: 99 }) })).status).toBe(422);
    expect((await j(`/v1/host/openwop-app/chat/sessions/${parent}/branch`, { method: 'POST', body: JSON.stringify({ fromSeq: -1 }) })).status).toBe(400);
  });

  it('404s branching a non-existent conversation', async () => {
    expect((await j('/v1/host/openwop-app/chat/sessions/nope-nope/branch', { method: 'POST', body: JSON.stringify({}) })).status).toBe(404);
  });
});
