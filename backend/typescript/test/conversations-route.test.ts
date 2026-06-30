/**
 * Persistent conversations (ADR 0043) — ROUTE harness over the generalized chat
 * surface. Proves the conversation META sidecar turns a chat_session into a
 * typed, owned, multi-participant conversation WITHOUT a parallel store:
 *   - create with `type` + `participants` → owner + members persisted
 *   - list/get enrich with type + participants; a legacy session → `agent` + []
 *   - open-or-resume a 1:1 is idempotent via the canonical dmKey (no fork)
 *   - participants add/remove (owner not removable) — replaces the FE-only panel
 *   - read-state marks the owner's lastReadAt
 *   - delete cascades the meta (a re-open creates fresh)
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { ensureAssistantAgent } from '../src/features/assistant/capability.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string, b?: unknown) => call('PUT', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b), del: (p: string) => call('DELETE', p) };
}
async function owner() {
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `conv-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { c, userId: r.body.user.userId as string };
}

const S = '/v1/host/openwop-app/chat/sessions';

describe('conversations — typed model + participants', () => {
  it('creates a typed conversation with participants (owner + members)', async () => {
    const { c, userId } = await owner();
    const r = await c.post(S, { title: 'Ask Felix', type: 'agent', participants: ['agent:user.t.felix'] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.type).toBe('agent');
    const refs = (r.body.participants as Array<{ subjectRef: string; role: string }>);
    expect(refs.find((p) => p.subjectRef === `user:${userId}`)?.role).toBe('owner');
    expect(refs.some((p) => p.subjectRef === 'agent:user.t.felix' && p.role === 'member')).toBe(true);
  });

  it('list + get enrich with type + participants; a legacy (untyped) session reads as agent/[]', async () => {
    const { c } = await owner();
    await c.post(S, { title: 'Council', type: 'group', participants: ['agent:a', 'agent:b'] });
    const legacy = await c.post(S, { title: 'Plain' }); // no type → default agent, no meta participants
    const list = await c.get(S);
    const group = (list.body.sessions as any[]).find((s) => s.title === 'Council');
    expect(group.type).toBe('group');
    expect(group.participants.length).toBe(3); // owner + 2
    const got = await c.get(`${S}/${encodeURIComponent(legacy.body.sessionId)}`);
    expect(got.body.type).toBe('agent');
  });

  it('open-or-resume a 1:1 is idempotent (same dmKey → same conversation)', async () => {
    const { c } = await owner();
    const first = await c.post('/v1/host/openwop-app/chat/conversations/open', { type: 'agent', subjectRef: 'agent:user.t.ada' });
    expect(first.status).toBe(201);
    const again = await c.post('/v1/host/openwop-app/chat/conversations/open', { type: 'agent', subjectRef: 'agent:user.t.ada' });
    expect(again.status).toBe(200); // resumed, not created
    expect(again.body.sessionId).toBe(first.body.sessionId);
  });

  it('adds + removes participants; the owner cannot be removed', async () => {
    const { c, userId } = await owner();
    const conv = await c.post(S, { type: 'group', participants: ['agent:a'] });
    const id = conv.body.sessionId;
    const added = await c.put(`${S}/${id}/participants`, { subjectRef: 'agent:b' });
    expect((added.body.participants as any[]).some((p) => p.subjectRef === 'agent:b')).toBe(true);
    const removed = await c.del(`${S}/${id}/participants/${encodeURIComponent('agent:a')}`);
    expect((removed.body.participants as any[]).some((p) => p.subjectRef === 'agent:a')).toBe(false);
    // Owner survives a removal attempt.
    const ownerGone = await c.del(`${S}/${id}/participants/${encodeURIComponent(`user:${userId}`)}`);
    expect((ownerGone.body.participants as any[]).some((p) => p.subjectRef === `user:${userId}` && p.role === 'owner')).toBe(true);
  });

  it('attaches a board → promotes the conversation to a group linked to the board (idempotent)', async () => {
    const { c } = await owner();
    const conv = await c.post(S, { title: 'chat' }); // default `agent`
    const id = conv.body.sessionId;
    const r = await c.post(`${S}/${id}/board`, { boardId: 'board-titans', participants: ['agent:user.t.felix', 'agent:user.t.ada'] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.type).toBe('group');
    expect(r.body.boardId).toBe('board-titans');
    const refs = (r.body.participants as Array<{ subjectRef: string }>).map((p) => p.subjectRef);
    expect(refs).toContain('agent:user.t.felix');
    expect(refs).toContain('agent:user.t.ada');
    // Re-summoning the same board doesn't duplicate the cohort.
    const again = await c.post(`${S}/${id}/board`, { boardId: 'board-titans', participants: ['agent:user.t.felix'] });
    expect((again.body.participants as Array<{ subjectRef: string }>).filter((p) => p.subjectRef === 'agent:user.t.felix').length).toBe(1);
    // It now lists under groups with its board link intact.
    const got = await c.get(`${S}/${id}`);
    expect(got.body.type).toBe('group');
    expect(got.body.boardId).toBe('board-titans');
  });

  it('rename preserves the conversation type + participants in the response', async () => {
    const { c } = await owner();
    const conv = await c.post(S, { title: 'Before', type: 'group', participants: ['agent:a', 'agent:b'] });
    const renamed = await c.patch(`${S}/${conv.body.sessionId}`, { title: 'After' });
    expect(renamed.body.title).toBe('After');
    expect(renamed.body.type).toBe('group');
    expect((renamed.body.participants as any[]).length).toBe(3); // owner + 2 survive the rename
  });

  it('read-state marks the owner lastReadAt; delete cascades the meta', async () => {
    const { c, userId } = await owner();
    const conv = await c.post(S, { type: 'agent', participants: ['agent:x'] });
    const id = conv.body.sessionId;
    expect((await c.post(`${S}/${id}/read`)).status).toBe(204);
    const parts = await c.get(`${S}/${id}/participants`);
    expect((parts.body.participants as any[]).find((p) => p.subjectRef === `user:${userId}`)?.lastReadAt).toBeTruthy();
    expect((await c.del(`${S}/${id}`)).status).toBe(204);
    expect((await c.get(`${S}/${id}`)).status).toBe(404);
  });

  it('a read marker survives a concurrent participant add (no race on a shared record)', async () => {
    const { c, userId } = await owner();
    const conv = await c.post(S, { type: 'group', participants: ['agent:a'] });
    const id = conv.body.sessionId;
    // Read-state and membership now live in separate stores, so marking read
    // and adding a participant at the same time can't clobber each other.
    await Promise.all([
      c.post(`${S}/${id}/read`),
      c.put(`${S}/${id}/participants`, { subjectRef: 'agent:b' }),
    ]);
    const got = await c.get(`${S}/${id}`);
    const parts = got.body.participants as Array<{ subjectRef: string; lastReadAt?: string }>;
    expect(parts.some((p) => p.subjectRef === 'agent:b'), 'the participant add persisted').toBe(true);
    expect(parts.find((p) => p.subjectRef === `user:${userId}`)?.lastReadAt, 'the read marker persisted').toBeTruthy();
  });

  it('participant-scoped visibility (404 for non-members) layered with owner-gated mutation (403)', async () => {
    // Two distinct users in the SAME tenant (explicit tenantId + subject).
    const tenantId = `acme-${Date.now()}-${n++}`;
    const a = client();
    const ra = await a.post('/v1/host/openwop-app/test/login', { email: `owner-${n}@acme.test`, tenantId, subject: `oidc:owner-${n}` });
    expect(ra.status).toBe(201);
    const b = client();
    const rb = await b.post('/v1/host/openwop-app/test/login', { email: `other-${n}@acme.test`, tenantId, subject: `oidc:other-${n}` });
    expect(rb.status).toBe(201);
    const bId = rb.body.user.userId as string;

    // A owns a group conversation B is NOT part of.
    const conv = await a.post(S, { type: 'group', participants: ['agent:a'] });
    const id = conv.body.sessionId;

    // Visibility (ADR 0043 Phase 6): a co-tenant NON-participant can't even see
    // it — every by-id route is 404 (no existence leak), and it's absent from
    // B's list.
    expect((await b.get(`${S}/${id}`)).status, 'read non-participant').toBe(404);
    expect((await b.get(`${S}/${id}/messages`)).status, 'messages non-participant').toBe(404);
    expect((await b.put(`${S}/${id}/participants`, { subjectRef: 'agent:x' })).status, 'add non-participant').toBe(404);
    expect((await b.del(`${S}/${id}/participants/${encodeURIComponent('agent:a')}`)).status, 'remove non-participant').toBe(404);
    expect((await b.post(`${S}/${id}/board`, { boardId: 'bd', participants: [] })).status, 'board non-participant').toBe(404);
    const bList = await b.get(S);
    expect((bList.body.sessions as Array<{ sessionId: string }>).some((s) => s.sessionId === id), 'absent from B list').toBe(false);

    // A (owner) adds B as a participant.
    expect((await a.put(`${S}/${id}/participants`, { subjectRef: `user:${bId}` })).status).toBe(200);

    // Now B can READ it (visible) — but RBAC still blocks membership mutation
    // (visible, not owner → 403, not 404).
    expect((await b.get(`${S}/${id}`)).status, 'read participant').toBe(200);
    expect((await b.get(S)).body.sessions.some((s: { sessionId: string }) => s.sessionId === id), 'present in B list').toBe(true);
    expect((await b.put(`${S}/${id}/participants`, { subjectRef: 'agent:x' })).status, 'add as participant-non-owner').toBe(403);
    expect((await b.post(`${S}/${id}/board`, { boardId: 'bd', participants: [] })).status, 'board as participant-non-owner').toBe(403);

    // A (the owner) succeeds at mutation.
    const ok = await a.put(`${S}/${id}/participants`, { subjectRef: 'agent:x' });
    expect(ok.status).toBe(200);
    expect((ok.body.participants as Array<{ subjectRef: string }>).some((p) => p.subjectRef === 'agent:x')).toBe(true);
  });

  const WS = '/v1/host/openwop-app/assistant/workspace-conversation';

  it('workspace conversation: 404 with no assistant; open-or-resume (dedup) once one exists (ADR 0043 Phase 6 / W-A)', async () => {
    const tenantId = `ws-${Date.now()}-${n++}`;
    const c = client();
    const r = await c.post('/v1/host/openwop-app/test/login', { email: `ws-${n}@acme.test`, tenantId, subject: `oidc:ws-${n}` });
    expect(r.status).toBe(201);

    // No workspace assistant yet → 404 (no orphan workspace chat created).
    expect((await c.post(WS)).status, 'no assistant').toBe(404);

    // Seed the tenant's assistant-capability agent, then open-or-resume.
    const assistant = await ensureAssistantAgent(tenantId);
    const agentId = assistant.agentRef.agentId;

    const first = await c.post(WS);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.type).toBe('workspace');
    expect((first.body.participants as Array<{ subjectRef: string }>).some((p) => p.subjectRef === `agent:${agentId}`), 'routes to the assistant agent').toBe(true);

    // Idempotent: a second open resolves to the SAME conversation (one per user).
    const again = await c.post(WS);
    expect(again.status, 'resumed not forked').toBe(200);
    expect(again.body.sessionId).toBe(first.body.sessionId);

    // Resume joins the owner's read marker into the header (no spurious-unread flash).
    expect((await c.post(`${S}/${first.body.sessionId}/read`)).status).toBe(204);
    const resumed = await c.post(WS);
    const ownerPart = (resumed.body.participants as Array<{ subjectRef: string; role: string; lastReadAt?: string }>).find((p) => p.role === 'owner');
    expect(ownerPart?.lastReadAt, 'read marker joined on resume').toBeTruthy();
  });

  it('persists + returns the conversation run id, and validates it (ADR 0067 continuity)', async () => {
    const { c } = await owner();
    const conv = await c.post(S, { title: 'Continuity', type: 'agent' });
    const id = conv.body.sessionId as string;

    // Before any run is recorded, the messages page omits it.
    const before = await c.get(`${S}/${id}/messages?limit=50`);
    expect(before.status).toBe(200);
    expect(before.body.conversationRunId).toBeUndefined();

    // Record it → 204; the messages page (paged AND full) now returns it.
    expect((await c.put(`${S}/${id}/conversation-run`, { conversationRunId: 'run-abc-123' })).status).toBe(204);
    expect((await c.get(`${S}/${id}/messages?limit=50`)).body.conversationRunId).toBe('run-abc-123');
    expect((await c.get(`${S}/${id}/messages`)).body.conversationRunId).toBe('run-abc-123');

    // Idempotent re-PUT; invalid id rejected; unknown session 404s.
    expect((await c.put(`${S}/${id}/conversation-run`, { conversationRunId: 'run-abc-123' })).status).toBe(204);
    expect((await c.put(`${S}/${id}/conversation-run`, { conversationRunId: 'has:colons' })).status).toBe(400);
    expect((await c.put(`${S}/does-not-exist/conversation-run`, { conversationRunId: 'run-x' })).status).toBe(404);
  });

  it('updates a message in place (ADR 0067 — run-backed workflow_run re-save)', async () => {
    const { c } = await owner();
    const conv = await c.post(S, { title: 'Updatable', type: 'agent' });
    const id = conv.body.sessionId as string;

    // Append the initial (running) snapshot, then UPDATE it with the suspended
    // state (more cards + the HITL interrupt) — the messageId is unique, so this
    // must be an update, not a second append.
    expect((await c.post(`${S}/${id}/messages`, { messageId: 'wf_1', role: 'workflow_run', content: JSON.stringify({ status: 'running' }) })).status).toBe(201);
    const upd = await c.put(`${S}/${id}/messages/wf_1`, { content: JSON.stringify({ status: 'suspended', activeInterrupts: [{ nodeId: 'gate_1' }] }) });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);

    // The thread reflects the UPDATED content (one message, not two), and the
    // count didn't double — an update is not a new message.
    const page = await c.get(`${S}/${id}/messages`);
    const wf = (page.body.messages as Array<{ messageId: string; content: string }>).filter((m) => m.messageId === 'wf_1');
    expect(wf.length).toBe(1);
    expect(wf[0]!.content).toContain('gate_1');

    // Updating a non-existent message 404s (the client then falls back to append).
    expect((await c.put(`${S}/${id}/messages/nope`, { content: '{}' })).status).toBe(404);
  });

  it('UPDATE is gated to the message author or the session owner (ADR 0102 Phase 2)', async () => {
    // Two humans in the SAME workspace tenant (a real shared-chat scenario).
    const tenantId = `ws-${Date.now()}-${n++}`;
    const ca = client();
    const ra = await ca.post('/v1/host/openwop-app/test/login', { email: `a-${n}@acme.test`, tenantId, subject: `oidc:a-${n}` });
    expect(ra.status).toBe(201);
    const cb = client();
    const rb = await cb.post('/v1/host/openwop-app/test/login', { email: `b-${n}@acme.test`, tenantId, subject: `oidc:b-${n}` });
    expect(rb.status).toBe(201);
    const bUserId = rb.body.user.userId as string;

    const conv = await ca.post(S, { title: 'Shared', type: 'agent' });
    expect(conv.status, JSON.stringify(conv.body)).toBe(201);
    const id = conv.body.sessionId as string;
    // Owner A authors m_a.
    expect((await ca.post(`${S}/${id}/messages`, { messageId: 'm_a', role: 'user', content: '{"role":"user"}' })).status).toBe(201);

    // Add member B as a participant (only the owner can), so B can see + write.
    expect((await ca.put(`${S}/${id}/participants`, { subjectRef: `user:${bUserId}` })).status).toBe(200);
    // B authors m_b.
    expect((await cb.post(`${S}/${id}/messages`, { messageId: 'm_b', role: 'user', content: '{"role":"user"}' })).status).toBe(201);

    // B CANNOT overwrite A's message (not author, not owner) → 403, no tamper.
    expect((await cb.put(`${S}/${id}/messages/m_a`, { content: '{"role":"user","content":"hax"}' })).status).toBe(403);
    // B CAN edit its OWN message (author) → 200.
    expect((await cb.put(`${S}/${id}/messages/m_b`, { content: '{"role":"user","content":"edit"}' })).status).toBe(200);
    // Owner A CAN moderate B's message (owner) → 200.
    expect((await ca.put(`${S}/${id}/messages/m_b`, { content: '{"role":"user","content":"mod"}' })).status).toBe(200);
  });

  it('returns the caller feedback across a session in one batch (ADR 0102 Phase 3)', async () => {
    const { c } = await owner();
    const conv = await c.post(S, { title: 'FB', type: 'agent' });
    const id = conv.body.sessionId as string;
    await c.post(`${S}/${id}/messages`, { messageId: 'm1', role: 'assistant', content: '{}' });
    await c.post(`${S}/${id}/messages`, { messageId: 'm2', role: 'assistant', content: '{}' });
    // Rate m1 👍 (m2 left unrated).
    expect((await c.post(`/v1/host/openwop-app/chat/messages/m1/feedback`, { conversationId: id, rating: 'up' })).status).toBe(200);

    const fb = await c.get(`${S}/${id}/feedback`);
    expect(fb.status, JSON.stringify(fb.body)).toBe(200);
    expect(fb.body.feedback.m1).toBe('up');
    expect(fb.body.feedback.m2).toBeUndefined(); // unrated → absent
  });
});
