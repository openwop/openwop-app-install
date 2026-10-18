/**
 * ADR 0136 Phase 3 — intent-ledger REST (route + RBAC harness).
 *
 * The approve route is the HUMAN GATE the model-drafted contract waits behind
 * (CLAUDE.md: model output reaches durable state only via validation and/or a human
 * gate), so the owner predicate is the load-bearing claim here. Two DIFFERENT
 * callers are needed to witness it: a same-tenant stranger is refused by VISIBILITY
 * (an IDOR-safe 404) before the owner check runs, so only a visible participant who
 * is not the owner reaches the owner branch (403). What turns it red
 * (sabotage-probed, /grade-tests w29): dropping either guard, approve not stamping
 * `approved`/`approvedBy`, the approved-edit 409, a 500 on a goal-less draft, or a
 * reckoning computed without a stamped run.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { addParticipant, userRef } from '../src/host/conversationStore.js';
import type { IntentLedger } from '../src/features/intent-ledger/types.js';

let BASE: string; let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

type Ledgered = { ledger: IntentLedger | null };
type Errored = { error: string; message?: string }; // the flat error envelope (H27)
function client() {
  let cookie = '';
  return async <B = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: B }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, body: (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as B };
  };
}
// ADR 0896 review H4 — each case founds its own tenant (the first login owns it) and a
// second person JOINS it as an editor member; in one shared tenant the later logins
// hold no membership, so the write floor would refuse them before the predicate a
// case is about (visibility, owner) ever ran.
let T = '';
let n = 0;
const u = (conv: string, suffix = ''): string => `/host/openwop-app/intent-ledger/conversations/${conv}${suffix}`;

// A chat session the caller owns (so getConversationMeta yields a visible, owned meta).
async function ownedConversation(c: ReturnType<typeof client>): Promise<string> {
  const r = await c<{ sessionId: string }>('POST', '/host/openwop-app/chat/sessions', { title: 'L' });
  return r.body.sessionId;
}
async function login(c: ReturnType<typeof client>, email: string): Promise<string> {
  T = `org:il-route-${Date.now()}-${n++}`;
  const r = await c<{ user: { userId: string } }>('POST', '/host/openwop-app/test/login', { email, tenantId: T });
  return r.body.user.userId;
}
/** `c` logs into the CURRENT tenant and `owner` adds them as an editor. */
async function join(owner: ReturnType<typeof client>, c: ReturnType<typeof client>, email: string): Promise<string> {
  const r = await c<{ user: { userId: string } }>('POST', '/host/openwop-app/test/login', { email, tenantId: T });
  const userId = r.body.user.userId;
  const add = await owner('POST', `/host/openwop-app/orgs/${encodeURIComponent(T)}/members`, { displayName: 'editor', subject: userId, roles: ['editor'] });
  expect(add.status).toBe(201);
  return userId;
}
/** ADR 0896 D1 — the version a decision names. */
const seen = (l: IntentLedger | null | undefined): { ledgerId?: string; revision?: number; digest?: string } => ({ ledgerId: l?.ledgerId, revision: l?.revision, digest: (l as { digest?: string } | null | undefined)?.digest });

describe('intent-ledger routes (ADR 0136, always-on)', () => {
  it('unknown conversation ⇒ 404 (always-on, IDOR-safe — no toggle gate)', async () => {
    const c = client();
    await login(c, 'il-off@test.dev');
    expect((await c('GET', u('any'))).status).toBe(404);
  });

  it('draft (user goal) → approve → get reflects approved; edit-after-approve 409', async () => {
    const c = client();
    const ownerId = await login(c, 'il-owner@test.dev');
    const conv = await ownedConversation(c);

    const draft = await c<Ledgered>('POST', u(conv, '/draft'), { goal: 'Draft Q3 report', allowed: ['kb.search'], successCriteria: ['report exists'] });
    expect(draft.status).toBe(200);
    expect(draft.body.ledger).toMatchObject({ status: 'draft', proposedBy: 'user', goal: 'Draft Q3 report' });

    const approve = await c<Ledgered>('POST', u(conv, '/approve'), seen(draft.body.ledger));
    expect(approve.status).toBe(200);
    expect(approve.body.ledger?.status).toBe('approved');
    expect(approve.body.ledger?.approvedBy).toBe(ownerId); // the human attribution CONS-16's eraser keys on

    expect((await c<Ledgered>('GET', u(conv))).body.ledger?.status).toBe('approved');

    // an approved ledger cannot be edited — and the edit did not land
    const put = await c<Errored>('PUT', u(conv), { goal: 'changed' });
    expect(put.status).toBe(409);
    expect(put.body.error).toBe('conflict');
    expect((await c<Ledgered>('GET', u(conv))).body.ledger?.goal).toBe('Draft Q3 report');
  });

  it('draft validation: a body with no goal ⇒ 4xx (manual draft requires a goal)', async () => {
    const c = client();
    await login(c, 'il-val@test.dev');
    const conv = await ownedConversation(c);
    // Model-authored drafting moved to the intent-ledger.draft-contract agent tool;
    // the REST /draft path is manual-only and fail-closed without a goal.
    const r = await c<Errored>('POST', u(conv, '/draft'), {});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation_error');
    expect((await c<Ledgered>('GET', u(conv))).body.ledger).toBeNull();
  });

  it('reckoning is null when the conversation has no stamped mission run', async () => {
    const c = client();
    await login(c, 'il-reck@test.dev');
    const conv = await ownedConversation(c);
    const d = await c<Ledgered>('POST', u(conv, '/draft'), { goal: 'g', allowed: ['kb.search'] });
    expect((await c('POST', u(conv, '/approve'), seen(d.body.ledger))).status).toBe(200);
    const r = await c<{ reckoning: unknown }>('GET', u(conv, '/reckoning'));
    expect(r.status).toBe(200);
    expect(r.body.reckoning).toBeNull(); // approved, but no run has executed/stamped yet
  });

  it('a same-tenant STRANGER gets the IDOR-safe 404 on draft and approve (not 403)', async () => {
    const owner = client();
    await login(owner, 'il-a@test.dev');
    const conv = await ownedConversation(owner);
    const mine = await owner<Ledgered>('POST', u(conv, '/draft'), { goal: 'mine' });
    const other = client();
    await join(owner, other, 'il-b@test.dev');
    expect((await other('POST', u(conv, '/draft'), { goal: 'sneaky' })).status).toBe(404);
    expect((await other('POST', u(conv, '/approve'), seen(mine.body.ledger))).status).toBe(404);
    const after = await owner<Ledgered>('GET', u(conv));
    expect(after.body.ledger).toMatchObject({ goal: 'mine', status: 'draft' });
  });

  it('a VISIBLE non-owner (participant) is refused 403 on draft AND approve, and nothing changes', async () => {
    const owner = client();
    await login(owner, 'il-p-owner@test.dev');
    const conv = await ownedConversation(owner);
    const own = await owner<Ledgered>('POST', u(conv, '/draft'), { goal: 'owner goal' });
    const member = client();
    const memberId = await join(owner, member, 'il-p-member@test.dev');
    // Same tenant, visible (participant), not the owner — the owner predicate decides.
    await addParticipant(T, conv, userRef(memberId));
    expect((await member<Ledgered>('GET', u(conv))).status).toBe(200); // visible: the 403s below are the OWNER branch

    const draft = await member<Errored>('POST', u(conv, '/draft'), { goal: 'sneaky' });
    expect(draft.status).toBe(403);
    expect(draft.body.error).toBe('forbidden');
    const approve = await member<Errored>('POST', u(conv, '/approve'), seen(own.body.ledger));
    expect(approve.status).toBe(403);
    expect(approve.body.error).toBe('forbidden');

    const after = await owner<Ledgered>('GET', u(conv));
    expect(after.body.ledger).toMatchObject({ goal: 'owner goal', status: 'draft' });
    expect(after.body.ledger?.approvedBy).toBeUndefined();
  });
});
