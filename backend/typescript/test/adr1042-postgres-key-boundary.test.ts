/**
 * ADR 1042 Correction (2026-11-06), CHAN-KEY-1 — the PostgreSQL TEXT parameter
 * boundary on the real conversation-run route. A read-only PostgreSQL SELECT
 * rejected a NUL parameter with SQLSTATE 22021 / 0x00; before the fix, that made
 * an ORDINARY Pair → full-chat promotion read as a channel-ingress conversation
 * and get refused 409. This file applies that exact rejection to the app's KV
 * calls over a disposable memory:// store (no PostgreSQL, no provider), so it
 * runs in the default gate.
 *
 * Guards, in series: the route's `refuseChannelIngress` → the registered check
 * `isChannelIngressConversation`, which fails CLOSED (an unreadable marker counts
 * as a channel conversation).
 *
 * Red when (sabotage-witnessed, w93): the stores never fall back to the safe id
 * (ordinary binding and every store case fail); the route drops its ingress
 * refusal (marked and unreadable markers both bind); the guard fails open; the
 * route drops its foreign-tenant or mismatched-session refusal.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bootChannelHarness, field, type ChannelHarness } from './support/channelCoreHarness.js';
import type { RunRecord } from '../src/types.js';
import { approveSender, channelIngressStores, getApprovedSender, isChannelConversation, listPendingSenders, markChannelConversation, recordPendingSender, recordSenderInThread } from '../src/features/channel-ingress/stores.js';

let h: ChannelHarness;
let cookie: string;
let restore = (): void => {};
beforeAll(async () => { h = await bootChannelHarness('channel-nul-boundary'); cookie = await h.editor(); }, 120_000);
afterEach(() => { restore(); restore = () => {}; });
afterAll(async () => { await h?.close(); });

/** Faithful parameter rejection only; all supported reads/writes still use the
 * real app's storage. The guard itself and all HTTP authorization remain real. */
function rejectNulParameters(): { rejected: string[] } {
  const originalGet = h.storage.kvGet.bind(h.storage);
  const originalSet = h.storage.kvSet.bind(h.storage);
  const originalDelete = h.storage.kvDelete.bind(h.storage);
  const rejected: string[] = [];
  const validate = (value: string): void => {
    if (!value.includes('\u0000')) return;
    rejected.push(value);
    throw Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: '22021' });
  };
  h.storage.kvGet = async key => { validate(key); return originalGet(key); };
  h.storage.kvSet = async (key, value) => { validate(key); validate(value); await originalSet(key, value); };
  h.storage.kvDelete = async key => { validate(key); return originalDelete(key); };
  restore = () => { h.storage.kvGet = originalGet; h.storage.kvSet = originalSet; h.storage.kvDelete = originalDelete; };
  return { rejected };
}
async function fixture(): Promise<{ sessionId: string; runId: string }> {
  const sessionId = randomUUID(), runId = randomUUID();
  expect((await h.call('/host/openwop-app/chat/sessions', cookie, 'POST', { sessionId, title: 'Controlled Pair fixture' })).status).toBe(201);
  const now = new Date().toISOString();
  const run: RunRecord = { runId, workflowId: 'openwop-app.conversation', tenantId: h.ws, status: 'failed', inputs: null, metadata: { chatSessionId: sessionId }, configurable: {}, createdAt: now, updatedAt: now };
  await h.storage.insertRun(run);
  return { sessionId, runId };
}
const bind = (sessionId: string, runId: string) => h.call(`/host/openwop-app/chat/sessions/${sessionId}/conversation-run`, cookie, 'PUT', { conversationRunId: runId });

describe('ordinary versus ingress conversation binding', () => {
  it('healthy ordinary-session control binds a real same-session conversation run', async () => {
    const f = await fixture();
    expect((await bind(f.sessionId, f.runId)).status).toBe(204);
  });
  it('ordinary Pair binding remains valid through the PostgreSQL NUL parameter boundary', async () => {
    const f = await fixture();
    rejectNulParameters();
    const result = await bind(f.sessionId, f.runId);
    expect({ status: result.status, reason: field(result.body, 'details', 'reason') }).toEqual({ status: 204, reason: undefined });
  });
  it('a real ingress marker still refuses binding with the protected409 reason', async () => {
    const f = await fixture();
    rejectNulParameters();
    await markChannelConversation(h.ws, f.sessionId, 'controlled-thread');
    expect(await isChannelConversation(h.ws, f.sessionId)).toBe(true);
    const result = await bind(f.sessionId, f.runId);
    expect(result.status).toBe(409);
    expect(field(result.body, 'details', 'reason')).toBe('channel_ingress_conversation');
  });
  it('an unrelated marker-storage failure remains fail-closed', async () => {
    const f = await fixture();
    const original = h.storage.kvGet.bind(h.storage);
    h.storage.kvGet = async key => {
      if (key.startsWith('hostext:channel-ingress:conversation:')) throw Object.assign(new Error('controlled storage unavailable'), { code: '08006' });
      return original(key);
    };
    restore = () => { h.storage.kvGet = original; };
    const result = await bind(f.sessionId, f.runId);
    expect(result.status).toBe(409);
    expect(field(result.body, 'details', 'reason')).toBe('channel_ingress_conversation');
  });
  it('ordinary binding keeps foreign-tenant and mismatched-session run refusals', async () => {
    const f = await fixture();
    const other = await fixture();
    rejectNulParameters();
    const mismatched = await bind(f.sessionId, other.runId);
    expect({ status: mismatched.status, error: field(mismatched.body, 'error'), message: field(mismatched.body, 'message') })
      .toEqual({ status: 400, error: 'validation_error', message: 'conversationRunId belongs to a different chat session.' });
    // A low-entropy id: the envelope redacts high-entropy ids from messages.
    const now = new Date().toISOString(), runId = 'controlled-foreign-run';
    await h.storage.insertRun({ runId, workflowId: 'openwop-app.conversation', tenantId: 'controlled-foreign-tenant', status: 'failed', inputs: null, metadata: { chatSessionId: f.sessionId }, configurable: {}, createdAt: now, updatedAt: now });
    const foreign = await bind(f.sessionId, runId);
    expect({ status: foreign.status, error: field(foreign.body, 'error'), message: field(foreign.body, 'message') })
      .toEqual({ status: 404, error: 'run_not_found', message: `run ${runId} not found` });
  });
});

describe('compound channel-ingress store identities', () => {
  it('can read an absent marker on the PostgreSQL boundary', async () => {
    rejectNulParameters();
    await expect(isChannelConversation(h.ws, randomUUID())).resolves.toBe(false);
  });
  it('can persist and read a true marker on the PostgreSQL boundary', async () => {
    rejectNulParameters();
    const sessionId = randomUUID();
    await expect(markChannelConversation(h.ws, sessionId, 'controlled-thread')).resolves.toBeUndefined();
    await expect(isChannelConversation(h.ws, sessionId)).resolves.toBe(true);
  });
  it('can approve and read a sender on the PostgreSQL boundary', async () => {
    rejectNulParameters();
    const laneKey = `relay:${randomUUID()}`, senderId = 'controlled-sender';
    await expect(approveSender({ tenantId: h.ws, laneKey, senderId, ownerUserId: h.editorUserId })).resolves.toMatchObject({ senderId });
    await expect(getApprovedSender(laneKey, senderId)).resolves.toMatchObject({ senderId });

  });
  it('can record a pending sender on the PostgreSQL boundary', async () => {
    rejectNulParameters();
    const laneKey = `relay:${randomUUID()}`;
    await expect(recordPendingSender({ tenantId: h.ws, laneKey, senderId: 'controlled-pending', chatId: 'controlled-chat' })).resolves.toBeUndefined();
    const rows = await listPendingSenders(h.ws, laneKey);
    expect(rows.map((r) => ({ senderId: r.senderId, count: r.count, nul: r.key.includes('\u0000') }))).toEqual([{ senderId: 'controlled-pending', count: 1, nul: false }]);
  });
  it('can record a sender-thread erasure index on the PostgreSQL boundary', async () => {
    rejectNulParameters();
    const laneKey = `relay:${randomUUID()}`;
    await expect(recordSenderInThread(h.ws, laneKey, 'controlled-sender', 'controlled-thread')).resolves.toBeUndefined();
    const rows = (await channelIngressStores.senderThreads.listForTenantIndexed(h.ws)).filter((r) => r.laneKey === laneKey);
    expect(rows.map((r) => ({ senderId: r.senderId, threadKey: r.threadKey, nul: r.key.includes('\u0000') }))).toEqual([{ senderId: 'controlled-sender', threadKey: 'controlled-thread', nul: false }]);
  });

});
