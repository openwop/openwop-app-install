/**
 * ADR 0996 — an artifact a chat tool made is as private as the chat.
 *
 * The code tool (`chat-code:`) and the interactive render tool (`chat-viz:`)
 * store their output as run-event rows with `orgId = tenantId`. The Library
 * gated those rows by org alone, so an artifact made in member A's PRIVATE
 * conversation was listed to member B, and `GET /artifacts/:id` served it.
 *
 * Production-shaped: two members sign in to ONE workspace through the real
 * login route, A opens a conversation through the real chat-sessions route
 * (which records A as its owner), the chat-viz artifact is minted by the REAL
 * render tool in that conversation, and the chat-code row is persisted under
 * the runId the code tool mints (`chatArtifactRunId`, the one builder both use)
 * with the exact typed envelope the tool writes.
 *
 * Red if any reader drops the conversation gate: the Library list, the
 * `?runId=` filter, the per-artifact get / revisions / revision routes, or the
 * `interactive-artifacts.get` agent tool. Also red if hidden stops looking
 * exactly like missing (same 404 body), or if the gate stops being the
 * conversation's own rule (a participant B must see it).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { persistRunArtifact, runArtifactKey } from '../src/host/runArtifactStore.js';
import { chatArtifactRunId } from '../src/host/chatArtifactScope.js';
import { createMember } from '../src/host/accessControlService.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import {
  INTERACTIVE_ARTIFACTS_GET_TOOL_ID,
  INTERACTIVE_ARTIFACTS_RENDER_TOOL_ID,
} from '../src/features/interactive-artifacts/agentTools.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'documents']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: any }
interface Member { userId: string; get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res> }

async function signIn(tenantId: string): Promise<Member> {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  const r = await call('POST', '/host/openwop-app/test/login', { email: `ce62-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { userId: r.body.user.userId as string, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

/** A second person in the SAME workspace: a real `viewer` member of the
 *  workspace-root org (run-event rows are stored with `orgId = tenantId`). */
async function secondMember(tenantId: string): Promise<Member> {
  const m = await signIn(tenantId);
  await createMember({ tenantId, orgId: tenantId, subject: m.userId, displayName: 'B', roles: ['viewer'] });
  return m;
}

const LIB = '/host/openwop-app/artifacts';
const one = (id: string, suffix = ''): string => `${LIB}/${encodeURIComponent(id)}${suffix}`;
const ids = (r: Res): string[] => (r.body.artifacts as Array<{ artifactId: string }>).map((a) => a.artifactId);

/** The typed envelope the code tool writes (agentToolProvider EXECUTE_CODE). */
const codeResult = (stdout: string) => ({
  artifact: { artifactTypeId: 'code.execution-result', payload: { exitCode: 0, stdout, stderr: '', timedOut: false, language: 'python' }, title: 'python execution' },
});

async function openConversation(owner: Member, participants: string[] = []): Promise<string> {
  const r = await owner.post('/host/openwop-app/chat/sessions', { title: 'private', type: 'agent', participants });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return (r.body.sessionId ?? r.body.conversationId ?? r.body.id) as string;
}

async function render(tenantId: string, actingUserId: string, conversationId: string | undefined, source: string): Promise<{ artifactId: string; artifactKey: string }> {
  const res = await createAgentToolProvider({ tenantId, actingUserId, ...(conversationId ? { conversationId } : {}) })
    .executeTool({ name: INTERACTIVE_ARTIFACTS_RENDER_TOOL_ID, input: { kind: 'mermaid', source } });
  expect(res.isError, res.content).toBeFalsy();
  return JSON.parse(res.content) as { artifactId: string; artifactKey: string };
}

async function codeArtifact(tenantId: string, scope: { conversationId?: string; actingUserId?: string }, stdout: string): Promise<string> {
  const runId = chatArtifactRunId('chat-code', { tenantId, ...scope });
  const persisted = await persistRunArtifact({ tenantId, runId, nodeId: `run:${n++}`, role: 'deliverable', output: codeResult(stdout), now: new Date().toISOString() });
  expect(persisted).not.toBeNull();
  return persisted!.artifactId;
}

describe('CE62-F1 — chat-tool artifacts follow the conversation', () => {
  it('a private conversation\'s artifacts are hidden from another member on every read door', async () => {
    const tenantId = `org:ce62-${Date.now()}-${n++}`;
    const a = await signIn(tenantId);
    const b = await secondMember(tenantId);

    // Positive control: B IS a member who sees an ordinary run output.
    const plain = await persistRunArtifact({ tenantId, runId: `run-${n++}`, nodeId: 'n', role: 'deliverable', output: codeResult('shared'), now: new Date().toISOString() });
    expect(ids(await b.get(LIB))).toContain(plain!.artifactId);

    const conv = await openConversation(a);
    const code = await codeArtifact(tenantId, { conversationId: conv, actingUserId: a.userId }, 'private stdout');
    const viz = await render(tenantId, a.userId, conv, 'graph TD; Secret-->Plan');

    // The owner sees both.
    const mine = ids(await a.get(LIB));
    expect(mine).toEqual(expect.arrayContaining([code, viz.artifactId]));
    expect((await a.get(one(code))).status).toBe(200);

    // B: not in the Library, not in the per-run filter.
    const theirs = ids(await b.get(LIB));
    expect(theirs).not.toContain(code);
    expect(theirs).not.toContain(viz.artifactId);
    const runId = chatArtifactRunId('chat-viz', { tenantId, conversationId: conv });
    expect(ids(await b.get(`${LIB}?runId=${encodeURIComponent(runId)}`))).toEqual([]);
    expect(ids(await a.get(`${LIB}?runId=${encodeURIComponent(runId)}`))).toEqual([viz.artifactId]);

    // B: every per-artifact door answers the SAME 404 a missing id gets.
    const missing = `run-event:${runArtifactKey(chatArtifactRunId('chat-code', { tenantId, conversationId: conv }), 'run:none')}`;
    for (const suffix of ['', '/revisions', `/revisions/${encodeURIComponent(`${code.slice('run-event:'.length)}:1`)}`]) {
      const hidden = await b.get(one(code, suffix));
      const absent = await b.get(one(missing, suffix));
      expect(hidden.status, suffix).toBe(404);
      // Same envelope; `details` only echoes the id that was asked for (and the
      // envelope redacts the high-entropy conversation id inside it).
      const shape = (b: { details?: Record<string, unknown> }) => ({ ...b, details: Object.keys(b.details ?? {}).sort() });
      expect(shape(hidden.body), suffix).toEqual(shape(absent.body));
    }

    // The agent tool: B's agent cannot read it back by key; A's can.
    const getAs = async (actingUserId: string) => JSON.parse((await createAgentToolProvider({ tenantId, actingUserId })
      .executeTool({ name: INTERACTIVE_ARTIFACTS_GET_TOOL_ID, input: { artifactKey: viz.artifactKey } })).content);
    expect(await getAs(b.userId)).toEqual({ artifact: null });
    expect((await getAs(a.userId)).artifact?.content).toContain('Secret-->Plan');
  });

  it('the gate IS the conversation rule: a participant sees it', async () => {
    const tenantId = `org:ce62-${Date.now()}-${n++}`;
    const a = await signIn(tenantId);
    const b = await secondMember(tenantId);
    const shared = await openConversation(a, [`user:${b.userId}`]);
    const code = await codeArtifact(tenantId, { conversationId: shared, actingUserId: a.userId }, 'team stdout');
    expect(ids(await b.get(LIB))).toContain(code);
    expect((await b.get(one(code))).status).toBe(200);
  });

  it('outside a conversation the artifact is its maker\'s alone', async () => {
    const tenantId = `org:ce62-${Date.now()}-${n++}`;
    const a = await signIn(tenantId);
    const b = await secondMember(tenantId);
    const code = await codeArtifact(tenantId, { actingUserId: a.userId }, 'solo stdout');
    expect(ids(await a.get(LIB))).toContain(code);
    expect(ids(await b.get(LIB))).not.toContain(code);
    expect((await b.get(one(code))).status).toBe(404);
  });
});
