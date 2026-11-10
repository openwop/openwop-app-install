/**
 * ADR 1042 (review round 3) — a channel-ingress conversation's outsider history
 * can't leak sideways into a full-tools turn, and erasing its thread deletes its
 * runs.
 *
 *  1. Re-binding a channel conversation to a fresh (unstamped) run is refused
 *     with a typed 409; so is branching it (which would copy the transcript into
 *     an ordinary conversation). An ordinary session is not refused.
 *  2. `openwop:conversations.search` never returns a channel conversation.
 *  3. `openwop:runs.diagnose` treats a channel conversation's run as invisible.
 *  4. Erasing a DM thread deletes its conversation runs and their events.
 *  5. (round 4) Export, save-as-Document and re-import of a channel conversation
 *     are refused.
 *
 * Red when: the chatSessions re-bind or branch refusal is removed; the search
 * filter is removed; the diagnose exclusion is removed; the eraser stops
 * deleting the thread's runs.
 * Sabotage-witnessed 2026-11-03: removing each of those turned its case red.
 * Round 4, 2026-11-03: removing the export-route refusal, the import refusal or
 * the export-document refusal each turned its case red (1 failed | 6 passed).
 * Re-measured in /grade-tests w87 (g2 probes cg-*): every guard above, one at a
 * time, turned its own case red.
 * Double source (recorded, not a gap): the eraser deletes the union of the
 * thread's `runIds` and `runId`; this fixture sets both to the same run, so
 * dropping either source alone stays green (probe cg-erase-runids-only read
 * vacuous by construction). Dropping the `deleteRun` call turns the case red.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootChannelHarness, field, type ChannelHarness } from './support/channelCoreHarness.js';
import { builtinAgentTool } from '../src/host/agentToolProvider.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { conversationIdOf, getThread, markChannelConversation, putThread, recordSenderInThread, threadKeyOf } from '../src/features/channel-ingress/stores.js';
import type { RunRecord } from '../src/types.js';

type ToolScope = Parameters<NonNullable<ReturnType<typeof builtinAgentTool>>['run']>[1];

let h: ChannelHarness;
beforeAll(async () => { h = await bootChannelHarness('c1042g3'); }, 120_000);
afterAll(async () => { await h?.close(); });

async function session(cookie: string, sessionId: string, text: string): Promise<void> {
  expect((await h.call('/host/openwop-app/chat/sessions', cookie, 'POST', { sessionId, title: 'x' })).status).toBe(201);
  expect((await h.call(`/host/openwop-app/chat/sessions/${sessionId}/messages`, cookie, 'POST', {
    messageId: `${sessionId}-m1`, role: 'user', content: JSON.stringify({ role: 'user', content: text }),
  })).status).toBe(201);
}

async function failedRun(metadata: Record<string, unknown>): Promise<string> {
  const now = new Date().toISOString();
  const runId = randomUUID();
  const run: RunRecord = { runId, workflowId: 'openwop-app.conversation', tenantId: h.ws, status: 'failed', inputs: null, metadata, configurable: {}, createdAt: now, updatedAt: now };
  await h.storage.insertRun(run);
  await h.storage.appendEvent({ eventId: randomUUID(), runId, type: 'node.failed', nodeId: 'gate', payload: { error: { message: 'outsider said: kumquat' } }, timestamp: now });
  return runId;
}

describe('re-bind and branch of a channel conversation are refused', () => {
  it('a channel conversation answers 409 channel_ingress_conversation; an ordinary one does not', async () => {
    const editor = await h.editor();
    await session(editor, 'ch-guard-1', 'outsider words');
    await session(editor, 'plain-guard-1', 'my own words');
    await markChannelConversation(h.ws, 'ch-guard-1', 'tk-guard-1');

    const rebind = await h.call('/host/openwop-app/chat/sessions/ch-guard-1/conversation-run', editor, 'PUT', { conversationRunId: 'r-fresh-1' });
    expect(rebind.status).toBe(409);
    expect(field(rebind.body, 'details', 'reason')).toBe('channel_ingress_conversation');
    const branch = await h.call('/host/openwop-app/chat/sessions/ch-guard-1/branch', editor, 'POST', { fromSeq: 1 });
    expect(branch.status).toBe(409);
    expect(field(branch.body, 'details', 'reason')).toBe('channel_ingress_conversation');

    // Non-vacuity: the same calls on an ordinary session are not this refusal.
    const plainRebind = await h.call('/host/openwop-app/chat/sessions/plain-guard-1/conversation-run', editor, 'PUT', { conversationRunId: 'r-fresh-2' });
    expect(field(plainRebind.body, 'details', 'reason')).not.toBe('channel_ingress_conversation');
    const plainBranch = await h.call('/host/openwop-app/chat/sessions/plain-guard-1/branch', editor, 'POST', { fromSeq: 1 });
    expect(field(plainBranch.body, 'details', 'reason')).not.toBe('channel_ingress_conversation');
  });
});

describe('model-facing tools never surface a channel conversation', () => {
  it('conversations.search drops channel conversations', async () => {
    const editor = await h.editor();
    await session(editor, 'ch-search-1', 'kumquat from an outsider');
    await session(editor, 'plain-search-1', 'kumquat from me');
    await markChannelConversation(h.ws, 'ch-search-1', 'tk-search-1');
    const tool = builtinAgentTool('openwop:conversations.search');
    expect(tool, 'search tool registered').toBeTruthy();
    const scope: ToolScope = { tenantId: h.ws, actingUserId: h.editorUserId };
    const out = await tool!.run({ query: 'kumquat' }, scope);
    const hits: unknown = field(JSON.parse(out.content), 'hits');
    const ids = (Array.isArray(hits) ? hits : []).map((x) => field(x, 'conversationId'));
    expect(ids).toContain('plain-search-1'); // non-vacuity
    expect(ids).not.toContain('ch-search-1');
  });

  it('runs.diagnose treats a channel conversation run as invisible', async () => {
    const tool = builtinAgentTool('openwop:runs.diagnose');
    expect(tool, 'diagnose tool registered').toBeTruthy();
    const scope: ToolScope = { tenantId: h.ws, actingUserId: h.editorUserId };
    const channel = await failedRun({ channelIngress: { lane: 'conn:x', scope: 'narrow' } });
    const plain = await failedRun({});
    const ch = JSON.stringify(await tool!.run({ runId: channel }, scope));
    expect(ch).toContain('No such run is visible to you.');
    expect(ch).not.toContain('kumquat');
    expect(JSON.stringify(await tool!.run({ runId: plain }, scope))).not.toContain('No such run is visible to you.'); // non-vacuity
  });
});

describe('a channel conversation cannot be copied out (review round 4)', () => {
  it('GET export answers 409; an ordinary session exports', async () => {
    const editor = await h.editor();
    await session(editor, 'ch-export-1', 'outsider words');
    await session(editor, 'plain-export-1', 'my own words');
    await markChannelConversation(h.ws, 'ch-export-1', 'tk-export-1');
    const ch = await h.call('/host/openwop-app/chat-export/ch-export-1?format=json', editor, 'GET');
    expect(ch.status).toBe(409);
    expect(field(ch.body, 'details', 'reason')).toBe('channel_ingress_conversation');
    expect((await h.call('/host/openwop-app/chat-export/plain-export-1?format=json', editor, 'GET')).status).toBe(200); // non-vacuity
  });

  it('conversations.export-document refuses a channel conversation', async () => {
    const editor = await h.editor();
    await session(editor, 'ch-doc-1', 'outsider words');
    await session(editor, 'plain-doc-1', 'my own words');
    await markChannelConversation(h.ws, 'ch-doc-1', 'tk-doc-1');
    const tool = builtinAgentTool('openwop:conversations.export-document');
    expect(tool, 'export-document tool registered').toBeTruthy();
    const scope: ToolScope = { tenantId: h.ws, actingUserId: h.editorUserId, runId: 'r-doc-1' };
    const out = await tool!.run({ conversationId: 'ch-doc-1' }, scope);
    expect(out.isError).toBe(true);
    expect(field(JSON.parse(out.content), 'error')).toBe('channel_ingress_conversation');
    // Non-vacuity: an ordinary conversation through the same tool is not this refusal.
    const plain = await tool!.run({ conversationId: 'plain-doc-1' }, scope);
    expect(field(JSON.parse(plain.content), 'error')).not.toBe('channel_ingress_conversation');
  });

  it('import refuses an openwop export whose source is a channel conversation; an ordinary source imports', async () => {
    const editor = await h.editor();
    await session(editor, 'ch-import-1', 'outsider words');
    await markChannelConversation(h.ws, 'ch-import-1', 'tk-import-1');
    const data = (sessionId: string) => ({
      version: 'openwop-v1', conversation: { sessionId, title: 't', createdAt: new Date().toISOString() },
      messages: [{ role: 'user', content: 'hello' }],
    });
    const ch = await h.call('/host/openwop-app/chat-export/import', editor, 'POST', { format: 'openwop', data: data('ch-import-1') });
    expect(ch.status).toBe(409);
    expect(field(ch.body, 'details', 'reason')).toBe('channel_ingress_conversation');
    const plain = await h.call('/host/openwop-app/chat-export/import', editor, 'POST', { format: 'openwop', data: data('no-such-source') });
    expect(field(plain.body, 'details', 'reason')).not.toBe('channel_ingress_conversation'); // non-vacuity
  });
});

describe('erasing a DM thread deletes its conversation runs and their events', () => {
  it('run and events are gone after the external person is erased', async () => {
    const owner = 'user:g3-owner';
    const threadKey = threadKeyOf('conn:conn:g3', 'D0G3', owner, 'narrow');
    const conversationId = conversationIdOf(threadKey);
    const runId = await failedRun({ channelIngress: { lane: 'conn:conn:g3', scope: 'narrow' }, chatSessionId: conversationId });
    const now = new Date().toISOString();
    await putThread({
      threadKey, tenantId: h.ws, lane: { kind: 'connection', connectionId: 'conn:g3', provider: 'slack' }, chatId: 'D0G3', conversationId,
      ownerUserId: owner, isGroup: false, scope: 'narrow', runId, runIds: [runId], createdAt: now, updatedAt: now,
    });
    await recordSenderInThread(h.ws, 'conn:conn:g3', 'U0G3', threadKey);
    expect((await h.storage.listEvents(runId)).length).toBeGreaterThan(0);

    expect((await eraseSubject(h.ws, 'U0G3')).failed).toBe(0);
    expect(await getThread(threadKey)).toBeNull();
    expect(await h.storage.getRun(runId)).toBeNull();
    expect(await h.storage.listEvents(runId)).toEqual([]);
  });
});
