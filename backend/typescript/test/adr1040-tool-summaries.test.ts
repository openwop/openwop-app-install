/**
 * ADR 1040 D7 F3 (Book AI P47) — per-call display summaries on the turn receipt,
 * on a HOST channel (never the RFC 0064 tool-return event, never model text).
 *
 *  - The chat transport's wrapper records a tool's `display.summary` and STRIPS
 *    it: the loop, the model's messages and the result returned never carry it.
 *  - Plain text with a host cap: tags, controls and bidi overrides removed.
 *  - The route answers one turn's rows to a caller who may READ the
 *    conversation (THE conversation read predicate), and `[]` to anyone else:
 *    another member, another tenant, an unknown run, no subject.
 *  - Deleting the conversation deletes its rows; erasing the acting user erases
 *    theirs.
 *
 * Red when: `withToolSummaryChannel` stops stripping or records failed calls;
 * `sanitizeToolSummary` drops a rule or the cap; `listToolSummariesForTurn`
 * skips `authorizeConversationRead` or the tenant check; the
 * `onConversationDeleted` registration or the DSAR eraser is removed
 * (host/chatToolSummaries.ts).
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import { runChatToolLoop, type CompiledTool } from '../src/host/agentDispatch.js';
import type { AiToolCallRequest, AiToolCallResult } from '../src/executor/types.js';
import {
  eraseSubjectToolSummaries, listToolSummariesForTurn, recordToolSummary, sanitizeToolSummary,
  TOOL_SUMMARY_MAX_CHARS, withToolSummaryChannel,
} from '../src/host/chatToolSummaries.js';

let server: http.Server;
let storage: Storage;
let BASE = '';
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 60_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Body { user?: { userId: string }; summaries?: Array<{ callId: string; summary: string }> }
interface Res { status: number; body: Body }
interface Client { userId: string; get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
async function loginTo(tenantId: string, who: string): Promise<Client> {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as Body) };
  };
  const r = await call('POST', '/host/openwop-app/test/login', { email: `${who}-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { userId: r.body.user?.userId ?? '', get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p) => call('DELETE', p) };
}

/** A conversation owned by A, and its conversation run, with one recorded summary. */
async function fixture() {
  const tenantId = `org:ts1040-${Date.now()}-${n++}`;
  const a = await loginTo(tenantId, 'a');
  const b = await loginTo(tenantId, 'b');
  const sessionId = `ts1040-${Date.now()}-${n++}`;
  expect((await a.post('/host/openwop-app/chat/sessions', { sessionId, title: 'Guide' })).status).toBe(201);
  const now = new Date().toISOString();
  const runId = `run-ts1040-${n++}`;
  const run: RunRecord = {
    runId, workflowId: 'openwop-app.chat', tenantId, status: 'running', inputs: {},
    metadata: { chatSessionId: sessionId, actingUserId: a.userId }, configurable: {}, createdAt: now, updatedAt: now,
  };
  await storage.insertRun(run);
  await recordToolSummary({ tenantId, conversationRunId: runId, callId: 'c1', turnMessageId: 'turn-1', toolName: 'bookai.get-book', summary: 'Read chapter 3', conversationId: sessionId, actingUserId: a.userId });
  return { tenantId, a, b, sessionId, runId };
}
const ROUTE = (runId: string, turn = 'turn-1') => `/host/openwop-app/chat/tool-summaries?conversationRunId=${encodeURIComponent(runId)}&turnMessageId=${turn}`;

describe('sanitizeToolSummary', () => {
  it('keeps plain text and removes markup, controls and bidi overrides', () => {
    expect(sanitizeToolSummary('Read <b>chapter</b> 3')).toBe('Read chapter 3');
    expect(sanitizeToolSummary('a\u0000b\u202ec\nd')).toBe('a b c d');
    expect(sanitizeToolSummary('x < y')).toBe('x < y'); // a lone bracket is text, rendered as text
    expect(sanitizeToolSummary('\u0645\u200f ok \u200d')).toBe('\u0645\u200f ok \u200d'); // RLM + ZWJ kept
    expect(sanitizeToolSummary('a\u{e0041}\ufeffb')).toBe('a b'); // tag chars + BOM removed
    expect(sanitizeToolSummary('   ')).toBeUndefined();
    expect(sanitizeToolSummary(42)).toBeUndefined();
  });

  it('caps the length in code points, never splitting a surrogate pair', () => {
    const s = sanitizeToolSummary('w'.repeat(500))!;
    expect(s.length).toBe(TOOL_SUMMARY_MAX_CHARS);
    expect(s.endsWith('…')).toBe(true);
    const e = sanitizeToolSummary('\u{1F600}'.repeat(300))!;
    expect(Array.from(e).length).toBe(TOOL_SUMMARY_MAX_CHARS);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(e)).toBe(false); // no lone high surrogate
  });
});

describe('the transport channel never lets a summary reach the model', () => {
  it('the wrapper records and strips it; a failed call records nothing', async () => {
    const f = await fixture();
    const exec = withToolSummaryChannel(async (c) => (c.name === 'bad'
      ? { content: 'nope', isError: true, display: { summary: 'SHOULD NOT RECORD' } }
      : { content: 'chapter text', display: { summary: 'SECRET-SUMMARY-xyz' } }), {
      tenantId: f.tenantId, conversationRunId: f.runId, turnMessageId: 'turn-2', conversationId: f.sessionId, actingUserId: f.a.userId,
    });
    const ok = await exec({ name: 'bookai.get-book', input: {}, callId: 'c2' });
    expect(ok).toEqual({ content: 'chapter text' });
    const bad = await exec({ name: 'bad', input: {}, callId: 'c3' });
    expect(bad).not.toHaveProperty('display');
    const rows = await listToolSummariesForTurn(f.tenantId, f.a.userId, f.runId, 'turn-2');
    expect(rows).toEqual([{ callId: 'c2', toolName: 'bookai.get-book', summary: 'SECRET-SUMMARY-xyz' }]);
  });

  it('end to end through the tool loop: no model message carries the summary', async () => {
    const f = await fixture();
    const seen: string[] = [];
    const tool: CompiledTool = { def: { name: 'bookai.get-book', description: 'd', inputSchema: { type: 'object', additionalProperties: true } }, validate: () => ({ ok: true }) };
    let round = 0;
    const callAIWithTools = async (r: AiToolCallRequest): Promise<AiToolCallResult> => {
      seen.push(JSON.stringify(r.messages));
      round += 1;
      return round === 1 ? { content: '', toolCalls: [{ id: 'c9', name: 'bookai.get-book', input: {} }] } : { content: 'done', toolCalls: [] };
    };
    const exec = withToolSummaryChannel(async () => ({ content: 'chapter text', display: { summary: 'SECRET-SUMMARY-loop' } }), {
      tenantId: f.tenantId, conversationRunId: f.runId, turnMessageId: 'turn-3', conversationId: f.sessionId,
    });
    const res = await runChatToolLoop(
      { provider: 'p', model: 'm', credentialRef: 'byok:k', systemPrompt: 'sp', messages: [{ role: 'user', content: 'hi' }], tools: [tool], agentId: 'a', persona: 'T', maxRounds: 3 },
      { callAIWithTools, executeTool: exec },
    );
    expect(seen.length).toBe(2);
    expect(seen.join('\n')).toContain('chapter text');
    expect(seen.join('\n')).not.toContain('SECRET-SUMMARY-loop');
    expect(JSON.stringify(res.events)).not.toContain('SECRET-SUMMARY-loop');
    expect((await listToolSummariesForTurn(f.tenantId, f.a.userId, f.runId, 'turn-3')).map((r) => r.summary)).toEqual(['SECRET-SUMMARY-loop']);
  });
});

describe('a later turn never overwrites an earlier one', () => {
  it('the same call id in two turns keeps both rows', async () => {
    const f = await fixture();
    await recordToolSummary({ tenantId: f.tenantId, conversationRunId: f.runId, callId: 'c1', turnMessageId: 'turn-9', toolName: 't', summary: 'Turn nine', conversationId: f.sessionId });
    expect((await listToolSummariesForTurn(f.tenantId, f.a.userId, f.runId, 'turn-1')).map((r) => r.summary)).toEqual(['Read chapter 3']);
    expect((await listToolSummariesForTurn(f.tenantId, f.a.userId, f.runId, 'turn-9')).map((r) => r.summary)).toEqual(['Turn nine']);
  });
});

describe('the transport wires the channel innermost', () => {
  it('conversationToolLoop strips before eval capture and the loop', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'host', 'conversationToolLoop.ts'), 'utf8');
    expect(src).toMatch(/const summaryStrippedExecuteTool = withToolSummaryChannel\(toolProvider\.executeTool,/);
    expect(src).toMatch(/maybeCaptureExecuteTool\(summaryStrippedExecuteTool,/);
    expect(src).toMatch(/executeTool: chatExecuteTool/);
  });
});

describe('the route', () => {
  it('serves the turn to the conversation owner, and nothing to anyone else', async () => {
    const f = await fixture();
    expect((await f.a.get(ROUTE(f.runId))).body.summaries).toEqual([{ callId: 'c1', toolName: 'bookai.get-book', summary: 'Read chapter 3' }]);
    expect((await f.b.get(ROUTE(f.runId))).body.summaries).toEqual([]);            // another member
    expect((await f.a.get(ROUTE('run-unknown'))).body.summaries).toEqual([]);      // unknown run
    const other = await loginTo(`org:ts1040-other-${n++}`, 'c');
    expect((await other.get(ROUTE(f.runId))).body.summaries).toEqual([]);         // another tenant
    expect(await listToolSummariesForTurn(f.tenantId, undefined, f.runId, 'turn-1')).toEqual([]); // no subject
    expect((await f.a.get('/host/openwop-app/chat/tool-summaries?conversationRunId=x')).status).toBe(400);
  });
});

describe('lifecycle', () => {
  it('deleting the conversation deletes its summaries', async () => {
    const f = await fixture();
    expect((await listToolSummariesForTurn(f.tenantId, f.a.userId, f.runId, 'turn-1')).length).toBe(1);
    expect((await f.a.del(`/host/openwop-app/chat/sessions/${f.sessionId}`)).status).toBeLessThan(300);
    // The conversation is gone, so read through the store's own tenant scan:
    // re-create the session id to make the read predicate pass, and expect nothing.
    expect((await f.a.post('/host/openwop-app/chat/sessions', { sessionId: f.sessionId, title: 'Again' })).status).toBe(201);
    expect(await listToolSummariesForTurn(f.tenantId, f.a.userId, f.runId, 'turn-1')).toEqual([]);
  });

  it('erasing the acting user erases their summaries (and only theirs)', async () => {
    const f = await fixture();
    await recordToolSummary({ tenantId: f.tenantId, conversationRunId: f.runId, callId: 'c-b', turnMessageId: 'turn-1', toolName: 't', summary: 'B row', conversationId: f.sessionId, actingUserId: f.b.userId });
    await eraseSubjectToolSummaries(f.tenantId, f.a.userId);
    expect((await listToolSummariesForTurn(f.tenantId, f.a.userId, f.runId, 'turn-1')).map((r) => r.callId)).toEqual(['c-b']);
  });
});
