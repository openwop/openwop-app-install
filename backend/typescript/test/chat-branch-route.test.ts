/**
 * ADR 0117 Phase 1 — conversation branch route.
 * Branching forks the message lineage at a settled turn: the child carries the
 * parent's prefix (same roles, contents, order) + records `branchedFrom`;
 * fromSeq is bounds-checked.
 *
 * Tracker TST-CEC-1. Red when (w67g3, witnessed): the child copies the whole
 * thread instead of `slice(0, fromSeq)`; an omitted `fromSeq` defaults to 0;
 * the past-the-end (422) or negative (400) refusal is dropped; the
 * `branchedFrom` lineage is not recorded on the child's meta.
 * The 404 case is held by two guards (`requireVisibleAsync` on a missing meta
 * and the missing `getChatSession`), so it pins the outcome, not one guard.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

interface Conversation { sessionId: string; title: string; branchedFrom?: { conversationId: string; fromSeq: number } }
interface Msg { role: string; content: string }
interface ErrorBody { error: string; message: string }

async function j<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
  return { status: res.status, body: (await res.json()) as T };
}
async function newSession(title: string): Promise<string> {
  const r = await j<Conversation>('/host/openwop-app/chat/sessions', { method: 'POST', body: JSON.stringify({ title }) });
  expect(r.status).toBe(201);
  return r.body.sessionId;
}
async function addMsgs(id: string, msgs: Array<[string, string]>): Promise<void> {
  for (let n = 0; n < msgs.length; n++) {
    const [role, content] = msgs[n]!;
    const r = await j<unknown>(`/host/openwop-app/chat/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({ messageId: `${id}-m${n}`, role, content }) });
    expect(r.status).toBe(201);
  }
}
const branch = (id: string, body: Record<string, unknown>) =>
  j<Conversation & ErrorBody>(`/host/openwop-app/chat/sessions/${id}/branch`, { method: 'POST', body: JSON.stringify(body) });
const messagesOf = async (id: string): Promise<Array<[string, string]>> =>
  (await j<{ messages: Msg[] }>(`/host/openwop-app/chat/sessions/${id}/messages`)).body.messages.map((m) => [m.role, m.content]);

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('conversation branch route', () => {
  it('branches at a settled turn — child carries the prefix + branchedFrom lineage', async () => {
    const parent = await newSession('Planning');
    const thread: Array<[string, string]> = [
      ['user', 'first question'], ['assistant', 'first answer'], ['user', 'second question'], ['assistant', 'second answer'],
    ];
    await addMsgs(parent, thread);

    // Branch after the first exchange (carry 2 messages).
    const r = await branch(parent, { fromSeq: 2 });
    expect(r.status).toBe(201);
    const child = r.body.sessionId;
    expect(child).not.toBe(parent);
    expect(r.body.title).toBe('Planning (branch)');
    expect(r.body.branchedFrom).toEqual({ conversationId: parent, fromSeq: 2 });

    expect(await messagesOf(child)).toEqual(thread.slice(0, 2));
    expect(await messagesOf(parent)).toEqual(thread); // parent unchanged
  });

  it('defaults fromSeq to the full length when omitted', async () => {
    const parent = await newSession('Full');
    await addMsgs(parent, [['user', 'a'], ['assistant', 'b']]);
    const r = await branch(parent, {});
    expect(r.status).toBe(201);
    expect(r.body.branchedFrom).toEqual({ conversationId: parent, fromSeq: 2 });
    expect(await messagesOf(r.body.sessionId)).toEqual([['user', 'a'], ['assistant', 'b']]);
  });

  it('rejects fromSeq past the end (422) and a negative fromSeq (400)', async () => {
    const parent = await newSession('Bounds');
    await addMsgs(parent, [['user', 'only']]);
    const past = await branch(parent, { fromSeq: 99 });
    expect(past.status).toBe(422);
    expect(past.body.error).toBe('validation_error');
    expect(past.body.message).toBe('fromSeq 99 exceeds the conversation length (1).');
    const negative = await branch(parent, { fromSeq: -1 });
    expect(negative.status).toBe(400);
    expect(negative.body.error).toBe('validation_error');
    expect(negative.body.message).toBe('fromSeq MUST be a non-negative integer.');
  });

  it('404s branching a non-existent conversation', async () => {
    const r = await branch('nope-nope', {});
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_found');
  });
});
